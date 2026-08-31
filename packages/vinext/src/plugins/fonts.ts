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
 *      them locally under `.vinext/fonts/`, and injects `_vinext.font` into
 *      statically analyzable font loader calls so fonts are served from the
 *      deployed origin rather than fonts.googleapis.com. Static calls also
 *      receive adjusted fallback CSS when Next.js-compatible fallback metrics
 *      exist for the selected Google Font.
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
import path, { toSlash } from "pathslash";
import fs from "node:fs";
import { lastSignificantChar } from "../utils/has-trailing-comma.js";
import {
  type AstRange,
  type AstRecord,
  forEachAstChild,
  getAstName,
  getBindingsInScope,
  hasRange,
  isAstRecord,
  nodeArray,
} from "./ast-utils.js";
import MagicString from "magic-string";
import { magicStringTransformResult } from "./transform-result.js";
import {
  buildFallbackFontFace,
  getFallbackFontOverrideMetrics,
} from "../build/google-fonts/fallback-metrics.js";
import { validateGoogleFontOptions } from "../build/google-fonts/validate.js";
import { getFontAxes } from "../build/google-fonts/get-axes.js";
import { buildGoogleFontsUrl } from "../build/google-fonts/build-url.js";
import { findFontFilesInCss } from "../build/google-fonts/find-font-files-in-css.js";
import { CONTENT_TYPES } from "../server/static-file-cache.js";
import { ASSET_PREFIX_URL_DIR } from "../utils/asset-prefix.js";

/**
 * Thrown when Google Fonts returns a non-2xx response. Distinct from a raw
 * `fetch` rejection (network error, DNS failure, AbortError) so the call
 * site can decide whether to surface as a build error or fall through to
 * the runtime CDN path.
 */
class GoogleFontsHttpError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(`Google Fonts returned HTTP ${status} for ${url}`);
    this.name = "GoogleFontsHttpError";
  }
}

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
 * is embedded in the bundle as `_vinext.font.selfHostedCSS`, the filesystem
 * prefix is rewritten to this URL prefix by `_rewriteCachedFontCssToServedUrls()`,
 * and the matching `writeBundle` hook in `createGoogleFontsPlugin` copies
 * the font files into `<clientOutDir>/<assetsDir>/_vinext_fonts/` so the
 * rewritten URL actually resolves against the origin at request time.
 *
 * The leading `_` keeps the namespace distinct from Vite's content-hashed
 * asset names (which are emitted flat into `<assetsDir>/`) and from any
 * user-provided public files.
 */
const VINEXT_FONT_URL_NAMESPACE = "_vinext_fonts";
const MAX_GOOGLE_FONTS_ERROR_BODY_LENGTH = 500;

function formatGoogleFontsErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "(empty response body)";
  if (trimmed.length <= MAX_GOOGLE_FONTS_ERROR_BODY_LENGTH) return trimmed;
  const omitted = trimmed.length - MAX_GOOGLE_FONTS_ERROR_BODY_LENGTH;
  return `${trimmed.slice(0, MAX_GOOGLE_FONTS_ERROR_BODY_LENGTH)}\n... (truncated ${omitted} characters)`;
}

/**
 * Rewrite absolute filesystem paths in cached Google Fonts CSS so the
 * `@font-face { src: url(...) }` references point at the served URL the
 * plugin's `writeBundle` hook copies the font files to.
 *
 * This is called once per transform, before the CSS string is embedded in
 * the bundle as `_vinext.font.selfHostedCSS`. Every downstream consumer reads
 * from the same rewritten CSS: the injected `<style data-vinext-fonts>` block, the
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
  const normalizedCacheDir = toSlash(cacheDir);
  if (!normalizedCacheDir || !css.includes(normalizedCacheDir)) return css;
  const prefix = assetsDir || DEFAULT_ASSETS_DIR;
  return css.split(normalizedCacheDir).join(`/${prefix}/${VINEXT_FONT_URL_NAMESPACE}`);
}

/**
 * Default `build.assetsDir` — matches vinext's resolved default in
 * `resolveAssetsDir("")` (Next.js's canonical convention). Used as the
 * fallback for the `assetsDir` parameter of
 * `_rewriteCachedFontCssToServedUrls` so the exported helper can be unit
 * tested without synthesizing plugin state. Production call sites thread
 * the real `envConfig.build.assetsDir` resolved by Vite through so that
 * the embedded CSS URLs always match the directory the `writeBundle`
 * hook copies the font files into.
 */
