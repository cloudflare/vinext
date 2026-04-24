/**
 * vinext font plugins
 *
 * Exports two Vite plugins:
 *
 * `createGoogleFontsPlugin` — vinext:google-fonts
 *   1. Rewrites named `next/font/google` imports/exports to tiny virtual modules
 *      that export only the requested fonts plus any utility exports. This lets us
 *      delete the generated ~1,900-line runtime catalog while keeping ESM import
 *      semantics intact.
 *   2. During production builds, fetches Google Fonts CSS + font files, caches
 *      them locally under `.vinext/fonts/`, and injects `_selfHostedCSS` into
 *      statically analyzable font loader calls so fonts are served from the
 *      deployed origin rather than fonts.googleapis.com.
 *
 * `createLocalFontsPlugin` — vinext:local-fonts
 *   When a source file calls localFont({ src: "./font.woff2" }) or
 *   localFont({ src: [{ path: "./font.woff2" }] }), the relative paths
 *   won't resolve in the browser because the CSS is injected at runtime.
 *   This plugin rewrites those path strings into Vite asset import references
 *   so that both dev (/@fs/...) and prod (/assets/font-xxx.woff2) URLs are
 *   correct.
 */

import type { Plugin } from "vite";
import { parseAst } from "vite";
import path from "node:path";
import fs from "node:fs";
import MagicString from "magic-string";

// ── Virtual module IDs ────────────────────────────────────────────────────────

export const VIRTUAL_GOOGLE_FONTS = "virtual:vinext-google-fonts";
export const RESOLVED_VIRTUAL_GOOGLE_FONTS = "\0" + VIRTUAL_GOOGLE_FONTS;

// ── Constants ─────────────────────────────────────────────────────────────────

// IMPORTANT: keep this set in sync with the non-default exports from
// packages/vinext/src/shims/font-google.ts (and its re-export barrel).
const GOOGLE_FONT_UTILITY_EXPORTS = new Set([
  "buildGoogleFontsUrl",
  "getSSRFontLinks",
  "getSSRFontStyles",
  "getSSRFontPreloads",
  "createFontLoader",
]);

/**
 * Served URL prefix for self-hosted Google Font files.
 *
 * `fetchAndCacheFont()` downloads .woff2 files into `<root>/.vinext/fonts/`
 * and writes an `@font-face` CSS snippet whose `src: url(...)` references
 * the files by absolute filesystem path — convenient for disk, unusable at
 * runtime because browsers resolve relative to the origin. Before the CSS
 * is embedded in the bundle as `_selfHostedCSS`, the filesystem prefix is
 * rewritten to this URL prefix by `_rewriteCachedFontCssToServedUrls()`,
 * and the matching `writeBundle` hook in `createGoogleFontsPlugin` copies
 * the font files into `<clientOutDir>/<assetsDir>/_vinext_fonts/` so the
 * rewritten URL actually resolves against the origin at request time.
 *
 * The leading `_` keeps the namespace distinct from Vite's content-hashed
 * asset names (which are emitted flat into `<assetsDir>/`) and from any
 * user-provided public files.
 */
const VINEXT_FONT_URL_NAMESPACE = "_vinext_fonts";

/**
 * Rewrite absolute filesystem paths in cached Google Fonts CSS so the
 * `@font-face { src: url(...) }` references point at the served URL the
 * plugin's `writeBundle` hook copies the font files to.
 *
 * This is called once per transform, before the CSS string is embedded in
 * the bundle as `_selfHostedCSS`. Every downstream consumer reads from the
 * same rewritten CSS: the injected `<style data-vinext-fonts>` block, the
 * HTML body's `<link rel="preload">` tags (via `collectFontPreloadsFromCSS`
 * in `shims/font-google-base.ts`), and the HTTP `Link:` response header
 * (via `buildAppPageFontLinkHeader` in `server/app-page-execution.ts`).
 *
 * Without this rewrite, all three emit the dev-machine filesystem path
 * (e.g. `/home/user/project/.vinext/fonts/geist-<hash>/geist-<hash>.woff2`)
 * and any production request fetches `<origin>/home/user/...` → 404.
 *
 * `assetsDir` must match whatever Vite has resolved for
 * `build.assetsDir` on the client environment — otherwise the embedded
 * CSS URLs and the files emitted by the `writeBundle` hook would diverge
 * and a user who customizes `build.assetsDir` (e.g. to `"static"`) would
 * see 404s on every preload. The call site in `injectSelfHostedCss`
 * passes the resolved value through from plugin state. The default is
 * kept only so the exported helper can be driven directly from unit
 * tests without synthesizing a full plugin context.
 *
 * Uses split/join rather than regex because `cacheDir` is an absolute
 * filesystem path that may contain regex metacharacters on unusual
 * filesystems.
 */