const DEFAULT_ASSETS_DIR = ASSET_PREFIX_URL_DIR;

// ── Types ─────────────────────────────────────────────────────────────────────

type GoogleFontNamedSpecifier = {
  imported: string;
  local: string;
  isType: boolean;
};

type GoogleFontImportInfo = {
  start: number;
  end: number;
  source: AstRange;
  defaultLocal: string | null;
  namespaceLocal: string | null;
  named: GoogleFontNamedSpecifier[];
};

type GoogleFontExportInfo = {
  start: number;
  end: number;
  source: AstRange;
  named: GoogleFontNamedSpecifier[];
};

type LocalFontCallInfo = {
  call: AstRange;
  options: AstRange;
  bindingName: string | null;
};

const FONT_FILE_EXTENSION_RE = /\.(?:woff2?|ttf|otf|eot)$/i;

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

function propertyNameToGoogleFontFamily(prop: string): string {
  return prop.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function parseTransformAst(code: string, id: string): ReturnType<typeof parseAst> | null {
  const lang = id.endsWith(".ts") ? "ts" : "tsx";
  try {
    return parseAst(code, { lang });
  } catch {
    return null;
  }
}

function getStringProperty(node: AstRecord, key: string): string | null {
  const value = node[key];
  return typeof value === "string" ? value : null;
}

function getSourceValue(node: AstRecord): string | null {
  const source = node.source;
  if (!isAstRecord(source)) return null;
  const value = source.value;
  return typeof value === "string" ? value : null;
}

function isTypeOnlyDeclaration(node: AstRecord): boolean {
  return node.importKind === "type" || node.exportKind === "type";
}

function isTypeOnlySpecifier(node: AstRecord, parent: AstRecord): boolean {
  return isTypeOnlyDeclaration(parent) || node.importKind === "type" || node.exportKind === "type";
}

function collectGoogleFontImports(ast: ReturnType<typeof parseAst>): GoogleFontImportInfo[] {
  const imports: GoogleFontImportInfo[] = [];
  for (const item of ast.body) {
    if (item.type !== "ImportDeclaration") continue;
    const node = item as unknown as AstRecord;
    if (getSourceValue(node) !== "next/font/google") continue;
    if (!hasRange(node)) continue;
    const sourceNode = node.source as AstRecord | null;
    if (!sourceNode || !hasRange(sourceNode)) continue;

    let defaultLocal: string | null = null;
    let namespaceLocal: string | null = null;
    const named: GoogleFontNamedSpecifier[] = [];
    const declarationIsType = isTypeOnlyDeclaration(node);

    for (const specifierValue of nodeArray(node.specifiers)) {
      if (!isAstRecord(specifierValue) || !hasRange(specifierValue)) continue;
      const spec = specifierValue;
      if (spec.type === "ImportDefaultSpecifier") {
        if (!declarationIsType) defaultLocal = getAstName(spec.local);
        continue;
      }
      if (spec.type === "ImportNamespaceSpecifier") {
        if (!declarationIsType) namespaceLocal = getAstName(spec.local);
        continue;
      }
      if (spec.type !== "ImportSpecifier") continue;
      const imported = getAstName(spec.imported) ?? getAstName(spec.local);
      const local = getAstName(spec.local) ?? imported;
      if (!imported || !local) continue;
      named.push({
        imported,
        local,
        isType: isTypeOnlySpecifier(spec, node),
      });
    }

    imports.push({
      start: node.start,
      end: node.end,
      source: sourceNode,
      defaultLocal,
      namespaceLocal,
      named,
    });
  }
  return imports;
}

function collectGoogleFontExports(ast: ReturnType<typeof parseAst>): GoogleFontExportInfo[] {
  const exports: GoogleFontExportInfo[] = [];
  for (const item of ast.body) {
    if (item.type !== "ExportNamedDeclaration") continue;
    const node = item as unknown as AstRecord;
    if (getSourceValue(node) !== "next/font/google") continue;
    if (!hasRange(node)) continue;
    const sourceNode = node.source as AstRecord | null;
    if (!sourceNode || !hasRange(sourceNode)) continue;

    const named: GoogleFontNamedSpecifier[] = [];
    for (const specifierValue of nodeArray(node.specifiers)) {
      if (!isAstRecord(specifierValue) || !hasRange(specifierValue)) continue;
      if (specifierValue.type !== "ExportSpecifier") continue;
      const imported = getAstName(specifierValue.local);
      const local = getAstName(specifierValue.exported) ?? imported;
      if (!imported || !local) continue;
      named.push({
        imported,
        local,
        isType: isTypeOnlySpecifier(specifierValue, node),
      });
    }

    exports.push({
      start: node.start,
      end: node.end,
      source: sourceNode,
      named,
    });
  }
  return exports;
}

function isIdentifierReference(node: unknown, name: string): boolean {
  return isAstRecord(node) && node.type === "Identifier" && node.name === name;
}

// Node types that open a new scope for shadowing purposes during the font-call
// traversal. getBindingsInScope is merged into the shadow set when descending
// into these.
function isScopeNode(node: AstRecord): boolean {
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "BlockStatement":
    case "CatchClause":
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "SwitchStatement":
      return true;
    default:
      return false;
  }
}

function collectLocalFontPathLiterals(options: AstRange): Array<{ node: AstRange; path: string }> {
  const paths: Array<{ node: AstRange; path: string }> = [];

  for (const prop of nodeArray(options.properties)) {
    if (!isAstRecord(prop) || prop.type !== "Property" || prop.computed) continue;
    if (getAstName(prop.key) !== "src") continue;

    const value = prop.value;
    if (!isAstRecord(value)) continue;

    if (value.type === "Literal" && typeof value.value === "string" && hasRange(value)) {
      if (FONT_FILE_EXTENSION_RE.test(value.value)) {
        paths.push({ node: value, path: value.value });
      }
    } else {
      const objects =
        value.type === "ObjectExpression"
          ? [value]
          : value.type === "ArrayExpression"
            ? nodeArray(value.elements).filter(isAstRecord)
            : [];
      for (const obj of objects) {
        if (obj.type !== "ObjectExpression") continue;
        for (const subProp of nodeArray(obj.properties)) {
          if (!isAstRecord(subProp) || subProp.type !== "Property" || subProp.computed) continue;
          if (getAstName(subProp.key) !== "path") continue;
          const pathVal = subProp.value;
          if (
            isAstRecord(pathVal) &&
            hasRange(pathVal) &&
            pathVal.type === "Literal" &&
            typeof pathVal.value === "string" &&
            FONT_FILE_EXTENSION_RE.test(pathVal.value)
          ) {
            paths.push({ node: pathVal, path: pathVal.value });
          }
        }
      }
    }
  }

  return paths;
}

function objectHasVinextProperty(options: AstRange): boolean {
  for (const property of nodeArray(options.properties)) {
    if (!isAstRecord(property) || property.type !== "Property" || property.computed) continue;
    if (getAstName(property.key) === "_vinext") return true;
  }
  return false;
}

function firstObjectArgument(node: AstRecord): AstRange | null {
  const args = nodeArray(node.arguments);
  const firstArg = args[0];
  if (!isAstRecord(firstArg) || firstArg.type !== "ObjectExpression" || !hasRange(firstArg)) {
    return null;
  }
  return firstArg;
}

function getLocalFontDefaultImport(ast: ReturnType<typeof parseAst>): string | null {
  for (const item of ast.body) {
    if (item.type !== "ImportDeclaration") continue;
    const node = item as unknown as AstRecord;
    if (getSourceValue(node) !== "next/font/local") continue;
    if (isTypeOnlyDeclaration(node)) continue;
    for (const specifier of nodeArray(node.specifiers)) {
      if (!isAstRecord(specifier) || specifier.type !== "ImportDefaultSpecifier") continue;
      return getAstName(specifier.local);
    }
  }
  return null;
}

function localFontCallFromInitializer(
  init: unknown,
  localFontIdentifier: string,
): { call: AstRange; options: AstRange } | null {
  if (!isAstRecord(init) || init.type !== "CallExpression" || !hasRange(init)) return null;
  if (!isIdentifierReference(init.callee, localFontIdentifier)) return null;
  const options = firstObjectArgument(init);
  if (!options) return null;
  return { call: init, options };
}