export function _rewriteCachedFontCssToServedUrls(
  css: string,
  cacheDir: string,
  assetsDir: string = DEFAULT_ASSETS_DIR,
): string {
  if (!cacheDir || !css.includes(cacheDir)) return css;
  const prefix = assetsDir || DEFAULT_ASSETS_DIR;
  return css.split(cacheDir).join(`/${prefix}/${VINEXT_FONT_URL_NAMESPACE}`);
}

/**
 * Default Vite `build.assetsDir` — mirrors Vite's own default. Used as
 * the fallback for the `assetsDir` parameter of
 * `_rewriteCachedFontCssToServedUrls` so the exported helper can be unit
 * tested without synthesizing plugin state. Production call sites thread
 * the real `envConfig.build.assetsDir` resolved by Vite through so that
 * the embedded CSS URLs always match the directory the `writeBundle`
 * hook copies the font files into.
 */
const DEFAULT_ASSETS_DIR = "assets";

// ── Types ─────────────────────────────────────────────────────────────────────

type GoogleFontNamedSpecifier = {
  imported: string;
  local: string;
  isType: boolean;
  raw: string;
};

// ── Helpers shared with index.ts ──────────────────────────────────────────────

/**
 * Safely parse a static JS object literal string into a plain object.
 * Uses Vite's parseAst (Rollup/acorn) so no code is ever evaluated.
 * Returns null if the expression contains anything dynamic (function calls,
 * template literals, identifiers, computed properties, etc.).
 *
 * Supports: string literals, numeric literals, boolean literals,
 * arrays of the above, and nested object literals.
 */
export function parseStaticObjectLiteral(objectStr: string): Record<string, unknown> | null {
  let ast: ReturnType<typeof parseAst>;
  try {
    // Wrap in parens so the parser treats `{…}` as an expression, not a block
    ast = parseAst(`(${objectStr})`);
  } catch {
    return null;
  }

  // The AST should be: Program > ExpressionStatement > ObjectExpression
  const body = ast.body;
  if (body.length !== 1 || body[0].type !== "ExpressionStatement") return null;

  const expr = body[0].expression;
  if (expr.type !== "ObjectExpression") return null;

  const result = extractStaticValue(expr);
  return result === undefined ? null : (result as Record<string, unknown>);
}