function collectLocalFontCalls(
  ast: ReturnType<typeof parseAst>,
  localFontIdentifier: string,
): LocalFontCallInfo[] {
  const calls: LocalFontCallInfo[] = [];

  function visit(node: AstRecord, shadowed: Set<string>): void {
    const nextShadowed = isScopeNode(node)
      ? new Set([...shadowed, ...getBindingsInScope(node)])
      : shadowed;

    if (node.type === "VariableDeclarator") {
      if (!nextShadowed.has(localFontIdentifier)) {
        const localCall = localFontCallFromInitializer(node.init, localFontIdentifier);
        if (localCall) {
          calls.push({
            ...localCall,
            bindingName: getAstName(node.id),
          });
        }
      }
      visit(node.id as AstRecord, nextShadowed);
      if (node.init) visit(node.init as AstRecord, nextShadowed);
      return;
    }

    if (
      node.type === "CallExpression" &&
      hasRange(node) &&
      !nextShadowed.has(localFontIdentifier) &&
      isIdentifierReference(node.callee, localFontIdentifier)
    ) {
      const options = firstObjectArgument(node);
      if (options) {
        calls.push({ call: node, options, bindingName: null });
      }
    }

    forEachAstChild(node, (child) => visit(child, nextShadowed));
  }

  const initialShadowed = getBindingsInScope(ast as unknown as AstRecord);
  for (const item of ast.body) {
    visit(item as AstRecord, initialShadowed);
  }
  return calls;
}

function collectGoogleFontCalls(
  ast: ReturnType<typeof parseAst>,
  fontLocals: Map<string, string>,
  proxyObjectLocals: Set<string>,
): Array<{ call: AstRange; options: AstRange; family: string; calleeSource: string }> {
  const calls: Array<{ call: AstRange; options: AstRange; family: string; calleeSource: string }> =
    [];

  function visit(node: AstRecord, shadowed: Set<string>): void {
    const nextShadowed = isScopeNode(node)
      ? new Set([...shadowed, ...getBindingsInScope(node)])
      : shadowed;

    if (node.type === "CallExpression" && hasRange(node)) {
      const options = firstObjectArgument(node);
      const callee = isAstRecord(node.callee) && hasRange(node.callee) ? node.callee : null;
      if (options && callee?.type === "Identifier") {
        const localName = getStringProperty(callee, "name");
        const importedName = localName ? fontLocals.get(localName) : undefined;
        if (localName && importedName && !nextShadowed.has(localName)) {
          calls.push({
            call: node,
            options,
            family: importedName.replace(/_/g, " "),
            calleeSource: localName,
          });
          return;
        }
      }

      if (options && callee?.type === "MemberExpression" && !callee.computed) {
        const objectName = getAstName(callee.object);
        const propName = getAstName(callee.property);
        if (
          objectName &&
          propName &&
          proxyObjectLocals.has(objectName) &&
          !nextShadowed.has(objectName)
        ) {
          calls.push({
            call: node,
            options,
            family: propertyNameToGoogleFontFamily(propName),
            calleeSource: `${objectName}.${propName}`,
          });
          return;
        }
      }
    }

    forEachAstChild(node, (child) => visit(child, nextShadowed));
  }

  const initialShadowed = getBindingsInScope(ast as unknown as AstRecord);
  for (const item of ast.body) {
    visit(item as AstRecord, initialShadowed);
  }
  return calls;
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
    // Include the response body when Google rejected the request so the
    // caller can see why (the body usually contains a one-line CSS comment
    // identifying the bad axis or family).
    const body = await cssResponse.text().catch(() => "");
    throw new GoogleFontsHttpError(cssUrl, cssResponse.status, body);
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
    css = css.split(fontUrl).join(filePath);
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
  const fontCache = new Map<string, string>(); // url -> local @font-face CSS
  let cacheDir = "";

  return {
    name: "vinext:google-fonts",
    enforce: "pre",

    configResolved(config) {
      cacheDir = path.join(toSlash(config.root), ".vinext", "fonts");
    },

    // Dev-mode equivalent of the production `writeBundle` copy step. In dev
    // there is no client output directory to copy files into, so the cached
    // .vinext/fonts/ tree is served directly under the same URL prefix that
    // `_rewriteCachedFontCssToServedUrls()` embeds into the @font-face CSS
    // (`/<assetsDir>/_vinext_fonts/...`). Without this hook the rewritten
    // URLs 404 — and once `_vinext.font.selfHostedCSS` is injected, the shim no longer
    // emits the fonts.googleapis.com `<link>`, so a 404 here means no
    // glyphs render at all (no CDN fallback path).
    configureServer(server) {
      if (!cacheDir) return;
      const assetsDir =
        server.environments?.client?.config?.build?.assetsDir ??
        server.config?.build?.assetsDir ??
        DEFAULT_ASSETS_DIR;
      const urlPrefix = `/${assetsDir}/${VINEXT_FONT_URL_NAMESPACE}/`;
      server.middlewares.use((req, res, next) => {
        const url = req.url;
        if (!url || !url.startsWith(urlPrefix)) return next();
        const rawPath = url.slice(urlPrefix.length).split("?")[0];
        let decoded: string;
        try {
          decoded = decodeURIComponent(rawPath);
        } catch {
          return next();
        }
        const filePath = path.resolve(cacheDir, decoded);
        // Path traversal guard — `decoded` came from the URL, so refuse
        // anything that escapes the cache root (e.g. `..%2F..%2Fetc/passwd`).
        if (filePath !== cacheDir && !filePath.startsWith(cacheDir + path.sep)) {
          return next();
        }
        fs.stat(filePath, (err, stat) => {
          if (err || !stat.isFile()) return next();
          const ext = path.extname(filePath).toLowerCase();
          // CONTENT_TYPES is the same map prod-server uses, so fonts get
          // identical MIME types in dev and prod. fetchAndCacheFont only
          // ever writes .woff2/.woff/.ttf, all of which are covered.
          res.setHeader("Content-Type", CONTENT_TYPES[ext] ?? "application/octet-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Access-Control-Allow-Origin", "*");
          fs.createReadStream(filePath).pipe(res);
        });
      });
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

        const ast = parseTransformAst(code, id);
        if (!ast) return null;

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

        for (const parsed of collectGoogleFontImports(ast)) {
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
            s.overwrite(parsed.source.start, parsed.source.end, JSON.stringify(virtualId));
            overwrittenRanges.push([parsed.start, parsed.end]);
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
            s.overwrite(parsed.start, parsed.end, replacementLines.join("\n"));
            overwrittenRanges.push([parsed.start, parsed.end]);
            proxyObjectLocals.add(parsed.namespaceLocal);
            hasChanges = true;
          }
        }

        for (const parsed of collectGoogleFontExports(ast)) {
          const namedExports = parsed.named;
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
          s.overwrite(parsed.source.start, parsed.source.end, JSON.stringify(virtualId));
          overwrittenRanges.push([parsed.start, parsed.end]);
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

          // Validate the call against the bundled Google Fonts metadata
          // and resolve the actual axis values. This replaces an earlier
          // inline URL builder that hardcoded `:wght@100..900` regardless
          // of the font's real `wght` axis range, which produced HTTP 400
          // for fonts whose axis is narrower (Sen 400..800, Anton 400).
          // See issue #885.
          let validated;
          try {
            validated = validateGoogleFontOptions(family, options);
          } catch (err) {
            // Validation errors are programmer errors (unknown family,
            // missing required weight on a static font, etc.). Re-throw
            // with the file path attached so Vite reports the offending
            // call site instead of a generic plugin error.
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`[vinext:google-fonts] ${id}: ${message}`);
          }
          const axes = getFontAxes(
            family,
            validated.weights,
            validated.styles,
            validated.selectedVariableAxes,
          );
          const cssUrl = buildGoogleFontsUrl(family, axes, validated.display);

          // Check cache
          let localCSS = fontCache.get(cssUrl);
          if (!localCSS) {
            try {
              localCSS = await fetchAndCacheFont(cssUrl, family, cacheDir);
              fontCache.set(cssUrl, localCSS);
            } catch (err) {
              if (err instanceof GoogleFontsHttpError) {
                // HTTP 4xx/5xx from Google means the URL is malformed or
                // the family/axis combination is invalid. Surface as a
                // build error so the user sees the failing URL plus
                // Google's response body, rather than silently falling
                // through to a CDN URL that ships the same bad request
                // to the browser.
                throw new Error(
                  `[vinext:google-fonts] ${id}: Google Fonts returned HTTP ${err.status} for ${err.url}.\n${formatGoogleFontsErrorBody(err.responseBody)}`,
                );
              }
              // Network errors (offline, DNS, AbortError) are recoverable;
              // skip self-hosting and let the runtime CDN path handle it.
              return;
            }
          }

          // Rewrite absolute `.vinext/fonts/` filesystem paths in the cached
          // CSS to served URLs under `/<assetsDir>/_vinext_fonts/` so the
          // embedded `_vinext.font.selfHostedCSS` string has origin-relative URLs that
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
          const preloadUrls = findFontFilesInCss(
            servedCSS,
            validated.preload ? validated.subsets : undefined,
          )
            .filter((file) => file.preloadFontFile)
            .map((file) => file.googleFontFileUrl);
          const fallbackMetrics =
            validated.adjustFontFallback === false
              ? undefined
              : getFallbackFontOverrideMetrics(family);
          const adjustedFallbackCSS = fallbackMetrics
            ? buildFallbackFontFace(family, fallbackMetrics)
            : undefined;
          const validatedFontWeight =
            validated.weights.length === 1 && validated.weights[0] !== "variable"
              ? Number(validated.weights[0])
              : undefined;
          const validatedFontStyle =
            validated.styles.length === 1 ? validated.styles[0] : undefined;

          // Inject the internal transform-to-runtime payload into the options object.
          const internalFontProperties = [
            `selfHostedCSS: ${JSON.stringify(servedCSS)}`,
            `preloadUrls: ${JSON.stringify(preloadUrls)}`,
          ];
          if (adjustedFallbackCSS) {
            internalFontProperties.push(
              `adjustedFallbackCSS: ${JSON.stringify(adjustedFallbackCSS)}`,
            );
          }
          if (Number.isFinite(validatedFontWeight)) {
            internalFontProperties.push(`fontWeight: ${validatedFontWeight}`);
          }
          if (validatedFontStyle) {
            internalFontProperties.push(`fontStyle: ${JSON.stringify(validatedFontStyle)}`);
          }
          const injectedProperties = [
            `_vinext: { font: { ${internalFontProperties.join(", ")} } }`,
          ];
          const closingBrace = optionsStr.lastIndexOf("}");
          // Decide the separator from the last significant character before the
          // closing brace. `lastSignificantChar` skips whitespace AND comments
          // without being fooled by `//`/`/*` inside string literals (e.g. a URL
          // or a path with a double slash), so a trailing comma hidden behind a
          // comment is honoured and a `//` inside a value can never eat the real
          // comma. Determine the separator to insert before the new property:
          //   - Empty string if the object is empty ({ is the last significant char)
          //   - Empty string if there's already a trailing comma (avoid double comma)
          //   - ", " otherwise (before the new property)
          const lastChar = lastSignificantChar(optionsStr.slice(0, closingBrace));
          const separator = lastChar === "{" || lastChar === "," ? "" : ", ";
          const optionsWithCSS =
            optionsStr.slice(0, closingBrace) +
            separator +
            injectedProperties.join(", ") +
            optionsStr.slice(closingBrace);

          const replacement = `${calleeSource}(${optionsWithCSS})`;
          s.overwrite(callStart, callEnd, replacement);
          overwrittenRanges.push([callStart, callEnd]);
          hasChanges = true;
        }

        // Self-host injection runs in both dev and build. In dev, the
        // companion `configureServer` hook serves the cached files
        // directly from `.vinext/fonts/` so the rewritten URLs resolve
        // against the dev origin; in build, the `writeBundle` hook copies
        // them into the client output directory.

        for (const fontCall of collectGoogleFontCalls(ast, fontLocals, proxyObjectLocals)) {
          if (
            overwrittenRanges.some(
              ([start, end]) => fontCall.call.start < end && fontCall.call.end > start,
            )
          ) {
            continue;
          }

          await injectSelfHostedCss(
            fontCall.call.start,
            fontCall.call.end,
            code.slice(fontCall.options.start, fontCall.options.end),
            fontCall.family,
            fontCall.calleeSource,
          );
        }

        if (!hasChanges) return null;
        return magicStringTransformResult(s);
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
 *
 * @param shimsDir - Absolute path to the shims directory (with trailing
 *   separator). Used to skip vinext's own shim files from transform — they
 *   contain example `next/font/local` paths in comments that must not be
 *   rewritten. A precise prefix check is required (rather than a loose
 *   substring match) because, now that `node_modules` is no longer excluded,
 *   the guard runs against arbitrary third-party package paths — some of
 *   which may legitimately contain the substring `font-local` (e.g. a
 *   package named `font-local-loader`) and must still be transformed. This
 *   mirrors `createGoogleFontsPlugin`, which takes `shimsDir` for the same
 *   reason.
 */
export function createLocalFontsPlugin(shimsDir: string): Plugin {
  return {
    name: "vinext:local-fonts",
    enforce: "pre",

    transform: {
      // NOTE: node_modules is intentionally NOT excluded here. npm packages
      // commonly wrap `next/font/local` and ship the font files alongside the
      // module (e.g. `geist/dist/mono.js` calls
      // `localFont({ src: "./fonts/geist-mono/GeistMono-Variable.woff2" })`).
      // Those relative `src` paths are resolved against the package's own
      // directory and must be promoted to Vite asset imports just like a user's
      // source files, otherwise the runtime `@font-face` references the raw
      // relative path and the font 404s. Next.js's font loader runs on these
      // package files too, so vinext must as well. The `code` filter plus the
      // default-import check below keep this from touching unrelated modules.
      filter: {
        id: {
          include: /\.(tsx?|jsx?|mjs)$/,
        },
        code: "next/font/local",
      },
      handler(code, id) {
        // Defensive guards — duplicate filter logic
        if (id.startsWith("\0")) return null;
        if (!id.match(/\.(tsx?|jsx?|mjs)$/)) return null;
        if (!code.includes("next/font/local")) return null;
        // Skip vinext's own shim files — the font-local shim contains example
        // paths in comments that would be incorrectly rewritten. A precise
        // prefix check against `shimsDir` (not a loose `id.includes("font-local")`
        // substring) is required now that node_modules is no longer excluded,
        // so legitimate third-party packages whose path happens to contain
        // `font-local` are still transformed. Mirrors `createGoogleFontsPlugin`.
        if (id.startsWith(shimsDir)) return null;

        const ast = parseTransformAst(code, id);
        if (!ast) return null;

        // Verify there's actually a value default import from next/font/local
        // and remember its local binding so family payloads only attach to real
        // localFont calls.
        const localFontIdentifier = getLocalFontDefaultImport(ast);
        if (!localFontIdentifier) return null;

        const s = new MagicString(code);
        let hasChanges = false;
        let fontImportCounter = 0;
        const imports: string[] = [];

        const familyPayloadInsertions = new Set<number>();
        const rewrittenPathRanges = new Set<string>();
        for (const localFontCall of collectLocalFontCalls(ast, localFontIdentifier)) {
          for (const fontPathLiteral of collectLocalFontPathLiterals(localFontCall.options)) {
            const rangeKey = `${fontPathLiteral.node.start}:${fontPathLiteral.node.end}`;
            if (rewrittenPathRanges.has(rangeKey)) continue;
            rewrittenPathRanges.add(rangeKey);

            const varName = `__vinext_local_font_${fontImportCounter++}`;

            // Add an import for this font file — Vite resolves it as a static
            // asset and returns the correct URL for both dev and prod.
            imports.push(`import ${varName} from ${JSON.stringify(fontPathLiteral.path)};`);

            // Replace the string literal value:
            // path: "./font.woff2" -> path: __vinext_local_font_0
            s.overwrite(fontPathLiteral.node.start, fontPathLiteral.node.end, varName);
            hasChanges = true;
          }

          const bindingName = localFontCall.bindingName;
          if (!bindingName) continue;
          const insertAt = localFontCall.options.end - 1;
          if (familyPayloadInsertions.has(insertAt)) continue;
          if (objectHasVinextProperty(localFontCall.options)) continue;

          // Decide the separator from the last significant character before the
          // closing brace (see injectSelfHostedCss): comment- and
          // string-literal-aware, so a trailing comma hidden behind a comment is
          // honoured and a `//` inside a value (e.g. a path) is not mistaken for
          // a comment that would swallow the real comma → double comma.
          const optionsStr = code.slice(localFontCall.options.start, localFontCall.options.end);
          const lastChar = lastSignificantChar(optionsStr.slice(0, -1));
          const separator = lastChar === "{" || lastChar === "," ? "" : ", ";
          s.appendLeft(
            insertAt,
            `${separator}_vinext: { font: { family: ${JSON.stringify(bindingName)} } }`,
          );
          familyPayloadInsertions.add(insertAt);
          hasChanges = true;
        }

        if (!hasChanges) return null;

        // Prepend the asset imports at the top of the file
        if (imports.length > 0) {
          s.prepend(imports.join("\n") + "\n");
        }

        return magicStringTransformResult(s);
      },
    },
  } satisfies Plugin;
}