/**
 * Recursively extract a static value from an ESTree AST node.
 * Returns undefined (not null) if the node contains any dynamic expression.
 *
 * Uses `any` for the node parameter because Rollup's internal ESTree types
 * (estree.Expression, estree.ObjectExpression, etc.) aren't re-exported by Vite,
 * and the recursive traversal touches many different node shapes.
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
function extractStaticValue(node: any): unknown {
  switch (node.type) {
    case "Literal":
      // String, number, boolean, null
      return node.value;

    case "UnaryExpression":
      // Handle negative numbers: -1, -3.14
      if (
        node.operator === "-" &&
        node.argument?.type === "Literal" &&
        typeof node.argument.value === "number"
      ) {
        return -node.argument.value;
      }
      return undefined;

    case "ArrayExpression": {
      const arr: unknown[] = [];
      for (const elem of node.elements) {
        if (!elem) return undefined; // sparse array
        const val = extractStaticValue(elem);
        if (val === undefined) return undefined;
        arr.push(val);
      }
      return arr;
    }

    case "ObjectExpression": {
      const obj: Record<string, unknown> = {};
      for (const prop of node.properties) {
        if (prop.type !== "Property") return undefined; // SpreadElement etc.
        if (prop.computed) return undefined; // [expr]: val

        // Key can be Identifier (unquoted) or Literal (quoted)
        let key: string;
        if (prop.key.type === "Identifier") {
          key = prop.key.name;
        } else if (prop.key.type === "Literal" && typeof prop.key.value === "string") {
          key = prop.key.value;
        } else {
          return undefined;
        }

        const val = extractStaticValue(prop.value);
        if (val === undefined) return undefined;
        obj[key] = val;
      }
      return obj;
    }

    default:
      // TemplateLiteral, CallExpression, Identifier, etc. — reject
      return undefined;
  }
}

// ── Virtual module encoding/decoding ─────────────────────────────────────────

function encodeGoogleFontsVirtualId(payload: {
  hasDefault: boolean;
  fonts: string[];
  utilities: string[];
}): string {
  const params = new URLSearchParams();
  if (payload.hasDefault) params.set("default", "1");
  if (payload.fonts.length > 0) params.set("fonts", payload.fonts.join(","));
  if (payload.utilities.length > 0) params.set("utilities", payload.utilities.join(","));
  return `${VIRTUAL_GOOGLE_FONTS}?${params.toString()}`;
}

function parseGoogleFontsVirtualId(id: string): {
  hasDefault: boolean;
  fonts: string[];
  utilities: string[];
} | null {
  const cleanId = id.startsWith("\0") ? id.slice(1) : id;
  if (!cleanId.startsWith(VIRTUAL_GOOGLE_FONTS)) return null;
  const queryIndex = cleanId.indexOf("?");
  const params = new URLSearchParams(queryIndex === -1 ? "" : cleanId.slice(queryIndex + 1));
  return {
    hasDefault: params.get("default") === "1",
    fonts:
      params
        .get("fonts")
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? [],
    utilities:
      params
        .get("utilities")
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? [],
  };
}

export function generateGoogleFontsVirtualModule(
  id: string,
  fontGoogleShimPath: string,
): string | null {
  const payload = parseGoogleFontsVirtualId(id);
  if (!payload) return null;

  const utilities = Array.from(new Set(payload.utilities));
  const fonts = Array.from(new Set(payload.fonts));
  const lines: string[] = [];

  lines.push(`import { createFontLoader } from ${JSON.stringify(fontGoogleShimPath)};`);

  const reExports: string[] = [];
  if (payload.hasDefault) reExports.push("default");
  reExports.push(...utilities);
  if (reExports.length > 0) {
    lines.push(`export { ${reExports.join(", ")} } from ${JSON.stringify(fontGoogleShimPath)};`);
  }

  for (const fontName of fonts) {
    const family = fontName.replace(/_/g, " ");
    lines.push(
      `export const ${fontName} = /*#__PURE__*/ createFontLoader(${JSON.stringify(family)});`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

// ── Import clause parsers ─────────────────────────────────────────────────────

function parseGoogleFontNamedSpecifiers(
  specifiersStr: string,
  forceType = false,
): GoogleFontNamedSpecifier[] {
  return specifiersStr
    .split(",")
    .map((spec) => spec.trim())
    .filter(Boolean)
    .map((raw) => {
      const isType = forceType || raw.startsWith("type ");
      const valueSpec = isType ? raw.replace(/^type\s+/, "") : raw;
      const asParts = valueSpec.split(/\s+as\s+/);
      const imported = asParts[0]?.trim() ?? "";
      const local = (asParts[1] || asParts[0] || "").trim();
      return { imported, local, isType, raw };
    })
    .filter((spec) => spec.imported.length > 0 && spec.local.length > 0);
}

function parseGoogleFontImportClause(clause: string): {
  defaultLocal: string | null;
  namespaceLocal: string | null;
  named: GoogleFontNamedSpecifier[];
} {
  const trimmed = clause.trim();

  if (trimmed.startsWith("type ")) {
    const braceStart = trimmed.indexOf("{");
    const braceEnd = trimmed.lastIndexOf("}");
    if (braceStart === -1 || braceEnd === -1) {
      return { defaultLocal: null, namespaceLocal: null, named: [] };
    }
    return {
      defaultLocal: null,
      namespaceLocal: null,
      named: parseGoogleFontNamedSpecifiers(trimmed.slice(braceStart + 1, braceEnd), true),
    };
  }

  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd !== -1) {
    const beforeNamed = trimmed.slice(0, braceStart).trim().replace(/,\s*$/, "").trim();
    return {
      defaultLocal: beforeNamed || null,
      namespaceLocal: null,
      named: parseGoogleFontNamedSpecifiers(trimmed.slice(braceStart + 1, braceEnd)),
    };
  }

  const commaIndex = trimmed.indexOf(",");
  if (commaIndex !== -1) {
    const defaultLocal = trimmed.slice(0, commaIndex).trim() || null;
    const rest = trimmed.slice(commaIndex + 1).trim();
    if (rest.startsWith("* as ")) {
      return {
        defaultLocal,
        namespaceLocal: rest.slice("* as ".length).trim() || null,
        named: [],
      };
    }
  }

  if (trimmed.startsWith("* as ")) {
    return {
      defaultLocal: null,
      namespaceLocal: trimmed.slice("* as ".length).trim() || null,
      named: [],
    };
  }

  return {
    defaultLocal: trimmed || null,
    namespaceLocal: null,
    named: [],
  };
}

function propertyNameToGoogleFontFamily(prop: string): string {
  return prop.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

// ── Font fetching and caching ─────────────────────────────────────────────────

/**
 * Fetch Google Fonts CSS, download .woff2 files, cache locally, and return
 * @font-face CSS with local file references.
 *
 * Cache dir structure: .vinext/fonts/<family-hash>/
 *   - style.css (the rewritten @font-face CSS)
 *   - *.woff2 (downloaded font files)
 */
async function fetchAndCacheFont(
  cssUrl: string,
  family: string,
  cacheDir: string,
): Promise<string> {
  // Use a hash of the URL for the cache key
  const { createHash } = await import("node:crypto");
  const urlHash = createHash("md5").update(cssUrl).digest("hex").slice(0, 12);
  const fontDir = path.join(cacheDir, `${family.toLowerCase().replace(/\s+/g, "-")}-${urlHash}`);

  // Check if already cached
  const cachedCSSPath = path.join(fontDir, "style.css");
  if (fs.existsSync(cachedCSSPath)) {
    return fs.readFileSync(cachedCSSPath, "utf-8");
  }

  // Fetch CSS from Google Fonts (woff2 user-agent gives woff2 URLs)
  const cssResponse = await fetch(cssUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });
  if (!cssResponse.ok) {
    throw new Error(`Failed to fetch Google Fonts CSS: ${cssResponse.status}`);
  }
  let css = await cssResponse.text();

  // Extract all font file URLs
  const urlRe = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g;
  const urls = new Map<string, string>(); // original URL -> local filename
  let urlMatch;
  while ((urlMatch = urlRe.exec(css)) !== null) {
    const fontUrl = urlMatch[1];
    if (!urls.has(fontUrl)) {
      const ext = fontUrl.includes(".woff2")
        ? ".woff2"
        : fontUrl.includes(".woff")
          ? ".woff"
          : ".ttf";
      const fileHash = createHash("md5").update(fontUrl).digest("hex").slice(0, 8);
      urls.set(fontUrl, `${family.toLowerCase().replace(/\s+/g, "-")}-${fileHash}${ext}`);
    }
  }

  // Download font files
  fs.mkdirSync(fontDir, { recursive: true });
  for (const [fontUrl, filename] of urls) {
    const filePath = path.join(fontDir, filename);
    if (!fs.existsSync(filePath)) {
      const fontResponse = await fetch(fontUrl);
      if (fontResponse.ok) {
        const buffer = Buffer.from(await fontResponse.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
      }
    }
    // Rewrite every remote Google Fonts CDN URL in the cached CSS to the
    // absolute filesystem path of the locally-downloaded font file. This
    // cache file is read back by the plugin and then run through
    // `_rewriteCachedFontCssToServedUrls()` at embed time, which replaces
    // the absolute `cacheDir` prefix with the served URL namespace under
    // `/<assetsDir>/_vinext_fonts/`. The filesystem path is only the
    // on-disk intermediate form — it must never reach the bundle, the
    // injected `<style data-vinext-fonts>` block, the HTML `<link
    // rel="preload">` tags, or the HTTP `Link:` response header. An
    // earlier version of this code claimed "Vite will resolve /@fs/ for
    // dev, or asset for build", which was never true: the CSS is
    // embedded as a JavaScript string literal and Vite's asset pipeline
    // does not scan string literals. Do not resurrect that assumption.
    css = css.split(fontUrl).join(filePath.replaceAll("\\", "/"));
  }

  // Cache the rewritten CSS
  fs.writeFileSync(cachedCSSPath, css);
  return css;
}

// ── Plugin factories ──────────────────────────────────────────────────────────

/**
 * Create the `vinext:google-fonts` Vite plugin.
 *
 * @param fontGoogleShimPath - Absolute path to the font-google shim module
 *   (either `.ts` in source or `.js` in built packages). Resolved by the caller
 *   so the plugin file has no dependency on `__dirname`.
 * @param shimsDir - Absolute path to the shims directory. Used to skip shim
 *   files from transform (they contain `next/font/google` references that must
 *   not be rewritten).
 */

/**
 * Scan `code` forward from `searchStart` for a `{...}` object literal that
 * may contain arbitrarily nested braces.  Returns `[objStart, objEnd]` where
 * `code[objStart] === '{'` and `code[objEnd - 1] === '}'`, or `null` if no
 * balanced object is found.
 *
 * String literals (single-quoted, double-quoted, and backtick template
 * literals including `${...}` interpolations) are fully skipped so that brace
 * characters inside string values do not affect the depth count.
 */
export function _findBalancedObject(code: string, searchStart: number): [number, number] | null {
  let i = searchStart;
  // Skip leading whitespace before the opening brace
  while (
    i < code.length &&
    (code[i] === " " || code[i] === "\t" || code[i] === "\n" || code[i] === "\r")
  ) {
    i++;
  }
  if (i >= code.length || code[i] !== "{") return null;
  const objStart = i;
  let depth = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      // Skip a single- or double-quoted string literal, respecting backslash escapes.
      const quote = ch;
      i++;
      while (i < code.length) {
        const sc = code[i];
        if (sc === "\\") {
          i += 2; // skip escaped character
        } else if (sc === quote) {
          i++;
          break;
        } else {
          i++;
        }
      }
    } else if (ch === "`") {
      // Skip a template literal, including ${...} interpolation blocks.
      // We need to track brace depth inside interpolations so that a `}`
      // that closes an interpolation isn't mistaken for closing the object.
      i++; // consume the opening backtick
      while (i < code.length) {
        const tc = code[i];
        if (tc === "\\") {
          i += 2; // skip escape sequence
        } else if (tc === "`") {
          i++; // end of template literal
          break;
        } else if (tc === "$" && code[i + 1] === "{") {
          // Enter a ${...} interpolation: scan forward tracking nested braces.
          i += 2; // consume '${'
          let exprDepth = 1;
          while (i < code.length && exprDepth > 0) {
            const ec = code[i];
            if (ec === "{") {
              exprDepth++;
              i++;
            } else if (ec === "}") {
              exprDepth--;
              i++;
            } else if (ec === '"' || ec === "'") {
              // Quoted string inside interpolation — skip it
              const q = ec;
              i++;
              while (i < code.length) {
                if (code[i] === "\\") {
                  i += 2;
                } else if (code[i] === q) {
                  i++;
                  break;
                } else {
                  i++;
                }
              }
            } else if (ec === "`") {
              // Nested template literal inside interpolation — skip it
              // (simple depth-1 skip; deeply nested templates are rare in font options)
              i++;
              while (i < code.length) {
                if (code[i] === "\\") {
                  i += 2;
                } else if (code[i] === "`") {
                  i++;
                  break;
                } else {
                  i++;
                }
              }
            } else {
              i++;
            }
          }
        } else {
          i++;
        }
      }
    } else if (ch === "{") {
      depth++;
      i++;
    } else if (ch === "}") {
      depth--;
      i++;
      if (depth === 0) return [objStart, i];
    } else {
      i++;
    }
  }
  return null; // unbalanced
}

/**
 * Given the index just past the closing `}` of an options object, skip
 * optional whitespace and return the index after the closing `)`.
 * Returns `null` if the next non-whitespace character is not `)`.
 */
export function _findCallEnd(code: string, objEnd: number): number | null {
  let i = objEnd;
  while (
    i < code.length &&
    (code[i] === " " || code[i] === "\t" || code[i] === "\n" || code[i] === "\r")
  ) {
    i++;
  }
  if (i >= code.length || code[i] !== ")") return null;
  return i + 1;
}

export function createGoogleFontsPlugin(fontGoogleShimPath: string, shimsDir: string): Plugin {
  // Vite does not bind `this` to the plugin object when calling hooks, so
  // plugin state must be held in closure variables rather than as properties.
  let isBuild = false;
  const fontCache = new Map<string, string>(); // url -> local @font-face CSS
  let cacheDir = "";

  return {
    name: "vinext:google-fonts",
    enforce: "pre",

    configResolved(config) {
      isBuild = config.command === "build";
      cacheDir = path.join(config.root, ".vinext", "fonts");
    },

    transform: {
      // Hook filter: only invoke JS when code contains 'next/font/google'.
      // This still eliminates nearly all Rust-to-JS calls since very few files
      // import from next/font/google.
      filter: {
        id: {
          include: /\.(tsx?|jsx?|mjs)$/,
        },
        code: "next/font/google",
      },
      async handler(code, id) {
        // Defensive guard — duplicates filter logic
        if (id.startsWith("\0")) return null;
        if (!id.match(/\.(tsx?|jsx?|mjs)$/)) return null;
        if (!code.includes("next/font/google")) return null;
        if (id.startsWith(shimsDir)) return null;

        // Read the resolved `build.assetsDir` from the current Vite
        // environment so it can be closed over by the inner
        // `injectSelfHostedCss` helper (a plain function declaration
        // where `this` is untyped). Captured at the top of the hook so
        // a single handler invocation always threads one consistent
        // value through every font-loader call site it rewrites.
        const transformAssetsDir = this.environment?.config?.build?.assetsDir ?? DEFAULT_ASSETS_DIR;

        const s = new MagicString(code);
        let hasChanges = false;
        let proxyImportCounter = 0;
        const overwrittenRanges: Array<[number, number]> = [];
        const fontLocals = new Map<string, string>();
        const proxyObjectLocals = new Set<string>();

        const importRe = /^[ \t]*import\s+([^;]+?)\s+from\s*(["'])next\/font\/google\2\s*;?/gm;
        let importMatch;
        while ((importMatch = importRe.exec(code)) !== null) {
          const [fullMatch, clause] = importMatch;
          const matchStart = importMatch.index;
          const matchEnd = matchStart + fullMatch.length;
          const parsed = parseGoogleFontImportClause(clause);
          const utilityImports = parsed.named.filter(
            (spec) => !spec.isType && GOOGLE_FONT_UTILITY_EXPORTS.has(spec.imported),
          );
          const fontImports = parsed.named.filter(
            (spec) => !spec.isType && !GOOGLE_FONT_UTILITY_EXPORTS.has(spec.imported),
          );

          if (parsed.defaultLocal) {
            proxyObjectLocals.add(parsed.defaultLocal);
          }
          for (const fontImport of fontImports) {
            fontLocals.set(fontImport.local, fontImport.imported);
          }

          if (fontImports.length > 0) {
            const virtualId = encodeGoogleFontsVirtualId({
              hasDefault: Boolean(parsed.defaultLocal),
              fonts: Array.from(new Set(fontImports.map((spec) => spec.imported))),
              utilities: Array.from(new Set(utilityImports.map((spec) => spec.imported))),
            });
            s.overwrite(
              matchStart,
              matchEnd,
              `import ${clause} from ${JSON.stringify(virtualId)};`,
            );
            overwrittenRanges.push([matchStart, matchEnd]);
            hasChanges = true;
            continue;
          }

          if (parsed.namespaceLocal) {
            const proxyImportName = `__vinext_google_fonts_proxy_${proxyImportCounter++}`;
            const replacementLines = [
              `import ${proxyImportName} from ${JSON.stringify(fontGoogleShimPath)};`,
            ];
            if (parsed.defaultLocal) {
              replacementLines.push(`var ${parsed.defaultLocal} = ${proxyImportName};`);
            }
            replacementLines.push(`var ${parsed.namespaceLocal} = ${proxyImportName};`);
            s.overwrite(matchStart, matchEnd, replacementLines.join("\n"));
            overwrittenRanges.push([matchStart, matchEnd]);
            proxyObjectLocals.add(parsed.namespaceLocal);
            hasChanges = true;
          }
        }

        const exportRe = /^[ \t]*export\s*\{([^}]+)\}\s*from\s*(["'])next\/font\/google\2\s*;?/gm;
        let exportMatch;
        while ((exportMatch = exportRe.exec(code)) !== null) {
          const [fullMatch, specifiers] = exportMatch;
          const matchStart = exportMatch.index;
          const matchEnd = matchStart + fullMatch.length;
          const namedExports = parseGoogleFontNamedSpecifiers(specifiers);
          const utilityExports = namedExports.filter(
            (spec) => !spec.isType && GOOGLE_FONT_UTILITY_EXPORTS.has(spec.imported),
          );
          const fontExports = namedExports.filter(
            (spec) => !spec.isType && !GOOGLE_FONT_UTILITY_EXPORTS.has(spec.imported),
          );
          if (fontExports.length === 0) continue;

          const virtualId = encodeGoogleFontsVirtualId({
            hasDefault: false,
            fonts: Array.from(new Set(fontExports.map((spec) => spec.imported))),
            utilities: Array.from(new Set(utilityExports.map((spec) => spec.imported))),
          });
          s.overwrite(
            matchStart,
            matchEnd,
            `export { ${specifiers.trim()} } from ${JSON.stringify(virtualId)};`,
          );
          overwrittenRanges.push([matchStart, matchEnd]);
          hasChanges = true;
        }

        async function injectSelfHostedCss(
          callStart: number,
          callEnd: number,
          optionsStr: string,
          family: string,
          calleeSource: string,
        ) {
          // Parse options safely via AST — no eval/new Function
          // oxlint-disable-next-line @typescript-eslint/no-explicit-any
          let options: Record<string, any> = {};
          try {
            const parsed = parseStaticObjectLiteral(optionsStr);
            if (!parsed) return; // Contains dynamic expressions, skip
            options = parsed as Record<string, unknown>;
          } catch {
            return; // Can't parse options statically, skip
          }

          // Build the Google Fonts CSS URL
          const weights = options.weight
            ? Array.isArray(options.weight)
              ? options.weight
              : [options.weight]
            : [];
          const styles = options.style
            ? Array.isArray(options.style)
              ? options.style
              : [options.style]
            : [];
          const display = options.display ?? "swap";

          let spec = family.replace(/\s+/g, "+");
          if (weights.length > 0) {
            const hasItalic = styles.includes("italic");
            if (hasItalic) {
              const pairs: string[] = [];
              for (const w of weights) {
                pairs.push(`0,${w}`);
                pairs.push(`1,${w}`);
              }
              spec += `:ital,wght@${pairs.join(";")}`;
            } else {
              spec += `:wght@${weights.join(";")}`;
            }
          } else if (styles.length === 0) {
            // Request full variable weight range when no weight specified.
            // Without this, Google Fonts returns only weight 400.
            spec += `:wght@100..900`;
          }
          const params = new URLSearchParams();
          params.set("family", spec);
          params.set("display", display);
          const cssUrl = `https://fonts.googleapis.com/css2?${params.toString()}`;

          // Check cache
          let localCSS = fontCache.get(cssUrl);
          if (!localCSS) {
            try {
              localCSS = await fetchAndCacheFont(cssUrl, family, cacheDir);
              fontCache.set(cssUrl, localCSS);
            } catch {
              // Fetch failed (offline?) — fall back to CDN mode
              return;
            }
          }

          // Rewrite absolute `.vinext/fonts/` filesystem paths in the cached
          // CSS to served URLs under `/<assetsDir>/_vinext_fonts/` so the
          // embedded `_selfHostedCSS` string has origin-relative URLs that
          // the browser can actually resolve. The plugin's writeBundle hook
          // copies the referenced font files to the matching location under
          // the client output directory so the URLs serve 200s, not 404s.
          //
          // `transformAssetsDir` is captured at the top of the outer
          // transform handler (where `this.environment` is bound by
          // Rollup to the plugin context) and closed over here. This
          // keeps the embedded URL prefix in lockstep with the directory
          // the writeBundle hook copies files into, so a user who
          // customizes `build.assetsDir` (e.g. to `"static"`) sees both
          // the CSS and the copy target move together — otherwise the
          // rewritten URLs would 404 in production.
          const servedCSS = _rewriteCachedFontCssToServedUrls(
            localCSS,
            cacheDir,
            transformAssetsDir,
          );

          // Inject _selfHostedCSS into the options object
          const escapedCSS = JSON.stringify(servedCSS);
          const closingBrace = optionsStr.lastIndexOf("}");
          const beforeBrace = optionsStr.slice(0, closingBrace).trim();
          // Determine the separator to insert before the new property:
          //   - Empty string if the object is empty ({ is the last non-whitespace char)
          //   - Empty string if there's already a trailing comma (avoid double comma)
          //   - ", " otherwise (before the new property)
          const separator = beforeBrace.endsWith("{") || beforeBrace.endsWith(",") ? "" : ", ";
          const optionsWithCSS =
            optionsStr.slice(0, closingBrace) +
            separator +
            `_selfHostedCSS: ${escapedCSS}` +
            optionsStr.slice(closingBrace);

          const replacement = `${calleeSource}(${optionsWithCSS})`;
          s.overwrite(callStart, callEnd, replacement);
          overwrittenRanges.push([callStart, callEnd]);
          hasChanges = true;
        }

        if (isBuild) {
          // Match: Identifier( — where the argument starts with {
          // The regex intentionally does NOT capture the options object; we use
          // _findBalancedObject() to handle nested braces correctly.
          const namedCallRe = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*(?=\{)/g;
          let namedCallMatch;
          while ((namedCallMatch = namedCallRe.exec(code)) !== null) {
            const [fullMatch, localName] = namedCallMatch;
            const importedName = fontLocals.get(localName);
            if (!importedName) continue;

            const callStart = namedCallMatch.index;
            // The regex consumed up to (but not including) the '{' due to the
            // lookahead — find the balanced object starting at the lookahead pos.
            const openParenEnd = callStart + fullMatch.length;
            const objRange = _findBalancedObject(code, openParenEnd);
            if (!objRange) continue;
            const optionsStr = code.slice(objRange[0], objRange[1]);
            const callEnd = _findCallEnd(code, objRange[1]);
            if (callEnd === null) continue;

            if (overwrittenRanges.some(([start, end]) => callStart < end && callEnd > start)) {
              continue;
            }

            await injectSelfHostedCss(
              callStart,
              callEnd,
              optionsStr,
              importedName.replace(/_/g, " "),
              localName,
            );
          }

          // Match: Identifier.Identifier( — where the argument starts with {
          const memberCallRe =
            /\b([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*(?=\{)/g;
          let memberCallMatch;
          while ((memberCallMatch = memberCallRe.exec(code)) !== null) {
            const [fullMatch, objectName, propName] = memberCallMatch;
            if (!proxyObjectLocals.has(objectName)) continue;

            const callStart = memberCallMatch.index;
            const openParenEnd = callStart + fullMatch.length;
            const objRange = _findBalancedObject(code, openParenEnd);
            if (!objRange) continue;
            const optionsStr = code.slice(objRange[0], objRange[1]);
            const callEnd = _findCallEnd(code, objRange[1]);
            if (callEnd === null) continue;

            if (overwrittenRanges.some(([start, end]) => callStart < end && callEnd > start)) {
              continue;
            }

            await injectSelfHostedCss(
              callStart,
              callEnd,
              optionsStr,
              propertyNameToGoogleFontFamily(propName),
              `${objectName}.${propName}`,
            );
          }
        }

        if (!hasChanges) return null;
        return {
          code: s.toString(),
          map: s.generateMap({ hires: "boundary" }),
        };
      },
    },

    // Copy cached Google Font files into the client output so the served
    // URLs produced by `_rewriteCachedFontCssToServedUrls` resolve against
    // the origin. Runs once, at the end of the client environment's build.
    //
    // `fetchAndCacheFont` downloads files into `<root>/.vinext/fonts/` and
    // leaves them there — nothing else copies them. Without this hook, the
    // rewritten `/assets/_vinext_fonts/...` URLs would 404 in production.
    writeBundle: {
      sequential: true,
      order: "post" as const,
      handler(outputOptions: { dir?: string }) {
        // Only copy on the client build — the server/SSR environments
        // don't serve static assets.
        //
        // Optional chaining on `this.environment` matches the convention
        // used by the other build-time plugins in `src/index.ts` (the
        // `vinext:precompress` and `vinext:cloudflare-build` plugins both
        // guard on `this.environment?.name !== "client"`). Vite 6+ always
        // populates `this.environment` inside writeBundle, but keeping
        // the guard makes the hook safely no-op if the code is ever
        // executed in a context where Rollup invokes it without a bound
        // environment (e.g. a thin unit test harness that invokes the
        // hook directly). Concretely: under normal Vite builds this
        // always resolves, the early-return is never taken.
        if (this.environment?.name !== "client") return;
        if (!cacheDir || !fs.existsSync(cacheDir)) return;
        const outDir = outputOptions.dir;
        if (!outDir) return;

        // Read the resolved `build.assetsDir` from the same environment
        // that the transform-time rewrite read it from, so the embedded
        // URL prefix and the physical copy location cannot diverge even
        // if a user customizes `build.assetsDir`.
        const assetsDir = this.environment.config?.build?.assetsDir ?? DEFAULT_ASSETS_DIR;
        const targetRoot = path.join(outDir, assetsDir, VINEXT_FONT_URL_NAMESPACE);

        // Recursive copy of every cached font file. Skip the companion
        // `style.css` artifact — that is only read by the build plugin
        // itself, never served at runtime.
        const stack: string[] = [cacheDir];
        while (stack.length > 0) {
          const dir = stack.pop();
          if (!dir) continue;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const src = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              stack.push(src);
              continue;
            }
            if (!/\.(woff2?|ttf|otf|eot)$/i.test(entry.name)) continue;
            const relative = path.relative(cacheDir, src);
            const dest = path.join(targetRoot, relative);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
          }
        }
      },
    },
  } satisfies Plugin;
}

/**
 * Create the `vinext:local-fonts` Vite plugin.
 *
 * Rewrites relative font file paths in `next/font/local` calls into Vite
 * asset import references so that both dev (/@fs/...) and prod
 * (/assets/font-xxx.woff2) URLs resolve correctly.
 */
export function createLocalFontsPlugin(): Plugin {
  return {
    name: "vinext:local-fonts",
    enforce: "pre",

    transform: {
      filter: {
        id: {
          include: /\.(tsx?|jsx?|mjs)$/,
          exclude: /node_modules/,
        },
        code: "next/font/local",
      },
      handler(code, id) {
        // Defensive guards — duplicate filter logic
        if (id.includes("node_modules")) return null;
        if (id.startsWith("\0")) return null;
        if (!id.match(/\.(tsx?|jsx?|mjs)$/)) return null;
        if (!code.includes("next/font/local")) return null;
        // Skip vinext's own font-local shim — it contains example paths
        // in comments that would be incorrectly rewritten.
        if (id.includes("font-local")) return null;

        // Verify there's actually an import from next/font/local
        const importRe = /import\s+\w+\s+from\s*['"]next\/font\/local['"]/;
        if (!importRe.test(code)) return null;

        const s = new MagicString(code);
        let hasChanges = false;
        let fontImportCounter = 0;
        const imports: string[] = [];

        // Match font file paths in `path: "..."` or `src: "..."` properties.
        // Captures: (1) property+colon prefix, (2) quote char, (3) the path.
        const fontPathRe = /((?:path|src)\s*:\s*)(['"])([^'"]+\.(?:woff2?|ttf|otf|eot))\2/g;

        let match;
        while ((match = fontPathRe.exec(code)) !== null) {
          const [fullMatch, prefix, _quote, fontPath] = match;
          const varName = `__vinext_local_font_${fontImportCounter++}`;

          // Add an import for this font file — Vite resolves it as a static
          // asset and returns the correct URL for both dev and prod.
          imports.push(`import ${varName} from ${JSON.stringify(fontPath)};`);

          // Replace: path: "./font.woff2" -> path: __vinext_local_font_0
          const matchStart = match.index;
          const matchEnd = matchStart + fullMatch.length;
          s.overwrite(matchStart, matchEnd, `${prefix}${varName}`);
          hasChanges = true;
        }

        if (!hasChanges) return null;

        // Prepend the asset imports at the top of the file
        s.prepend(imports.join("\n") + "\n");

        return {
          code: s.toString(),
          map: s.generateMap({ hires: "boundary" }),
        };
      },
    },
  } satisfies Plugin;
}
