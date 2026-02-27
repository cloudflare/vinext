import type { Plugin, UserConfig, ViteDevServer } from "vite";
import { parseAst } from "vite";
import { pagesRouter, apiRouter, invalidateRouteCache, matchRoute, patternToNextFormat as pagesPatternToNextFormat, type Route } from "./routing/pages-router.js";
import { appRouter, invalidateAppRouteCache } from "./routing/app-router.js";
import { createSSRHandler } from "./server/dev-server.js";
import { handleApiRoute } from "./server/api-handler.js";
import {
  generateRscEntry,
  generateSsrEntry,
  generateBrowserEntry,
} from "./server/app-dev-server.js";
import {
  loadNextConfig,
  resolveNextConfig,
  type ResolvedNextConfig,
  type NextRedirect,
  type NextRewrite,
} from "./config/next-config.js";

import { findMiddlewareFile, runMiddleware } from "./server/middleware.js";
import { generateSafeRegExpCode, generateMiddlewareMatcherCode, generateNormalizePathCode } from "./server/middleware-codegen.js";
import { normalizePath } from "./server/normalize-path.js";
import { findInstrumentationFile, runInstrumentation } from "./server/instrumentation.js";
import { validateDevRequest } from "./server/dev-origin-check.js";
import { safeRegExp, escapeHeaderSource, isExternalUrl, proxyExternalRequest } from "./config/config-matchers.js";
import { scanMetadataFiles } from "./server/metadata-routes.js";
import { staticExportPages } from "./build/static-export.js";
import tsconfigPaths from "vite-tsconfig-paths";
import MagicString from "magic-string";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
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
      const ext = fontUrl.includes(".woff2") ? ".woff2" : fontUrl.includes(".woff") ? ".woff" : ".ttf";
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
    // Rewrite CSS to use relative path (Vite will resolve /@fs/ for dev, or asset for build)
    css = css.split(fontUrl).join(filePath);
  }

  // Cache the rewritten CSS
  fs.writeFileSync(cachedCSSPath, css);
  return css;
}

/**
 * Safely parse a static JS object literal string into a plain object.
 * Uses Vite's parseAst (Rollup/acorn) so no code is ever evaluated.
 * Returns null if the expression contains anything dynamic (function calls,
 * template literals, identifiers, computed properties, etc.).
 *
 * Supports: string literals, numeric literals, boolean literals,
 * arrays of the above, and nested object literals.
 */
function parseStaticObjectLiteral(objectStr: string): Record<string, unknown> | null {
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractStaticValue(node: any): unknown {
  switch (node.type) {
    case "Literal":
      // String, number, boolean, null
      return node.value;

    case "UnaryExpression":
      // Handle negative numbers: -1, -3.14
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
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

/**
 * Detect Vite major version at runtime by resolving from cwd.
 * The plugin may be installed in a workspace root with Vite 7 but used
 * by a project that has Vite 8 — so we resolve from cwd, not from
 * the plugin's own location.
 */
function getViteMajorVersion(): number {
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const vitePkg = require("vite/package.json");
    return parseInt(vitePkg.version, 10);
  } catch {
    return 7; // default to Vite 7
  }
}

/**
 * PostCSS config file names to search for, in priority order.
 * Matches the same search order as postcss-load-config / lilconfig.
 */
const POSTCSS_CONFIG_FILES = [
  "postcss.config.js",
  "postcss.config.cjs",
  "postcss.config.mjs",
  "postcss.config.ts",
  "postcss.config.cts",
  "postcss.config.mts",
  ".postcssrc",
  ".postcssrc.js",
  ".postcssrc.cjs",
  ".postcssrc.mjs",
  ".postcssrc.ts",
  ".postcssrc.cts",
  ".postcssrc.mts",
  ".postcssrc.json",
  ".postcssrc.yaml",
  ".postcssrc.yml",
];

/**
 * Resolve PostCSS string plugin names in a project's PostCSS config.
 *
 * Next.js (via postcss-load-config) resolves string plugin names in the
 * object form `{ plugins: { "pkg-name": opts } }` but NOT in the array form
 * `{ plugins: ["pkg-name"] }`. Since many Next.js projects use the array
 * form (particularly with Tailwind CSS v4), we detect this case and resolve
 * the string names to actual plugin functions so Vite can use them.
 *
 * Returns the resolved PostCSS config object to inject into Vite's
 * `css.postcss`, or `undefined` if no resolution is needed.
 */
async function resolvePostcssStringPlugins(
  projectRoot: string,
): Promise<{ plugins: any[] } | undefined> {
  // Find the PostCSS config file
  let configPath: string | null = null;
  for (const name of POSTCSS_CONFIG_FILES) {
    const candidate = path.join(projectRoot, name);
    if (fs.existsSync(candidate)) {
      configPath = candidate;
      break;
    }
  }
  if (!configPath) return undefined;

  // Load the config file
  let config: any;
  try {
    if (configPath.endsWith(".json") || configPath.endsWith(".yaml") || configPath.endsWith(".yml")) {
      // JSON/YAML configs use object form — postcss-load-config handles these fine
      return undefined;
    }
    // For .postcssrc without extension, check if it's JSON
    if (configPath.endsWith(".postcssrc")) {
      const content = fs.readFileSync(configPath, "utf-8").trim();
      if (content.startsWith("{")) {
        // JSON format — postcss-load-config handles object form
        return undefined;
      }
    }
    const mod = await import(pathToFileURL(configPath).href);
    config = mod.default ?? mod;
  } catch {
    // If we can't load the config, let Vite/postcss-load-config handle it
    return undefined;
  }

  // Only process array-form plugins that contain string entries
  // (either bare strings or tuple form ["plugin-name", { options }])
  if (!config || !Array.isArray(config.plugins)) return undefined;
  const hasStringPlugins = config.plugins.some(
    (p: any) =>
      typeof p === "string" ||
      (Array.isArray(p) && typeof p[0] === "string"),
  );
  if (!hasStringPlugins) return undefined;

  // Resolve string plugin names to actual plugin functions
  const req = createRequire(path.join(projectRoot, "package.json"));
  const resolved = await Promise.all(
    config.plugins.filter(Boolean).map(async (plugin: any) => {
      if (typeof plugin === "string") {
        const resolved = req.resolve(plugin);
        const mod = await import(pathToFileURL(resolved).href);
        const fn = mod.default ?? mod;
        // If the export is a function, call it to get the plugin instance
        return typeof fn === "function" ? fn() : fn;
      }
      // Array tuple form: ["plugin-name", { options }]
      if (Array.isArray(plugin) && typeof plugin[0] === "string") {
        const [name, options] = plugin;
        const resolved = req.resolve(name);
        const mod = await import(pathToFileURL(resolved).href);
        const fn = mod.default ?? mod;
        return typeof fn === "function" ? fn(options) : fn;
      }
      // Already a function or plugin object — pass through
      return plugin;
    }),
  );

  return { plugins: resolved };
}

// Virtual module IDs for Pages Router production build
const VIRTUAL_SERVER_ENTRY = "virtual:vinext-server-entry";
const RESOLVED_SERVER_ENTRY = "\0" + VIRTUAL_SERVER_ENTRY;
const VIRTUAL_CLIENT_ENTRY = "virtual:vinext-client-entry";
const RESOLVED_CLIENT_ENTRY = "\0" + VIRTUAL_CLIENT_ENTRY;

// Virtual module IDs for App Router entries
const VIRTUAL_RSC_ENTRY = "virtual:vinext-rsc-entry";
const RESOLVED_RSC_ENTRY = "\0" + VIRTUAL_RSC_ENTRY;
const VIRTUAL_APP_SSR_ENTRY = "virtual:vinext-app-ssr-entry";
const RESOLVED_APP_SSR_ENTRY = "\0" + VIRTUAL_APP_SSR_ENTRY;
const VIRTUAL_APP_BROWSER_ENTRY = "virtual:vinext-app-browser-entry";
const RESOLVED_APP_BROWSER_ENTRY = "\0" + VIRTUAL_APP_BROWSER_ENTRY;

/** Image file extensions handled by the vinext:image-imports plugin.
 *  Shared between the Rolldown hook filter and the transform handler regex. */
const IMAGE_EXTS = "png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?";

/**
 * Extract the npm package name from a module ID (file path).
 * Returns null if not in node_modules.
 *
 * Handles scoped packages (@org/pkg) and pnpm-style paths
 * (node_modules/.pnpm/pkg@ver/node_modules/pkg).
 */
function getPackageName(id: string): string | null {
  const nmIdx = id.lastIndexOf("node_modules/");
  if (nmIdx === -1) return null;
  const rest = id.slice(nmIdx + "node_modules/".length);
  if (rest.startsWith("@")) {
    // Scoped package: @org/pkg
    const parts = rest.split("/");
    return parts.length >= 2 ? parts[0] + "/" + parts[1] : null;
  }
  return rest.split("/")[0] || null;
}

/** Absolute path to vinext's shims directory, used by clientManualChunks. */
const _shimsDir = path.resolve(__dirname, "shims") + "/";

/**
 * manualChunks function for client builds.
 *
 * Splits the client bundle into:
 * - "framework" — React, ReactDOM, and scheduler (loaded on every page)
 * - "vinext"    — vinext shims (router, head, link, etc.)
 *
 * All other vendor code is left to Rollup's default chunk-splitting
 * algorithm. Rollup automatically deduplicates shared modules into
 * common chunks based on the import graph — no manual intervention
 * needed.
 *
 * Why not split every npm package into its own chunk?
 * - Per-package splitting (`vendor-X`) creates 50-200+ chunks for a
 *   typical app, far exceeding the ~25-request sweet spot for HTTP/2.
 * - gzip/brotli compress small files poorly — each file restarts with
 *   an empty dictionary, losing ~5-15% total compressed size vs fewer
 *   larger chunks (Khan Academy measured +2.5% wire size with 10x
 *   more files containing less raw code).
 * - ES module evaluation has per-module overhead that compounds on
 *   mobile devices.
 * - No major Vite-based framework (Remix, SvelteKit, Astro, TanStack)
 *   uses per-package splitting. Next.js only isolates packages >160KB.
 * - Rollup's graph-based splitting already handles the common case
 *   well: shared dependencies between routes get their own chunks,
 *   and route-specific code stays in route chunks.
 */
function clientManualChunks(id: string): string | undefined {
  // React framework — always loaded, shared across all pages.
  // Isolating React into its own chunk is the single highest-value
  // split: it's ~130KB compressed, loaded on every page, and its
  // content hash rarely changes between deploys.
  if (id.includes("node_modules")) {
    const pkg = getPackageName(id);
    if (!pkg) return undefined;
    if (
      pkg === "react" ||
      pkg === "react-dom" ||
      pkg === "scheduler"
    ) {
      return "framework";
    }
    // Let Rollup handle all other vendor code via its default
    // graph-based splitting. This produces a reasonable number of
    // shared chunks (typically 5-15) based on actual import patterns,
    // with good compression efficiency.
    return undefined;
  }

  // vinext shims — small runtime, shared across all pages.
  // Use the absolute shims directory path to avoid matching user files
  // that happen to have "/shims/" in their path.
  if (id.startsWith(_shimsDir)) {
    return "vinext";
  }

  return undefined;
}

/**
 * Rollup output config with manualChunks for client code-splitting.
 * Used by both CLI builds and multi-environment builds.
 *
 * experimentalMinChunkSize merges tiny shared chunks (< 10KB) back into
 * their importers. This reduces HTTP request count and improves gzip
 * compression efficiency — small files restart the compression dictionary,
 * adding ~5-15% wire overhead vs fewer larger chunks.
 */
const clientOutputConfig = {
  manualChunks: clientManualChunks,
  experimentalMinChunkSize: 10_000,
};

/**
 * Rollup treeshake configuration for production client builds.
 *
 * Uses the 'recommended' preset as a safe base, then overrides
 * moduleSideEffects to strip unused re-exports from npm packages.
 *
 * The 'no-external' value for moduleSideEffects means:
 * - Local project modules: preserve side effects (CSS imports, polyfills)
 * - node_modules packages: treat as side-effect-free unless exports are used
 *
 * This is the single highest-impact optimization for large barrel-exporting
 * libraries like mermaid, @mui/material, lucide-react, etc. These libraries
 * re-export hundreds of sub-modules through barrel files. Without this,
 * Rollup preserves every sub-module even when only a few exports are consumed.
 *
 * Why 'no-external' instead of false (global side-effect-free)?
 * - User code may rely on import-time side effects (e.g., `import './global.css'`)
 * - 'no-external' is safe for app code while still enabling aggressive DCE for deps
 *
 * Why not the 'smallest' preset?
 * - 'smallest' also sets propertyReadSideEffects: false and
 *   tryCatchDeoptimization: false, which can break specific libraries
 *   that rely on property access side effects or try/catch for feature detection
 * - 'recommended' + 'no-external' gives most of the benefit with less risk
 */
const clientTreeshakeConfig = {
  preset: "recommended" as const,
  moduleSideEffects: "no-external" as const,
};

/**
 * Compute the set of chunk filenames that are ONLY reachable through dynamic
 * imports (i.e. behind React.lazy(), next/dynamic, or manual import()).
 *
 * These chunks should NOT be modulepreloaded in the HTML — they will be
 * fetched on demand when the dynamic import executes.
 *
 * Algorithm: Starting from all entry chunks in the build manifest, walk the
 * static `imports` tree (breadth-first). Any chunk file NOT reached by this
 * walk is only reachable through `dynamicImports` and is therefore "lazy".
 *
 * @param buildManifest - Vite's build manifest (manifest.json), which is a
 *   Record<string, ManifestChunk> where each chunk has `file`, `imports`,
 *   `dynamicImports`, `isEntry`, and `isDynamicEntry` fields.
 * @returns Array of chunk filenames (e.g. "assets/mermaid-NOHMQCX5.js") that
 *   should be excluded from modulepreload hints.
 */
function computeLazyChunks(
  buildManifest: Record<string, {
    file: string;
    isEntry?: boolean;
    isDynamicEntry?: boolean;
    imports?: string[];
    dynamicImports?: string[];
    css?: string[];
  }>
): string[] {
  // Collect all chunk files that are statically reachable from entries
  const eagerFiles = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [];

  // Start BFS from all entry chunks
  for (const key of Object.keys(buildManifest)) {
    const chunk = buildManifest[key];
    if (chunk.isEntry) {
      queue.push(key);
    }
  }

  while (queue.length > 0) {
    const key = queue.shift()!;
    if (visited.has(key)) continue;
    visited.add(key);

    const chunk = buildManifest[key];
    if (!chunk) continue;

    // Mark this chunk's file as eager
    eagerFiles.add(chunk.file);

    // Also mark its CSS as eager (CSS should always be preloaded to avoid FOUC)
    if (chunk.css) {
      for (const cssFile of chunk.css) {
        eagerFiles.add(cssFile);
      }
    }

    // Follow only static imports — NOT dynamicImports
    if (chunk.imports) {
      for (const imp of chunk.imports) {
        if (!visited.has(imp)) {
          queue.push(imp);
        }
      }
    }
  }

  // Any JS file in the manifest that's NOT in eagerFiles is a lazy chunk
  const lazyChunks: string[] = [];
  const allFiles = new Set<string>();
  for (const key of Object.keys(buildManifest)) {
    const chunk = buildManifest[key];
    if (chunk.file && !allFiles.has(chunk.file)) {
      allFiles.add(chunk.file);
      if (!eagerFiles.has(chunk.file) && chunk.file.endsWith(".js")) {
        lazyChunks.push(chunk.file);
      }
    }
  }

  return lazyChunks;
}

export interface VinextOptions {
  /**
   * Base directory containing the app/ and pages/ directories.
   * Can be an absolute path or a path relative to the Vite root.
   *
   * By default, vinext auto-detects: checks for app/ and pages/ at the
   * project root first, then falls back to src/app/ and src/pages/.
   */
  appDir?: string;
  /**
   * Auto-register @vitejs/plugin-rsc when an app/ directory is detected.
   * Set to `false` to disable auto-registration (e.g. if you configure
   * @vitejs/plugin-rsc manually with custom options).
   * @default true
   */
  rsc?: boolean;
}

export default function vinext(options: VinextOptions = {}): Plugin[] {
  let root: string;
  let pagesDir: string;
  let appDir: string;
  let hasAppDir = false;
  let hasPagesDir = false;
  let nextConfig: ResolvedNextConfig;
  let middlewarePath: string | null = null;
  let instrumentationPath: string | null = null;
  let hasCloudflarePlugin = false;

  // Resolve shim paths - works both from source (.ts) and built (.js)
  const shimsDir = path.resolve(__dirname, "shims");

  // Shim alias map — populated in config(), used by resolveId() for .js variants
  let nextShimMap: Record<string, string> = {};

  /**
   * Generate the virtual SSR server entry module.
   * This is the entry point for `vite build --ssr`.
   */
  async function generateServerEntry(): Promise<string> {
    const pageRoutes = await pagesRouter(pagesDir);
    const apiRoutes = await apiRouter(pagesDir);

    // Generate import statements using absolute paths since virtual
    // modules don't have a real file location for relative resolution.
    const pageImports = pageRoutes.map((r: Route, i: number) => {
      const absPath = r.filePath.replace(/\\/g, "/");
      return `import * as page_${i} from ${JSON.stringify(absPath)};`;
    });

    const apiImports = apiRoutes.map((r: Route, i: number) => {
      const absPath = r.filePath.replace(/\\/g, "/");
      return `import * as api_${i} from ${JSON.stringify(absPath)};`;
    });

    // Build the route table — include filePath for SSR manifest lookup
    const pageRouteEntries = pageRoutes.map((r: Route, i: number) => {
      const absPath = r.filePath.replace(/\\/g, "/");
      return `  { pattern: ${JSON.stringify(r.pattern)}, isDynamic: ${r.isDynamic}, params: ${JSON.stringify(r.params)}, module: page_${i}, filePath: ${JSON.stringify(absPath)} }`;
    });

    const apiRouteEntries = apiRoutes.map((r: Route, i: number) => {
      return `  { pattern: ${JSON.stringify(r.pattern)}, isDynamic: ${r.isDynamic}, params: ${JSON.stringify(r.params)}, module: api_${i} }`;
    });

    // Check for _app and _document
    const hasApp = fs.existsSync(path.join(pagesDir, "_app.tsx")) || fs.existsSync(path.join(pagesDir, "_app.jsx")) || fs.existsSync(path.join(pagesDir, "_app.ts")) || fs.existsSync(path.join(pagesDir, "_app.js"));
    const hasDoc = fs.existsSync(path.join(pagesDir, "_document.tsx")) || fs.existsSync(path.join(pagesDir, "_document.jsx")) || fs.existsSync(path.join(pagesDir, "_document.ts")) || fs.existsSync(path.join(pagesDir, "_document.js"));

    // Use absolute paths for _app and _document too
    const appFileBase = path.join(pagesDir, "_app").replace(/\\/g, "/");
    const docFileBase = path.join(pagesDir, "_document").replace(/\\/g, "/");

    const appImportCode = hasApp
      ? `import { default as AppComponent } from ${JSON.stringify(appFileBase)};`
      : `const AppComponent = null;`;

    const docImportCode = hasDoc
      ? `import { default as DocumentComponent } from ${JSON.stringify(docFileBase)};`
      : `const DocumentComponent = null;`;

    // Serialize i18n config for embedding in the server entry
    const i18nConfigJson = nextConfig?.i18n
      ? JSON.stringify({
          locales: nextConfig.i18n.locales,
          defaultLocale: nextConfig.i18n.defaultLocale,
          localeDetection: nextConfig.i18n.localeDetection,
        })
      : "null";

    // Serialize the full resolved config for the production server.
    // This embeds redirects, rewrites, headers, basePath, trailingSlash
    // so prod-server.ts can apply them without loading next.config.js at runtime.
    const vinextConfigJson = JSON.stringify({
      basePath: nextConfig?.basePath ?? "",
      trailingSlash: nextConfig?.trailingSlash ?? false,
      redirects: nextConfig?.redirects ?? [],
      rewrites: nextConfig?.rewrites ?? { beforeFiles: [], afterFiles: [], fallback: [] },
      headers: nextConfig?.headers ?? [],
      i18n: nextConfig?.i18n ?? null,
    });

    // Generate middleware code if middleware.ts exists
    const middlewareImportCode = middlewarePath
      ? `import * as middlewareModule from ${JSON.stringify(middlewarePath.replace(/\\/g, "/"))};
import { NextRequest } from "next/server";`
      : "";

    // The matcher config is read from the middleware module at import time.
    // We inline the matching + execution logic so the prod server can call it.
    const middlewareExportCode = middlewarePath
      ? `
// --- Middleware support (generated from middleware-codegen.ts) ---
${generateNormalizePathCode("es5")}
${generateSafeRegExpCode("es5")}
${generateMiddlewareMatcherCode("es5")}

export async function runMiddleware(request) {
  var middlewareFn = middlewareModule.default || middlewareModule.middleware;
  if (typeof middlewareFn !== "function") return { continue: true };

  var config = middlewareModule.config;
  var matcher = config && config.matcher;
  var url = new URL(request.url);

  // Normalize pathname before matching to prevent path-confusion bypasses
  // (percent-encoding like /%61dmin, double slashes like /dashboard//settings).
  var decodedPathname;
  try { decodedPathname = decodeURIComponent(url.pathname); } catch (e) {
    return { continue: false, response: new Response("Bad Request", { status: 400 }) };
  }
  var normalizedPathname = __normalizePath(decodedPathname);

  if (!matchesMiddleware(normalizedPathname, matcher)) return { continue: true };

   // Construct a new Request with the decoded + normalized pathname so middleware
   // always sees the same canonical path that the router uses.
  var mwRequest = request;
  if (normalizedPathname !== url.pathname) {
    var mwUrl = new URL(url);
    mwUrl.pathname = normalizedPathname;
    mwRequest = new Request(mwUrl, request);
  }
  var nextRequest = mwRequest instanceof NextRequest ? mwRequest : new NextRequest(mwRequest);
  var response;
  try { response = await middlewareFn(nextRequest); }
  catch (e) {
    console.error("[vinext] Middleware error:", e);
    return { continue: false, response: new Response("Internal Server Error", { status: 500 }) };
  }

  if (!response) return { continue: true };

  if (response.headers.get("x-middleware-next") === "1") {
    var rHeaders = new Headers();
    for (var [key, value] of response.headers) {
      // Keep x-middleware-request-* headers so the production server can
      // apply middleware-request header overrides before stripping internals
      // from the final client response.
      if (
        !key.startsWith("x-middleware-") ||
        key.startsWith("x-middleware-request-")
      ) rHeaders.append(key, value);
    }
    return { continue: true, responseHeaders: rHeaders };
  }

  if (response.status >= 300 && response.status < 400) {
    var location = response.headers.get("Location") || response.headers.get("location");
    if (location) return { continue: false, redirectUrl: location, redirectStatus: response.status };
  }

  var rewriteUrl = response.headers.get("x-middleware-rewrite");
  if (rewriteUrl) {
    var rwHeaders = new Headers();
    for (var [k, v] of response.headers) {
      if (!k.startsWith("x-middleware-") || k.startsWith("x-middleware-request-")) rwHeaders.append(k, v);
    }
    var rewritePath;
    try { var parsed = new URL(rewriteUrl, request.url); rewritePath = parsed.pathname + parsed.search; }
    catch { rewritePath = rewriteUrl; }
    return { continue: true, rewriteUrl: rewritePath, rewriteStatus: response.status !== 200 ? response.status : undefined, responseHeaders: rwHeaders };
  }

  return { continue: false, response: response };
}
`
      : `
export async function runMiddleware() { return { continue: true }; }
`;

    // The server entry is a self-contained module that uses Web-standard APIs
    // (Request/Response, renderToReadableStream) so it runs on Cloudflare Workers.
    return `
import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { resetSSRHead, getSSRHeadHTML } from "next/head";
import { flushPreloads } from "next/dynamic";
import { setSSRContext } from "next/router";
import { getCacheHandler } from "next/cache";
import { runWithFetchCache } from "vinext/fetch-cache";
import { _runWithCacheState } from "next/cache";
import { runWithPrivateCache } from "vinext/cache-runtime";
import { runWithRouterState } from "vinext/router-state";
import { runWithHeadState } from "vinext/head-state";
import { safeJsonStringify } from "vinext/html";
import { getSSRFontLinks as _getSSRFontLinks, getSSRFontStyles as _getSSRFontStylesGoogle, getSSRFontPreloads as _getSSRFontPreloadsGoogle } from "next/font/google";
import { getSSRFontStyles as _getSSRFontStylesLocal, getSSRFontPreloads as _getSSRFontPreloadsLocal } from "next/font/local";
${middlewareImportCode}

// i18n config (embedded at build time)
const i18nConfig = ${i18nConfigJson};

// Full resolved config for production server (embedded at build time)
export const vinextConfig = ${vinextConfigJson};

// ISR cache helpers (inlined for the server entry)
async function isrGet(key) {
  const handler = getCacheHandler();
  const result = await handler.get(key);
  if (!result || !result.value) return null;
  return { value: result, isStale: result.cacheState === "stale" };
}
async function isrSet(key, data, revalidateSeconds, tags) {
  const handler = getCacheHandler();
  await handler.set(key, data, { revalidate: revalidateSeconds, tags: tags || [] });
}
const pendingRegenerations = new Map();
function triggerBackgroundRegeneration(key, renderFn) {
  if (pendingRegenerations.has(key)) return;
  const promise = renderFn()
    .catch((err) => console.error("[vinext] ISR regen failed for " + key + ":", err))
    .finally(() => pendingRegenerations.delete(key));
  pendingRegenerations.set(key, promise);
}

async function renderToStringAsync(element) {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

${pageImports.join("\n")}
${apiImports.join("\n")}

${appImportCode}
${docImportCode}

const pageRoutes = [
${pageRouteEntries.join(",\n")}
];

const apiRoutes = [
${apiRouteEntries.join(",\n")}
];

function matchRoute(url, routes) {
  const pathname = url.split("?")[0];
  let normalizedUrl = pathname === "/" ? "/" : pathname.replace(/\\/$/, "");
  // NOTE: Do NOT decodeURIComponent here. The pathname is already decoded at
  // the entry point. Decoding again would create a double-decode vector.
  for (const route of routes) {
    const params = matchPattern(normalizedUrl, route.pattern);
    if (params !== null) return { route, params };
  }
  return null;
}

function matchPattern(url, pattern) {
  const urlParts = url.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  const params = Object.create(null);
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    if (pp.endsWith("+")) {
      const paramName = pp.slice(1, -1);
      const remaining = urlParts.slice(i);
      if (remaining.length === 0) return null;
      params[paramName] = remaining;
      return params;
    }
    if (pp.endsWith("*")) {
      const paramName = pp.slice(1, -1);
      params[paramName] = urlParts.slice(i);
      return params;
    }
    if (pp.startsWith(":")) {
      if (i >= urlParts.length) return null;
      params[pp.slice(1)] = urlParts[i];
      continue;
    }
    if (i >= urlParts.length || urlParts[i] !== pp) return null;
  }
  if (urlParts.length !== patternParts.length) return null;
  return params;
}

function parseQuery(url) {
  const qs = url.split("?")[1];
  if (!qs) return {};
  const p = new URLSearchParams(qs);
  const q = {};
  for (const [k, v] of p) {
    if (k in q) {
      q[k] = Array.isArray(q[k]) ? q[k].concat(v) : [q[k], v];
    } else {
      q[k] = v;
    }
  }
  return q;
}

function patternToNextFormat(pattern) {
  return pattern
    .replace(/:([\\w]+)\\*/g, "[[...$1]]")
    .replace(/:([\\w]+)\\+/g, "[...$1]")
    .replace(/:([\\w]+)/g, "[$1]");
}

function collectAssetTags(manifest, moduleIds) {
  // Fall back to embedded manifest (set by vinext:cloudflare-build for Workers)
  const m = (manifest && Object.keys(manifest).length > 0)
    ? manifest
    : (typeof globalThis !== "undefined" && globalThis.__VINEXT_SSR_MANIFEST__) || null;
  const tags = [];
  const seen = new Set();

  // Load the set of lazy chunk filenames (only reachable via dynamic imports).
  // These should NOT get <link rel="modulepreload"> or <script type="module">
  // tags — they are fetched on demand when the dynamic import() executes (e.g.
  // chunks behind React.lazy() or next/dynamic boundaries).
  var lazyChunks = (typeof globalThis !== "undefined" && globalThis.__VINEXT_LAZY_CHUNKS__) || null;
  var lazySet = lazyChunks && lazyChunks.length > 0 ? new Set(lazyChunks) : null;

  // Inject the client entry script if embedded by vinext:cloudflare-build
  if (typeof globalThis !== "undefined" && globalThis.__VINEXT_CLIENT_ENTRY__) {
    const entry = globalThis.__VINEXT_CLIENT_ENTRY__;
    seen.add(entry);
    tags.push('<link rel="modulepreload" href="/' + entry + '" />');
    tags.push('<script type="module" src="/' + entry + '" crossorigin></script>');
  }
  if (m) {
    // Always inject shared chunks (framework, vinext runtime, entry) and
    // page-specific chunks. The manifest maps module file paths to their
    // associated JS/CSS assets.
    //
    // For page-specific injection, the module IDs may be absolute paths
    // while the manifest uses relative paths. Try both the original ID
    // and a suffix match to find the correct manifest entry.
    var allFiles = [];

    if (moduleIds && moduleIds.length > 0) {
      // Collect assets for the requested page modules
      for (var mi = 0; mi < moduleIds.length; mi++) {
        var id = moduleIds[mi];
        var files = m[id];
        if (!files) {
          // Absolute path didn't match — try matching by suffix.
          // Manifest keys are relative (e.g. "pages/about.tsx") while
          // moduleIds may be absolute (e.g. "/home/.../pages/about.tsx").
          for (var mk in m) {
            if (id.endsWith("/" + mk) || id === mk) {
              files = m[mk];
              break;
            }
          }
        }
        if (files) {
          for (var fi = 0; fi < files.length; fi++) allFiles.push(files[fi]);
        }
      }

      // Also inject shared chunks that every page needs: framework,
      // vinext runtime, and the entry bootstrap. These are identified
      // by scanning all manifest values for chunk filenames containing
      // known prefixes.
      for (var key in m) {
        var vals = m[key];
        if (!vals) continue;
        for (var vi = 0; vi < vals.length; vi++) {
          var file = vals[vi];
          var basename = file.split("/").pop() || "";
          if (
            basename.startsWith("framework-") ||
            basename.startsWith("vinext-") ||
            basename.includes("vinext-client-entry") ||
            basename.includes("vinext-app-browser-entry")
          ) {
            allFiles.push(file);
          }
        }
      }
    } else {
      // No specific modules — include all assets from manifest
      for (var akey in m) {
        var avals = m[akey];
        if (avals) {
          for (var ai = 0; ai < avals.length; ai++) allFiles.push(avals[ai]);
        }
      }
    }

    for (var ti = 0; ti < allFiles.length; ti++) {
      var tf = allFiles[ti];
      // Normalize: Vite's SSR manifest values include a leading '/'
      // (from base path), but we prepend '/' ourselves when building
      // href/src attributes. Strip any existing leading slash to avoid
      // producing protocol-relative URLs like "//assets/chunk.js".
      // This also ensures consistent keys for the seen-set dedup and
      // lazySet.has() checks (which use values without leading slash).
      if (tf.charAt(0) === '/') tf = tf.slice(1);
      if (seen.has(tf)) continue;
      seen.add(tf);
      if (tf.endsWith(".css")) {
        tags.push('<link rel="stylesheet" href="/' + tf + '" />');
      } else if (tf.endsWith(".js")) {
        // Skip lazy chunks — they are behind dynamic import() boundaries
        // (React.lazy, next/dynamic) and should only be fetched on demand.
        if (lazySet && lazySet.has(tf)) continue;
        tags.push('<link rel="modulepreload" href="/' + tf + '" />');
        tags.push('<script type="module" src="/' + tf + '" crossorigin></script>');
      }
    }
  }
  return tags.join("\\n  ");
}

// i18n helpers
function extractLocale(url) {
  if (!i18nConfig) return { locale: undefined, url, hadPrefix: false };
  const pathname = url.split("?")[0];
  const parts = pathname.split("/").filter(Boolean);
  const query = url.includes("?") ? url.slice(url.indexOf("?")) : "";
  if (parts.length > 0 && i18nConfig.locales.includes(parts[0])) {
    const locale = parts[0];
    const rest = "/" + parts.slice(1).join("/");
    return { locale, url: (rest || "/") + query, hadPrefix: true };
  }
  return { locale: i18nConfig.defaultLocale, url, hadPrefix: false };
}

function detectLocaleFromHeaders(headers) {
  if (!i18nConfig) return null;
  const acceptLang = headers.get("accept-language");
  if (!acceptLang) return null;
  const langs = acceptLang.split(",").map(function(part) {
    const pieces = part.trim().split(";");
    const q = pieces[1] ? parseFloat(pieces[1].replace("q=", "")) : 1;
    return { lang: pieces[0].trim().toLowerCase(), q: q };
  }).sort(function(a, b) { return b.q - a.q; });
  for (let k = 0; k < langs.length; k++) {
    const lang = langs[k].lang;
    for (let j = 0; j < i18nConfig.locales.length; j++) {
      if (i18nConfig.locales[j].toLowerCase() === lang) return i18nConfig.locales[j];
    }
    const prefix = lang.split("-")[0];
    for (let j = 0; j < i18nConfig.locales.length; j++) {
      const loc = i18nConfig.locales[j].toLowerCase();
      if (loc === prefix || loc.startsWith(prefix + "-")) return i18nConfig.locales[j];
    }
  }
  return null;
}

function parseCookieLocaleFromHeader(cookieHeader) {
  if (!i18nConfig || !cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\\s*)NEXT_LOCALE=([^;]*)/);
  if (!match) return null;
  var value;
  try { value = decodeURIComponent(match[1].trim()); } catch (e) { return null; }
  if (i18nConfig.locales.indexOf(value) !== -1) return value;
  return null;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.split("=");
    if (key) cookies[key.trim()] = rest.join("=").trim();
  }
  return cookies;
}

// Lightweight req/res facade for getServerSideProps and API routes.
// Next.js pages expect ctx.req/ctx.res with Node-like shapes.
function createReqRes(request, url, query, body) {
  const headersObj = {};
  for (const [k, v] of request.headers) headersObj[k.toLowerCase()] = v;

  const req = {
    method: request.method,
    url: url,
    headers: headersObj,
    query: query,
    body: body,
    cookies: parseCookies(request.headers.get("cookie")),
  };

  let resStatusCode = 200;
  const resHeaders = {};
  // set-cookie needs array support (multiple Set-Cookie headers are common)
  const setCookieHeaders = [];
  let resBody = null;
  let ended = false;
  let resolveResponse;
  const responsePromise = new Promise(function(r) { resolveResponse = r; });

  const res = {
    get statusCode() { return resStatusCode; },
    set statusCode(code) { resStatusCode = code; },
    writeHead: function(code, headers) {
      resStatusCode = code;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === "set-cookie") {
            if (Array.isArray(v)) { for (const c of v) setCookieHeaders.push(c); }
            else { setCookieHeaders.push(v); }
          } else {
            resHeaders[k] = v;
          }
        }
      }
      return res;
    },
    setHeader: function(name, value) {
      if (name.toLowerCase() === "set-cookie") {
        if (Array.isArray(value)) { for (const c of value) setCookieHeaders.push(c); }
        else { setCookieHeaders.push(value); }
      } else {
        resHeaders[name.toLowerCase()] = value;
      }
      return res;
    },
    getHeader: function(name) {
      if (name.toLowerCase() === "set-cookie") return setCookieHeaders.length > 0 ? setCookieHeaders : undefined;
      return resHeaders[name.toLowerCase()];
    },
    end: function(data) {
      if (ended) return;
      ended = true;
      if (data !== undefined && data !== null) resBody = data;
      const h = new Headers(resHeaders);
      for (const c of setCookieHeaders) h.append("set-cookie", c);
      resolveResponse(new Response(resBody, { status: resStatusCode, headers: h }));
    },
    status: function(code) { resStatusCode = code; return res; },
    json: function(data) {
      resHeaders["content-type"] = "application/json";
      res.end(JSON.stringify(data));
    },
    send: function(data) {
      if (typeof data === "object" && data !== null) { res.json(data); }
      else { if (!resHeaders["content-type"]) resHeaders["content-type"] = "text/plain"; res.end(String(data)); }
    },
    redirect: function(statusOrUrl, url2) {
      if (typeof statusOrUrl === "string") { res.writeHead(307, { Location: statusOrUrl }); }
      else { res.writeHead(statusOrUrl, { Location: url2 }); }
      res.end();
    },
  };

  return { req, res, responsePromise };
}

/**
 * Read request body as text with a size limit.
 * Throws if the body exceeds maxBytes. This prevents DoS via chunked
 * transfer encoding where Content-Length is absent or spoofed.
 */
async function readBodyWithLimit(request, maxBytes) {
  if (!request.body) return "";
  var reader = request.body.getReader();
  var decoder = new TextDecoder();
  var chunks = [];
  var totalSize = 0;
  for (;;) {
    var result = await reader.read();
    if (result.done) break;
    totalSize += result.value.byteLength;
    if (totalSize > maxBytes) {
      reader.cancel();
      throw new Error("Request body too large");
    }
    chunks.push(decoder.decode(result.value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

export async function renderPage(request, url, manifest) {
  const localeInfo = extractLocale(url);
  const locale = localeInfo.locale;
  const routeUrl = localeInfo.url;
  const cookieHeader = request.headers.get("cookie") || "";

  // i18n redirect: check NEXT_LOCALE cookie first, then Accept-Language
  if (i18nConfig && !localeInfo.hadPrefix) {
    const cookieLocale = parseCookieLocaleFromHeader(cookieHeader);
    if (cookieLocale && cookieLocale !== i18nConfig.defaultLocale) {
      return new Response(null, { status: 307, headers: { Location: "/" + cookieLocale + routeUrl } });
    }
    if (!cookieLocale && i18nConfig.localeDetection !== false) {
      const detected = detectLocaleFromHeaders(request.headers);
      if (detected && detected !== i18nConfig.defaultLocale) {
        return new Response(null, { status: 307, headers: { Location: "/" + detected + routeUrl } });
      }
    }
  }

  const match = matchRoute(routeUrl, pageRoutes);
  if (!match) {
    return new Response("<!DOCTYPE html><html><body><h1>404 - Page not found</h1></body></html>",
      { status: 404, headers: { "Content-Type": "text/html" } });
  }

  const { route, params } = match;
  return runWithRouterState(() =>
    runWithHeadState(() =>
      _runWithCacheState(() =>
        runWithPrivateCache(() =>
          runWithFetchCache(async () => {
  try {
    if (typeof setSSRContext === "function") {
      setSSRContext({
        pathname: routeUrl.split("?")[0],
        query: { ...params, ...parseQuery(routeUrl) },
        asPath: routeUrl,
        locale: locale,
        locales: i18nConfig ? i18nConfig.locales : undefined,
        defaultLocale: i18nConfig ? i18nConfig.defaultLocale : undefined,
      });
    }

    if (i18nConfig) {
      globalThis.__VINEXT_LOCALE__ = locale;
      globalThis.__VINEXT_LOCALES__ = i18nConfig.locales;
      globalThis.__VINEXT_DEFAULT_LOCALE__ = i18nConfig.defaultLocale;
    }

    const pageModule = route.module;
    const PageComponent = pageModule.default;
    if (!PageComponent) {
      return new Response("Page has no default export", { status: 500 });
    }

    // Handle getStaticPaths for dynamic routes
    if (typeof pageModule.getStaticPaths === "function" && route.isDynamic) {
      const pathsResult = await pageModule.getStaticPaths({
        locales: i18nConfig ? i18nConfig.locales : [],
        defaultLocale: i18nConfig ? i18nConfig.defaultLocale : "",
      });
      const fallback = pathsResult && pathsResult.fallback !== undefined ? pathsResult.fallback : false;

      if (fallback === false) {
        const paths = pathsResult && pathsResult.paths ? pathsResult.paths : [];
        const isValidPath = paths.some(function(p) {
          return Object.entries(p.params).every(function(entry) {
            var key = entry[0], val = entry[1];
            var actual = params[key];
            if (Array.isArray(val)) {
              return Array.isArray(actual) && val.join("/") === actual.join("/");
            }
            return String(val) === String(actual);
          });
        });
        if (!isValidPath) {
          return new Response("<!DOCTYPE html><html><body><h1>404 - Page not found</h1></body></html>",
            { status: 404, headers: { "Content-Type": "text/html" } });
        }
      }
    }

    let pageProps = {};
    if (typeof pageModule.getServerSideProps === "function") {
      const { req, res } = createReqRes(request, routeUrl, parseQuery(routeUrl), undefined);
      const ctx = {
        params, req, res,
        query: parseQuery(routeUrl),
        resolvedUrl: routeUrl,
        locale: locale,
        locales: i18nConfig ? i18nConfig.locales : undefined,
        defaultLocale: i18nConfig ? i18nConfig.defaultLocale : undefined,
      };
      const result = await pageModule.getServerSideProps(ctx);
      if (result && result.props) pageProps = result.props;
      if (result && result.redirect) {
        var gsspStatus = result.redirect.statusCode != null ? result.redirect.statusCode : (result.redirect.permanent ? 308 : 307);
        return new Response(null, { status: gsspStatus, headers: { Location: sanitizeDestinationLocal(result.redirect.destination) } });
      }
      if (result && result.notFound) {
        return new Response("404", { status: 404 });
      }
    }
    // Build font Link header early so it's available for ISR cached responses too.
    // Font preloads are module-level state populated at import time and persist across requests.
    var _fontLinkHeader = "";
    var _allFp = [];
    try {
      var _fpGoogle = typeof _getSSRFontPreloadsGoogle === "function" ? _getSSRFontPreloadsGoogle() : [];
      var _fpLocal = typeof _getSSRFontPreloadsLocal === "function" ? _getSSRFontPreloadsLocal() : [];
      _allFp = _fpGoogle.concat(_fpLocal);
      if (_allFp.length > 0) {
        _fontLinkHeader = _allFp.map(function(p) { return "<" + p.href + ">; rel=preload; as=font; type=" + p.type + "; crossorigin"; }).join(", ");
      }
    } catch (e) { /* font preloads not available */ }

    let isrRevalidateSeconds = null;
    if (typeof pageModule.getStaticProps === "function") {
      const pathname = routeUrl.split("?")[0];
      const cacheKey = "pages:" + (pathname === "/" ? "/" : pathname.replace(/\\/$/, ""));
      const cached = await isrGet(cacheKey);

      if (cached && !cached.isStale && cached.value.value && cached.value.value.kind === "PAGES") {
        var _hitHeaders = {
          "Content-Type": "text/html", "X-Vinext-Cache": "HIT",
          "Cache-Control": "s-maxage=" + (cached.value.value.revalidate || 60) + ", stale-while-revalidate",
        };
        if (_fontLinkHeader) _hitHeaders["Link"] = _fontLinkHeader;
        return new Response(cached.value.value.html, { status: 200, headers: _hitHeaders });
      }

      if (cached && cached.isStale && cached.value.value && cached.value.value.kind === "PAGES") {
        triggerBackgroundRegeneration(cacheKey, async function() {
          const freshResult = await pageModule.getStaticProps({ params });
          if (freshResult && freshResult.props && typeof freshResult.revalidate === "number" && freshResult.revalidate > 0) {
            await isrSet(cacheKey, { kind: "PAGES", html: cached.value.value.html, pageData: freshResult.props, headers: undefined, status: undefined }, freshResult.revalidate);
          }
        });
        var _staleHeaders = {
          "Content-Type": "text/html", "X-Vinext-Cache": "STALE",
          "Cache-Control": "s-maxage=0, stale-while-revalidate",
        };
        if (_fontLinkHeader) _staleHeaders["Link"] = _fontLinkHeader;
        return new Response(cached.value.value.html, { status: 200, headers: _staleHeaders });
      }

      const ctx = {
        params,
        locale: locale,
        locales: i18nConfig ? i18nConfig.locales : undefined,
        defaultLocale: i18nConfig ? i18nConfig.defaultLocale : undefined,
      };
      const result = await pageModule.getStaticProps(ctx);
      if (result && result.props) pageProps = result.props;
      if (result && result.redirect) {
        var gspStatus = result.redirect.statusCode != null ? result.redirect.statusCode : (result.redirect.permanent ? 308 : 307);
        return new Response(null, { status: gspStatus, headers: { Location: sanitizeDestinationLocal(result.redirect.destination) } });
      }
      if (result && result.notFound) {
        return new Response("404", { status: 404 });
      }
      if (typeof result.revalidate === "number" && result.revalidate > 0) {
        isrRevalidateSeconds = result.revalidate;
      }
    }

    let element;
    if (AppComponent) {
      element = React.createElement(AppComponent, { Component: PageComponent, pageProps });
    } else {
      element = React.createElement(PageComponent, pageProps);
    }

    if (typeof resetSSRHead === "function") resetSSRHead();
    if (typeof flushPreloads === "function") await flushPreloads();

    const ssrHeadHTML = typeof getSSRHeadHTML === "function" ? getSSRHeadHTML() : "";

    // Collect SSR font data (Google Font links, font preloads, font-face styles)
    var fontHeadHTML = "";
    function _escAttr(s) { return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }
    try {
      var fontLinks = typeof _getSSRFontLinks === "function" ? _getSSRFontLinks() : [];
      for (var fl of fontLinks) { fontHeadHTML += '<link rel="stylesheet" href="' + _escAttr(fl) + '" />\\n  '; }
    } catch (e) { /* next/font/google not used */ }
    // Emit <link rel="preload"> for all font files (reuse _allFp collected earlier for Link header)
    for (var fp of _allFp) { fontHeadHTML += '<link rel="preload" href="' + _escAttr(fp.href) + '" as="font" type="' + _escAttr(fp.type) + '" crossorigin />\\n  '; }
    try {
      var allFontStyles = [];
      if (typeof _getSSRFontStylesGoogle === "function") allFontStyles.push(..._getSSRFontStylesGoogle());
      if (typeof _getSSRFontStylesLocal === "function") allFontStyles.push(..._getSSRFontStylesLocal());
      if (allFontStyles.length > 0) { fontHeadHTML += '<style data-vinext-fonts>' + allFontStyles.join("\\n") + '</style>\\n  '; }
    } catch (e) { /* font styles not available */ }

    const pageModuleIds = route.filePath ? [route.filePath] : [];
    const assetTags = collectAssetTags(manifest, pageModuleIds);
    const nextDataPayload = {
      props: { pageProps }, page: patternToNextFormat(route.pattern), query: params, isFallback: false,
    };
    if (i18nConfig) {
      nextDataPayload.locale = locale;
      nextDataPayload.locales = i18nConfig.locales;
      nextDataPayload.defaultLocale = i18nConfig.defaultLocale;
    }
    const localeGlobals = i18nConfig
      ? ";window.__VINEXT_LOCALE__=" + safeJsonStringify(locale) +
        ";window.__VINEXT_LOCALES__=" + safeJsonStringify(i18nConfig.locales) +
        ";window.__VINEXT_DEFAULT_LOCALE__=" + safeJsonStringify(i18nConfig.defaultLocale)
      : "";
    const nextDataScript = "<script>window.__NEXT_DATA__ = " + safeJsonStringify(nextDataPayload) + localeGlobals + "</script>";

    // Build the document shell with a placeholder for the streamed body
    var BODY_MARKER = "<!--VINEXT_STREAM_BODY-->";
    var shellHtml;
    if (DocumentComponent) {
      const docElement = React.createElement(DocumentComponent);
      shellHtml = await renderToStringAsync(docElement);
      shellHtml = shellHtml.replace("__NEXT_MAIN__", BODY_MARKER);
      if (ssrHeadHTML || assetTags || fontHeadHTML) {
        shellHtml = shellHtml.replace("</head>", "  " + fontHeadHTML + ssrHeadHTML + "\\n  " + assetTags + "\\n</head>");
      }
      shellHtml = shellHtml.replace("<!-- __NEXT_SCRIPTS__ -->", nextDataScript);
      if (!shellHtml.includes("__NEXT_DATA__")) {
        shellHtml = shellHtml.replace("</body>", "  " + nextDataScript + "\\n</body>");
      }
    } else {
      shellHtml = "<!DOCTYPE html>\\n<html>\\n<head>\\n  <meta charset=\\"utf-8\\" />\\n  <meta name=\\"viewport\\" content=\\"width=device-width, initial-scale=1\\" />\\n  " + fontHeadHTML + ssrHeadHTML + "\\n  " + assetTags + "\\n</head>\\n<body>\\n  <div id=\\"__next\\">" + BODY_MARKER + "</div>\\n  " + nextDataScript + "\\n</body>\\n</html>";
    }

    if (typeof setSSRContext === "function") setSSRContext(null);

    // Split the shell at the body marker
    var markerIdx = shellHtml.indexOf(BODY_MARKER);
    var shellPrefix = shellHtml.slice(0, markerIdx);
    var shellSuffix = shellHtml.slice(markerIdx + BODY_MARKER.length);

    // Start the React body stream — progressive SSR (no allReady wait)
    var bodyStream = await renderToReadableStream(element);
    var encoder = new TextEncoder();

    // Create a composite stream: prefix + body + suffix
    var compositeStream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(shellPrefix));
        var reader = bodyStream.getReader();
        try {
          for (;;) {
            var chunk = await reader.read();
            if (chunk.done) break;
            controller.enqueue(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        controller.enqueue(encoder.encode(shellSuffix));
        controller.close();
      }
    });

    // Cache the rendered HTML for ISR (needs the full string — re-render synchronously)
    if (isrRevalidateSeconds !== null && isrRevalidateSeconds > 0) {
      // Tee the stream so we can cache and respond simultaneously would be ideal,
      // but ISR responses are rare on first hit. Re-render to get complete HTML for cache.
      var isrElement;
      if (AppComponent) {
        isrElement = React.createElement(AppComponent, { Component: PageComponent, pageProps });
      } else {
        isrElement = React.createElement(PageComponent, pageProps);
      }
      var isrHtml = await renderToStringAsync(isrElement);
      var fullHtml = shellPrefix + isrHtml + shellSuffix;
      var isrPathname = url.split("?")[0];
      var isrCacheKey = "pages:" + (isrPathname === "/" ? "/" : isrPathname.replace(/\\/$/, ""));
      await isrSet(isrCacheKey, { kind: "PAGES", html: fullHtml, pageData: pageProps, headers: undefined, status: undefined }, isrRevalidateSeconds);
    }

    const responseHeaders = { "Content-Type": "text/html" };
    if (isrRevalidateSeconds) {
      responseHeaders["Cache-Control"] = "s-maxage=" + isrRevalidateSeconds + ", stale-while-revalidate";
      responseHeaders["X-Vinext-Cache"] = "MISS";
    }
    // Set HTTP Link header for font preloading
    if (_fontLinkHeader) {
      responseHeaders["Link"] = _fontLinkHeader;
    }
    return new Response(compositeStream, { status: 200, headers: responseHeaders });
  } catch (e) {
    console.error("[vinext] SSR error:", e);
    return new Response("Internal Server Error", { status: 500 });
  }
          }) // end runWithFetchCache
        ) // end runWithPrivateCache
      ) // end _runWithCacheState
    ) // end runWithHeadState
  ); // end runWithRouterState
}

export async function handleApiRoute(request, url) {
  const match = matchRoute(url, apiRoutes);
  if (!match) {
    return new Response("404 - API route not found", { status: 404 });
  }

  const { route, params } = match;
  const handler = route.module.default;
  if (typeof handler !== "function") {
    return new Response("API route does not export a default function", { status: 500 });
  }

  const query = { ...params };
  const qs = url.split("?")[1];
  if (qs) {
    for (const [k, v] of new URLSearchParams(qs)) {
      if (k in query) {
        // Multi-value: promote to array (Next.js returns string[] for duplicate keys)
        query[k] = Array.isArray(query[k]) ? query[k].concat(v) : [query[k], v];
      } else {
        query[k] = v;
      }
    }
  }

  // Parse request body (enforce 1MB limit to prevent memory exhaustion,
  // matching Next.js default bodyParser sizeLimit).
  // Check Content-Length first as a fast path, then enforce on the actual
  // stream to prevent bypasses via chunked transfer encoding.
  const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > 1 * 1024 * 1024) {
    return new Response("Request body too large", { status: 413 });
  }
  let body;
  const ct = request.headers.get("content-type") || "";
  let rawBody;
  try { rawBody = await readBodyWithLimit(request, 1 * 1024 * 1024); }
  catch { return new Response("Request body too large", { status: 413 }); }
  if (!rawBody) {
    body = undefined;
  } else if (ct.includes("application/json")) {
    try { body = JSON.parse(rawBody); } catch { body = rawBody; }
  } else {
    body = rawBody;
  }

  const { req, res, responsePromise } = createReqRes(request, url, query, body);

  try {
    await handler(req, res);
    // If handler didn't call res.end(), end it now.
    // The end() method is idempotent — safe to call twice.
    res.end();
    return await responsePromise;
  } catch (e) {
    console.error("[vinext] API error:", e);
    return new Response("Internal Server Error", { status: 500 });
  }
}

${middlewareExportCode}
`;
  }

  /**
   * Generate the virtual client hydration entry module.
   * This is the entry point for `vite build` (client bundle).
   *
   * It maps route patterns to dynamic imports of page modules so Vite
   * code-splits each page into its own chunk. At runtime it reads
   * __NEXT_DATA__ to determine which page to hydrate.
   */
  async function generateClientEntry(): Promise<string> {
    const pageRoutes = await pagesRouter(pagesDir);

    const hasApp = fs.existsSync(path.join(pagesDir, "_app.tsx")) || fs.existsSync(path.join(pagesDir, "_app.jsx")) || fs.existsSync(path.join(pagesDir, "_app.ts")) || fs.existsSync(path.join(pagesDir, "_app.js"));

    // Build a map of route pattern -> dynamic import.
    // Keys must use Next.js bracket format (e.g. "/user/[id]") to match
    // __NEXT_DATA__.page which is set via patternToNextFormat() during SSR.
    const loaderEntries = pageRoutes.map((r: Route) => {
      const absPath = r.filePath.replace(/\\/g, "/");
      const nextFormatPattern = pagesPatternToNextFormat(r.pattern);
      // JSON.stringify safely escapes quotes, backslashes, and special chars in
      // both the route pattern and the absolute file path.
      // lgtm[js/bad-code-sanitization]
      return `  ${JSON.stringify(nextFormatPattern)}: () => import(${JSON.stringify(absPath)})`;
    });

    const appFileBase = path.join(pagesDir, "_app").replace(/\\/g, "/");

    return `
import React from "react";
import { hydrateRoot } from "react-dom/client";
// Eagerly import the router shim so its module-level popstate listener is
// registered.  Without this, browser back/forward buttons do nothing because
// navigateClient() is never invoked on history changes.
import "next/router";

const pageLoaders = {
${loaderEntries.join(",\n")}
};

async function hydrate() {
  const nextData = window.__NEXT_DATA__;
  if (!nextData) {
    console.error("[vinext] No __NEXT_DATA__ found");
    return;
  }

  const { pageProps } = nextData.props;
  const loader = pageLoaders[nextData.page];
  if (!loader) {
    console.error("[vinext] No page loader for route:", nextData.page);
    return;
  }

  const pageModule = await loader();
  const PageComponent = pageModule.default;
  if (!PageComponent) {
    console.error("[vinext] Page module has no default export");
    return;
  }

  let element;
  ${hasApp ? `
  try {
    const appModule = await import(${JSON.stringify(appFileBase)});
    const AppComponent = appModule.default;
    window.__VINEXT_APP__ = AppComponent;
    element = React.createElement(AppComponent, { Component: PageComponent, pageProps });
  } catch {
    element = React.createElement(PageComponent, pageProps);
  }
  ` : `
  element = React.createElement(PageComponent, pageProps);
  `}

  const container = document.getElementById("__next");
  if (!container) {
    console.error("[vinext] No #__next element found");
    return;
  }

  const root = hydrateRoot(container, element);
  window.__VINEXT_ROOT__ = root;
}

hydrate();
`;
  }

  // Auto-register @vitejs/plugin-rsc when App Router is detected.
  // Check eagerly at call time using the same heuristic as config().
  // Must mirror the full detection logic: check {base}/app then {base}/src/app.
  const autoRsc = options.rsc !== false;
  const earlyBaseDir = options.appDir ?? process.cwd();
  const earlyAppDirExists =
    fs.existsSync(path.join(earlyBaseDir, "app")) ||
    fs.existsSync(path.join(earlyBaseDir, "src", "app"));

  // IMPORTANT: Resolve @vitejs/plugin-rsc subpath imports from the user's
  // project root, not from vinext's own package location. When vinext is
  // installed via symlink (npm file: deps, pnpm workspace:*), a bare
  // import() resolves from vinext's realpath, which can find a different
  // copy of the RSC plugin (and transitively a different copy of vite).
  // This causes instanceof RunnableDevEnvironment checks to fail at
  // runtime because the Vite server and the RSC plugin end up with
  // different class identities. Resolving from the project root ensures a
  // single shared vite instance.
  //
  // Pre-resolve both the main plugin and the /transforms subpath eagerly
  // so all import() calls in this module use consistent resolution.
  const earlyRequire = createRequire(path.join(earlyBaseDir, "package.json"));
  let resolvedRscPath: string | null = null;
  let resolvedRscTransformsPath: string | null = null;
  try {
    resolvedRscPath = earlyRequire.resolve("@vitejs/plugin-rsc");
    resolvedRscTransformsPath = earlyRequire.resolve("@vitejs/plugin-rsc/transforms");
  } catch {
    // @vitejs/plugin-rsc not installed — that's fine for Pages Router
    // projects. If App Router is detected, the error is thrown below.
  }

  // If app/ exists and auto-RSC is enabled, create a lazy Promise that
  // resolves to the configured RSC plugin array. Vite's asyncFlatten
  // will resolve this before processing the plugin list.
  let rscPluginPromise: Promise<Plugin[]> | null = null;
  if (earlyAppDirExists && autoRsc) {
    if (!resolvedRscPath) {
      throw new Error(
        "vinext: App Router detected but @vitejs/plugin-rsc is not installed.\n" +
        "Run: npm install -D @vitejs/plugin-rsc",
      );
    }
    const rscImport = import(pathToFileURL(resolvedRscPath).href);
    rscPluginPromise = rscImport
      .then((mod) => {
        const rsc = mod.default;
        return rsc({
          entries: {
            rsc: VIRTUAL_RSC_ENTRY,
            ssr: VIRTUAL_APP_SSR_ENTRY,
            client: VIRTUAL_APP_BROWSER_ENTRY,
          },
        });
      });
  }

  const imageImportDimCache = new Map<string, { width: number; height: number }>();

  const plugins: (Plugin | Promise<Plugin[]>)[] = [
    // Resolve tsconfig paths/baseUrl aliases so real-world Next.js repos
    // that use @/*, #/*, or baseUrl imports work out of the box.
    tsconfigPaths(),
    {
      name: "vinext:config",
      enforce: "pre",

      async config(config) {
        root = config.root ?? process.cwd();

        // Resolve the base directory for app/pages detection.
        // If appDir is provided, resolve it (supports both relative and absolute paths).
        // If not provided, auto-detect: check root first, then src/ subdirectory.
        let baseDir: string;
        if (options.appDir) {
          baseDir = path.isAbsolute(options.appDir)
            ? options.appDir
            : path.resolve(root, options.appDir);
        } else {
          // Auto-detect: prefer root-level app/ and pages/, fall back to src/
          const hasRootApp = fs.existsSync(path.join(root, "app"));
          const hasRootPages = fs.existsSync(path.join(root, "pages"));
          const hasSrcApp = fs.existsSync(path.join(root, "src", "app"));
          const hasSrcPages = fs.existsSync(path.join(root, "src", "pages"));

          if (hasRootApp || hasRootPages) {
            baseDir = root;
          } else if (hasSrcApp || hasSrcPages) {
            baseDir = path.join(root, "src");
          } else {
            baseDir = root;
          }
        }

        pagesDir = path.join(baseDir, "pages");
        appDir = path.join(baseDir, "app");
        hasPagesDir = fs.existsSync(pagesDir);
        hasAppDir = fs.existsSync(appDir);
        middlewarePath = findMiddlewareFile(root);
        instrumentationPath = findInstrumentationFile(root);

        // Load next.config.js if present (always from project root, not src/)
        const rawConfig = await loadNextConfig(root);
        nextConfig = await resolveNextConfig(rawConfig);

        // Merge env from next.config.js with NEXT_PUBLIC_* env vars
        const defines = getNextPublicEnvDefines();
        for (const [key, value] of Object.entries(nextConfig.env)) {
          defines[`process.env.${key}`] = JSON.stringify(value);
        }
        // Expose basePath to client-side code
        defines["process.env.__NEXT_ROUTER_BASEPATH"] = JSON.stringify(
          nextConfig.basePath,
        );
        // Expose image remote patterns for validation in next/image shim
        defines["process.env.__VINEXT_IMAGE_REMOTE_PATTERNS"] = JSON.stringify(
          JSON.stringify(nextConfig.images?.remotePatterns ?? []),
        );
        defines["process.env.__VINEXT_IMAGE_DOMAINS"] = JSON.stringify(
          JSON.stringify(nextConfig.images?.domains ?? []),
        );
        // Expose allowed image widths (union of deviceSizes + imageSizes) for
        // server-side validation. Matches Next.js behavior: only configured
        // sizes are accepted by the image optimization endpoint.
        {
          const deviceSizes = nextConfig.images?.deviceSizes ?? [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
          const imageSizes = nextConfig.images?.imageSizes ?? [16, 32, 48, 64, 96, 128, 256, 384];
          defines["process.env.__VINEXT_IMAGE_DEVICE_SIZES"] = JSON.stringify(
            JSON.stringify(deviceSizes),
          );
          defines["process.env.__VINEXT_IMAGE_SIZES"] = JSON.stringify(
            JSON.stringify(imageSizes),
          );
        }
        // Draft mode secret — generated once at build time so the
        // __prerender_bypass cookie is consistent across all server
        // instances (e.g. multiple Cloudflare Workers isolates).
        defines["process.env.__VINEXT_DRAFT_SECRET"] = JSON.stringify(
          crypto.randomUUID(),
        );

        // Build the shim alias map — used by both resolve.alias and resolveId
        // (resolveId handles .js extension variants for libraries like nuqs)
        nextShimMap = {
          "next/link": path.join(shimsDir, "link"),
          "next/head": path.join(shimsDir, "head"),
          "next/router": path.join(shimsDir, "router"),
          "next/image": path.join(shimsDir, "image"),
          "next/legacy/image": path.join(shimsDir, "legacy-image"),
          "next/dynamic": path.join(shimsDir, "dynamic"),
          "next/app": path.join(shimsDir, "app"),
          "next/document": path.join(shimsDir, "document"),
          "next/config": path.join(shimsDir, "config"),
          "next/script": path.join(shimsDir, "script"),
          "next/server": path.join(shimsDir, "server"),
          "next/navigation": path.join(shimsDir, "navigation"),
          "next/headers": path.join(shimsDir, "headers"),
          "next/font/google": path.join(shimsDir, "font-google"),
          "next/font/local": path.join(shimsDir, "font-local"),
          "next/cache": path.join(shimsDir, "cache"),
          "next/form": path.join(shimsDir, "form"),
          "next/og": path.join(shimsDir, "og"),
          "next/web-vitals": path.join(shimsDir, "web-vitals"),
          "next/amp": path.join(shimsDir, "amp"),
          "next/error": path.join(shimsDir, "error"),
          "next/constants": path.join(shimsDir, "constants"),
          // Internal next/dist/* paths used by popular libraries
          // (next-intl, @clerk/nextjs, @sentry/nextjs, next-nprogress-bar, etc.)
          "next/dist/shared/lib/app-router-context.shared-runtime": path.join(shimsDir, "internal", "app-router-context"),
          "next/dist/shared/lib/app-router-context": path.join(shimsDir, "internal", "app-router-context"),
          "next/dist/shared/lib/router-context.shared-runtime": path.join(shimsDir, "internal", "router-context"),
          "next/dist/shared/lib/utils": path.join(shimsDir, "internal", "utils"),
          "next/dist/server/api-utils": path.join(shimsDir, "internal", "api-utils"),
          "next/dist/server/web/spec-extension/cookies": path.join(shimsDir, "internal", "cookies"),
          "next/dist/compiled/@edge-runtime/cookies": path.join(shimsDir, "internal", "cookies"),
          "next/dist/server/app-render/work-unit-async-storage.external": path.join(shimsDir, "internal", "work-unit-async-storage"),
          "next/dist/client/components/work-unit-async-storage.external": path.join(shimsDir, "internal", "work-unit-async-storage"),
          "next/dist/client/components/request-async-storage.external": path.join(shimsDir, "internal", "work-unit-async-storage"),
          "next/dist/client/components/request-async-storage": path.join(shimsDir, "internal", "work-unit-async-storage"),
          // Re-export public modules for internal path imports
          "next/dist/client/components/navigation": path.join(shimsDir, "navigation"),
          "next/dist/server/config-shared": path.join(shimsDir, "internal", "utils"),
          // server-only / client-only marker packages
          "server-only": path.join(shimsDir, "server-only"),
          "client-only": path.join(shimsDir, "client-only"),
          "vinext/error-boundary": path.join(shimsDir, "error-boundary"),
          "vinext/layout-segment-context": path.join(shimsDir, "layout-segment-context"),
          "vinext/metadata": path.join(shimsDir, "metadata"),
          "vinext/fetch-cache": path.join(shimsDir, "fetch-cache"),
          "vinext/cache-runtime": path.join(shimsDir, "cache-runtime"),
          "vinext/navigation-state": path.join(shimsDir, "navigation-state"),
          "vinext/router-state": path.join(shimsDir, "router-state"),
          "vinext/head-state": path.join(shimsDir, "head-state"),
          "vinext/instrumentation": path.resolve(__dirname, "server", "instrumentation"),
          "vinext/html": path.resolve(__dirname, "server", "html"),
        };

        // Detect if Cloudflare's vite plugin is present — if so, skip
        // SSR externals (Workers bundle everything, can't have Node.js externals).
        const pluginsFlat: any[] = [];
        function flattenPlugins(arr: any[]) {
          for (const p of arr) {
            if (Array.isArray(p)) flattenPlugins(p);
            else if (p) pluginsFlat.push(p);
          }
        }
        flattenPlugins(config.plugins as any[] ?? []);
        hasCloudflarePlugin = pluginsFlat.some(
          (p: any) => p && typeof p === "object" && typeof p.name === "string" && (
            p.name === "vite-plugin-cloudflare" || p.name.startsWith("vite-plugin-cloudflare:")
          ),
        );

        // Resolve PostCSS string plugin names that Vite can't handle.
        // Next.js projects commonly use array-form plugins like
        // `plugins: ["@tailwindcss/postcss"]` which postcss-load-config
        // doesn't resolve (only object-form keys are resolved). We detect
        // this and resolve the strings to actual plugin functions, then
        // inject via css.postcss so Vite uses the resolved plugins.
        // Only do this if the user hasn't already set css.postcss inline.
        let postcssOverride: { plugins: any[] } | undefined;
        if (!config.css?.postcss || typeof config.css.postcss === "string") {
          postcssOverride = await resolvePostcssStringPlugins(root);
        }

        // Auto-inject @mdx-js/rollup when MDX files exist and no MDX plugin is
        // already configured. Applies remark/rehype plugins from next.config.
        const hasMdxPlugin = pluginsFlat.some(
          (p: any) => p && typeof p === "object" && typeof p.name === "string" &&
            (p.name === "@mdx-js/rollup" || p.name === "mdx"),
        );
        const mdxPlugins: any[] = [];
        if (!hasMdxPlugin && hasMdxFiles(root, hasAppDir ? appDir : null, hasPagesDir ? pagesDir : null)) {
          try {
            const mdxRollup = await import("@mdx-js/rollup");
            const mdxPlugin = mdxRollup.default ?? mdxRollup;
            const mdxOpts: Record<string, unknown> = {};
            if (nextConfig.mdx) {
              if (nextConfig.mdx.remarkPlugins) mdxOpts.remarkPlugins = nextConfig.mdx.remarkPlugins;
              if (nextConfig.mdx.rehypePlugins) mdxOpts.rehypePlugins = nextConfig.mdx.rehypePlugins;
              if (nextConfig.mdx.recmaPlugins) mdxOpts.recmaPlugins = nextConfig.mdx.recmaPlugins;
            }
            mdxPlugins.push(mdxPlugin(mdxOpts));
            if (nextConfig.mdx) {
              console.log("[vinext] Auto-injected @mdx-js/rollup with remark/rehype plugins from next.config");
            } else {
              console.log("[vinext] Auto-injected @mdx-js/rollup for MDX support");
            }
          } catch {
            // @mdx-js/rollup not installed — warn but don't fail
            console.warn(
              "[vinext] MDX files detected but @mdx-js/rollup is not installed. " +
              "Install it with: npm install -D @mdx-js/rollup"
            );
          }
        }

        // Detect if this is a standalone SSR build (set by `vite build --ssr`
        // or `build.ssr` in config). SSR builds must NOT use manualChunks
        // because they use inlineDynamicImports which is incompatible.
        const isSSR = !!config.build?.ssr;
        // Detect if this is a multi-environment build (App Router or Cloudflare).
        // In multi-env builds, manualChunks must only be set per-environment
        // (on the client env), not globally — otherwise it leaks into RSC/SSR
        // environments where it can cause asset resolution issues.
        const isMultiEnv = hasAppDir || hasCloudflarePlugin;

        const viteConfig: UserConfig = {
          // Disable Vite's default HTML serving - we handle all routing
          appType: "custom",
          build: {
            rollupOptions: {
              // Suppress "Module level directives cause errors when bundled"
              // warnings for "use client" / "use server" directives. Our shims
              // and third-party libraries legitimately use these directives;
              // they are handled by the RSC plugin and are harmless in the
              // final bundle. We preserve any user-supplied onwarn so custom
              // warning handling is not lost.
              onwarn: (() => {
                const userOnwarn = config.build?.rollupOptions?.onwarn;
                return (warning, defaultHandler) => {
                  if (
                    warning.code === "MODULE_LEVEL_DIRECTIVE" &&
                    (warning.message?.includes('"use client"') ||
                      warning.message?.includes('"use server"'))
                  ) {
                    return;
                  }
                  if (userOnwarn) {
                    userOnwarn(warning, defaultHandler);
                  } else {
                    defaultHandler(warning);
                  }
                };
              })(),
              // Enable aggressive tree-shaking for client builds.
              // See clientTreeshakeConfig for rationale.
              // Only apply globally for standalone client builds (Pages Router
              // CLI). For multi-environment builds (App Router, Cloudflare),
              // treeshake is set per-environment on the client env below to
              // avoid leaking into RSC/SSR environments where
              // moduleSideEffects: 'no-external' could drop server packages
              // that rely on module-level side effects.
              ...(!isSSR && !isMultiEnv ? { treeshake: clientTreeshakeConfig } : {}),
              // Code-split client bundles: separate framework (React/ReactDOM),
              // vinext runtime (shims), and vendor packages into their own
              // chunks so pages only load the JS they need.
              // Only apply globally for standalone client builds (CLI Pages
              // Router). For multi-environment builds (App Router, Cloudflare),
              // manualChunks is set per-environment on the client env below
              // to avoid leaking into RSC/SSR environments.
              ...(!isSSR && !isMultiEnv ? { output: clientOutputConfig } : {}),
            },
          },
          // Let OPTIONS requests pass through Vite's CORS middleware to our
          // route handlers so they can set the Allow header and run user-defined
          // OPTIONS handlers. Without this, Vite's CORS middleware responds to
          // OPTIONS with a 204 before the request reaches vinext's handler.
          // Keep Vite's default restrictive origin policy by explicitly
          // setting it. Without the `origin` field, `preflightContinue: true`
          // would override Vite's default and allow any origin.
          server: {
            cors: {
              preflightContinue: true,
              origin: /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/,
            },
          },
          // Externalize React packages from SSR transform — they are CJS and
          // must be loaded natively by Node, not through Vite's ESM evaluator.
          // Skip when targeting Cloudflare Workers (they bundle everything).
          ...(hasCloudflarePlugin ? {} : {
            ssr: {
              external: ["react", "react-dom", "react-dom/server"],
            },
          }),
          resolve: {
            alias: nextShimMap,
            // Dedupe React packages to prevent dual-instance errors.
            // When vinext is linked (npm link / bun link) or any dependency
            // brings its own React copy, multiple React instances can load,
            // causing cryptic "Invalid hook call" errors. This is a no-op
            // when only one copy exists.
            dedupe: [
              "react",
              "react-dom",
              "react/jsx-runtime",
              "react/jsx-dev-runtime",
            ],
          },
          // Exclude vinext from dependency optimization so esbuild doesn't
          // scan dist files containing virtual module imports (virtual:vinext-*)
          // that only resolve at Vite plugin time, not during pre-bundling.
          optimizeDeps: {
            exclude: ["vinext"],
          },
          // Enable JSX in .tsx/.jsx files
          // Vite 7 uses `esbuild` for transforms, Vite 8+ uses `oxc`
          ...(getViteMajorVersion() >= 8
            ? { oxc: { jsx: { runtime: "automatic" } } }
            : { esbuild: { jsx: "automatic" } }),
          // Define env vars for client bundle
          define: defines,
          // Set base path if configured
          ...(nextConfig.basePath ? { base: nextConfig.basePath + "/" } : {}),
          // Inject resolved PostCSS plugins if string names were found
          ...(postcssOverride ? { css: { postcss: postcssOverride } } : {}),
        };

        // If app/ directory exists, configure RSC environments
        if (hasAppDir) {
          // Compute optimizeDeps.entries so Vite discovers server-side
          // dependencies at startup instead of on first request. Without
          // this, deps imported in rsc/ssr environments are found lazily,
          // causing re-optimisation cascades and runtime errors (e.g.
          // "Invalid hook call" from duplicate React instances).
          // The entries must be relative to the project root.
          const relAppDir = path.relative(root, appDir);
          const appEntries = [
            `${relAppDir}/**/*.{tsx,ts,jsx,js}`,
          ];

          viteConfig.environments = {
            rsc: {
              ...(hasCloudflarePlugin ? {} : {
                resolve: {
                  // Externalize native/heavy packages so the RSC environment
                  // loads them natively via Node rather than through Vite's
                  // ESM module evaluator (which can't handle native addons).
                  // Note: Do NOT externalize react/react-dom here — they must
                  // be bundled with the "react-server" condition for RSC.
                  // Skip when targeting Cloudflare Workers.
                  external: [
                    "satori",
                    "@resvg/resvg-js",
                    "yoga-wasm-web",
                  ],
                },
              }),
              optimizeDeps: {
                exclude: ["vinext"],
                entries: appEntries,
              },
              build: {
                outDir: "dist/server",
                rollupOptions: {
                  input: { index: VIRTUAL_RSC_ENTRY },
                },
              },
            },
            ssr: {
              optimizeDeps: {
                exclude: ["vinext"],
                entries: appEntries,
              },
              build: {
                outDir: "dist/server/ssr",
                rollupOptions: {
                  input: { index: VIRTUAL_APP_SSR_ENTRY },
                },
              },
            },
            client: {
              optimizeDeps: {
                exclude: ["vinext"],
                // react and react-dom are framework dependencies used for
                // hydration. They aren't crawled from app/ source files so
                // must be pre-included to prevent late discovery and page
                // reloads during development.
                include: ["react", "react-dom", "react-dom/client"],
              },
              build: {
                // When targeting Cloudflare Workers, enable manifest generation
                // so the vinext:cloudflare-build closeBundle hook can read the
                // client build manifest, compute lazy chunks (only reachable
                // via dynamic imports), and inject __VINEXT_LAZY_CHUNKS__ into
                // the worker entry. Without this, all chunks are modulepreloaded
                // on every page — defeating code-splitting for React.lazy() and
                // next/dynamic boundaries.
                ...(hasCloudflarePlugin ? { manifest: true } : {}),
                rollupOptions: {
                  input: { index: VIRTUAL_APP_BROWSER_ENTRY },
                  output: clientOutputConfig,
                  treeshake: clientTreeshakeConfig,
                },
              },
            },
          };
        } else if (hasCloudflarePlugin) {
          // Pages Router on Cloudflare Workers: add a client environment
          // so the multi-environment build produces client JS bundles
          // alongside the worker. Without this, only the worker is built
          // and there's no client-side hydration.
          viteConfig.environments = {
            client: {
              build: {
                manifest: true,
                ssrManifest: true,
                rollupOptions: {
                  input: { index: VIRTUAL_CLIENT_ENTRY },
                  output: clientOutputConfig,
                  treeshake: clientTreeshakeConfig,
                },
              },
            },
          };
        }

        // Add auto-injected MDX plugin if needed
        if (mdxPlugins.length > 0) {
          viteConfig.plugins = mdxPlugins;
        }

        return viteConfig;
      },

      configResolved(config) {
        // Detect double RSC plugin registration. When vinext auto-injects
        // @vitejs/plugin-rsc AND the user also registers it manually, the
        // RSC transform pipeline runs twice — doubling build time.
        // Rather than trying to magically fix this at runtime, fail fast
        // with a clear error telling the user how to fix their config.
        if (rscPluginPromise) {
          // Count top-level RSC plugins (name === "rsc") — each call to
          // the rsc() factory produces exactly one plugin with this name.
          const rscRootPlugins = config.plugins.filter(
            (p: any) => p && p.name === "rsc",
          );
          if (rscRootPlugins.length > 1) {
            throw new Error(
              "[vinext] Duplicate @vitejs/plugin-rsc detected.\n" +
              "         vinext auto-registers @vitejs/plugin-rsc when app/ is detected.\n" +
              "         Your config also registers it manually, which doubles build time.\n\n" +
              "         Fix: remove the explicit rsc() call from your plugins array.\n" +
              "         Or: pass rsc: false to vinext() if you want to configure rsc() yourself.",
            );
          }
        }
      },

      resolveId: {
        // Hook filter: only invoke JS for next/* imports and virtual:vinext-* modules.
        // Matches "next/navigation", "next/router.js", "virtual:vinext-rsc-entry",
        // and \0-prefixed re-imports from @vitejs/plugin-rsc.
        filter: {
          id: /(?:next\/|virtual:vinext-)/,
        },
        handler(id) {
          // Strip \0 prefix if present — @vitejs/plugin-rsc's generated
          // browser entry imports our virtual module using the already-resolved
          // ID (with \0 prefix). We need to re-resolve it so the client
          // environment's import-analysis can find it.
          const cleanId = id.startsWith("\0") ? id.slice(1) : id;

          // Handle next/* imports with .js extension (e.g. "next/navigation.js")
          // Libraries like nuqs import "next/navigation.js" which doesn't match
          // our resolve.alias for "next/navigation". Strip the .js and resolve
          // through our shim map, appending .js to the resolved path.
          if (cleanId.startsWith("next/") && cleanId.endsWith(".js")) {
            const withoutExt = cleanId.slice(0, -3);
            if (nextShimMap[withoutExt]) {
              const shimPath = nextShimMap[withoutExt];
              // Alias values don't include .js — append it for resolveId
              return shimPath.endsWith(".js") ? shimPath : shimPath + ".js";
            }
          }

          // Pages Router virtual modules
          if (cleanId === VIRTUAL_SERVER_ENTRY) return RESOLVED_SERVER_ENTRY;
          if (cleanId === VIRTUAL_CLIENT_ENTRY) return RESOLVED_CLIENT_ENTRY;
          if (cleanId.endsWith("/" + VIRTUAL_SERVER_ENTRY) || cleanId.endsWith("\\" + VIRTUAL_SERVER_ENTRY)) {
            return RESOLVED_SERVER_ENTRY;
          }
          if (cleanId.endsWith("/" + VIRTUAL_CLIENT_ENTRY) || cleanId.endsWith("\\" + VIRTUAL_CLIENT_ENTRY)) {
            return RESOLVED_CLIENT_ENTRY;
          }
          // App Router virtual modules
          if (cleanId === VIRTUAL_RSC_ENTRY) return RESOLVED_RSC_ENTRY;
          if (cleanId === VIRTUAL_APP_SSR_ENTRY) return RESOLVED_APP_SSR_ENTRY;
          if (cleanId === VIRTUAL_APP_BROWSER_ENTRY) return RESOLVED_APP_BROWSER_ENTRY;
          if (cleanId.endsWith("/" + VIRTUAL_RSC_ENTRY) || cleanId.endsWith("\\" + VIRTUAL_RSC_ENTRY)) {
            return RESOLVED_RSC_ENTRY;
          }
          if (cleanId.endsWith("/" + VIRTUAL_APP_SSR_ENTRY) || cleanId.endsWith("\\" + VIRTUAL_APP_SSR_ENTRY)) {
            return RESOLVED_APP_SSR_ENTRY;
          }
          if (cleanId.endsWith("/" + VIRTUAL_APP_BROWSER_ENTRY) || cleanId.endsWith("\\" + VIRTUAL_APP_BROWSER_ENTRY)) {
            return RESOLVED_APP_BROWSER_ENTRY;
          }
        },
      },

      async load(id) {
        // Pages Router virtual modules
        if (id === RESOLVED_SERVER_ENTRY) {
          return await generateServerEntry();
        }
        if (id === RESOLVED_CLIENT_ENTRY) {
          return await generateClientEntry();
        }
        // App Router virtual modules
        if (id === RESOLVED_RSC_ENTRY && hasAppDir) {
          const routes = await appRouter(appDir);
          const metaRoutes = scanMetadataFiles(appDir);
          // Check for global-error.tsx at app root
          const globalErrorPath = findFileWithExts(appDir, "global-error");
          return generateRscEntry(appDir, routes, middlewarePath, metaRoutes, globalErrorPath, nextConfig?.basePath, nextConfig?.trailingSlash, {
            redirects: nextConfig?.redirects,
            rewrites: nextConfig?.rewrites,
            headers: nextConfig?.headers,
            allowedOrigins: nextConfig?.serverActionsAllowedOrigins,
            allowedDevOrigins: nextConfig?.serverActionsAllowedOrigins,
          });
        }
        if (id === RESOLVED_APP_SSR_ENTRY && hasAppDir) {
          return generateSsrEntry();
        }
        if (id === RESOLVED_APP_BROWSER_ENTRY && hasAppDir) {
          return generateBrowserEntry();
        }
      },
    },
    // Shim React canary/experimental APIs (ViewTransition, addTransitionType)
    // that exist in Next.js's bundled React canary but not in stable React 19.
    // Provides graceful no-op fallbacks so projects using these APIs degrade
    // instead of crashing with "does not provide an export named 'ViewTransition'".
    {
      name: "vinext:react-canary",
      enforce: "pre",

      resolveId(id) {
        if (id === "virtual:vinext-react-canary") return "\0virtual:vinext-react-canary";
      },

      load(id) {
        if (id === "\0virtual:vinext-react-canary") {
          return [
            `export * from "react";`,
            `export { default } from "react";`,
            `import * as _React from "react";`,
            `export const ViewTransition = _React.ViewTransition || function ViewTransition({ children }) { return children; };`,
            `export const addTransitionType = _React.addTransitionType || function addTransitionType() {};`,
          ].join("\n");
        }
      },

      transform(code, id) {
        // Only transform user source files, not node_modules or virtual modules
        if (id.includes("node_modules")) return null;
        if (id.startsWith("\0")) return null;
        if (!/\.(tsx?|jsx?|mjs)$/.test(id)) return null;

        // Quick check: does this file reference canary APIs and import from "react"?
        if (
          !(code.includes("ViewTransition") || code.includes("addTransitionType")) ||
          !/from\s+['"]react['"]/.test(code)
        ) {
          return null;
        }

        // Only rewrite if the import actually destructures a canary API
        const canaryImportRegex = /import\s*\{[^}]*(ViewTransition|addTransitionType)[^}]*\}\s*from\s*['"]react['"]/;
        if (!canaryImportRegex.test(code)) return null;

        // Rewrite all `from "react"` / `from 'react'` to use the canary shim.
        // This is safe because the virtual module re-exports everything from
        // react, so non-canary imports continue to work.
        const result = code.replace(
          /from\s*['"]react['"]/g,
          'from "virtual:vinext-react-canary"',
        );
        if (result !== code) {
          return { code: result, map: null };
        }
        return null;
      },
    },
    {
      name: "vinext:pages-router",

      // HMR: trigger full-reload for Pages Router page changes.
      // Without @vitejs/plugin-react (React Fast Refresh), component edits
      // can't be hot-updated. In theory Vite's default propagation should
      // reach the root and trigger a full-reload, but the Pages Router
      // injects hydration via inline <script type="module"> which may not
      // be tracked in the module graph. Explicitly sending full-reload
      // ensures changes are always reflected in the browser.
      hotUpdate(options: { file: string; server: ViteDevServer; modules: any[] }) {
        if (!hasPagesDir || hasAppDir) return;
        const ext = /\.(tsx?|jsx?|mdx)$/;
        if (options.file.startsWith(pagesDir) && ext.test(options.file)) {
          options.server.environments.client.hot.send({ type: "full-reload" });
          return [];
        }
      },

      configureServer(server: ViteDevServer) {
        // Watch pages directory for file additions/removals to invalidate route cache.
        const pageExtensions = /\.(tsx?|jsx?|mdx)$/;
        server.watcher.on("add", (filePath: string) => {
          if (hasPagesDir && filePath.startsWith(pagesDir) && pageExtensions.test(filePath)) {
            invalidateRouteCache(pagesDir);
          }
          if (hasAppDir && filePath.startsWith(appDir) && pageExtensions.test(filePath)) {
            invalidateAppRouteCache();
          }
        });
        server.watcher.on("unlink", (filePath: string) => {
          if (hasPagesDir && filePath.startsWith(pagesDir) && pageExtensions.test(filePath)) {
            invalidateRouteCache(pagesDir);
          }
          if (hasAppDir && filePath.startsWith(appDir) && pageExtensions.test(filePath)) {
            invalidateAppRouteCache();
          }
        });

        // Run instrumentation.ts register() if present (once at server startup)
        if (instrumentationPath) {
          runInstrumentation(server, instrumentationPath).catch((err) => {
            console.error("[vinext] Instrumentation error:", err);
          });
        }

        // Return a function to register middleware AFTER Vite's built-in middleware
        return () => {
          server.middlewares.use(async (req, res, next) => {
            try {
              let url: string = req.url ?? "/";

              // If no pages directory, skip this middleware entirely
              // (app router is handled by @vitejs/plugin-rsc's built-in middleware)
              if (!hasPagesDir) return next();

              // Skip Vite internal requests and static files
              if (
                url.startsWith("/@") ||
                url.startsWith("/__vite") ||
                url.startsWith("/node_modules")
              ) {
                return next();
              }

              // Skip .rsc requests — those are for the App Router RSC handler
              if (url.split("?")[0].endsWith(".rsc")) {
                return next();
              }

              // ── Cross-origin request protection ─────────────────────────
              // Block requests from non-localhost origins to prevent
              // cross-origin data exfiltration from the dev server.
              const blockReason = validateDevRequest(
                {
                  origin: req.headers.origin as string | undefined,
                  host: req.headers.host,
                  "x-forwarded-host": req.headers["x-forwarded-host"] as string | undefined,
                  "sec-fetch-site": req.headers["sec-fetch-site"] as string | undefined,
                  "sec-fetch-mode": req.headers["sec-fetch-mode"] as string | undefined,
                },
                nextConfig?.serverActionsAllowedOrigins,
              );
              if (blockReason) {
                console.warn(`[vinext] Blocked dev request: ${blockReason} (${url})`);
                res.writeHead(403, { "Content-Type": "text/plain" });
                res.end("Forbidden");
                return;
              }

              // ── Image optimization passthrough (dev mode) ─────────────
              // In dev, redirect to the original asset URL so Vite serves it.
              if (url.split("?")[0] === "/_vinext/image") {
                const imgParams = new URLSearchParams(url.split("?")[1] ?? "");
                const rawImgUrl = imgParams.get("url");
                // Normalize backslashes: browsers and the URL constructor treat
                // /\evil.com as //evil.com, bypassing the // check.
                const imgUrl = rawImgUrl?.replaceAll("\\", "/") ?? null;
                // Allowlist: must start with "/" but not "//" — blocks absolute
                // URLs, protocol-relative, backslash variants, and exotic schemes.
                if (!imgUrl || !imgUrl.startsWith("/") || imgUrl.startsWith("//")) {
                  res.writeHead(400);
                  res.end(!rawImgUrl ? "Missing url parameter" : "Only relative URLs allowed");
                  return;
                }
                // Validate the constructed URL's origin hasn't changed (defense in depth).
                const resolvedImg = new URL(imgUrl, `http://${req.headers.host || "localhost"}`);
                if (resolvedImg.origin !== `http://${req.headers.host || "localhost"}`) {
                  res.writeHead(400);
                  res.end("Only relative URLs allowed");
                  return;
                }
                res.writeHead(302, { Location: imgUrl });
                res.end();
                return;
              }

              // Vite's built-in middleware may rewrite "/" to "/index.html".
              // Normalize it back so our router can match correctly.
              const rawPathname = url.split("?")[0];
              if (rawPathname.endsWith("/index.html")) {
                url = url.replace("/index.html", "/");
              } else if (rawPathname.endsWith(".html")) {
                // Strip .html extensions (e.g. "/about.html" -> "/about")
                url = url.replace(/\.html(?=\?|$)/, "");
              }

              // Skip requests for files with extensions (static assets)
              let pathname = url.split("?")[0];
              if (pathname.includes(".") && !pathname.endsWith(".html")) {
                return next();
              }

              // Guard against protocol-relative URL open redirects.
              // Normalize backslashes first: browsers treat /\ as // in URL
              // context. Check the RAW pathname before normalizePath so the
              // guard fires before normalizePath collapses //.
              pathname = pathname.replaceAll("\\", "/");
              if (pathname.startsWith("//")) {
                res.writeHead(404);
                res.end("404 Not Found");
                return;
              }

              // Normalize the pathname to prevent path-confusion attacks.
              // decodeURIComponent prevents /%61dmin bypassing /admin matchers.
              // normalizePath collapses // and resolves . / .. segments.
              try {
                pathname = normalizePath(decodeURIComponent(pathname));
              } catch {
                // Malformed percent-encoding (e.g. /%E0%A4%A) — return 400 instead of crashing.
                res.writeHead(400);
                res.end("Bad Request");
                return;
              }

              // Strip basePath prefix from URL for route matching.
              // All internal routing uses basePath-free paths.
              //
              // NOTE: When basePath is set, we also set Vite's `base` config to
              // `basePath + "/"`. Vite's connect middleware stack strips the base
              // prefix from req.url before passing it to our middleware, so the
              // URL will already lack the basePath prefix. We still attempt to
              // strip it (for robustness) but don't reject paths that don't start
              // with basePath — Vite has already done the filtering.
              const bp = nextConfig?.basePath ?? "";
              if (bp && pathname.startsWith(bp)) {
                const stripped = pathname.slice(bp.length) || "/";
                const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
                url = stripped + qs;
                pathname = stripped;
              }

              // Normalize trailing slash based on next.config.js trailingSlash setting.
              // Redirect to the canonical form if needed.
              if (nextConfig && pathname !== "/" && !pathname.startsWith("/api")) {
                const hasTrailing = pathname.endsWith("/");
                if (nextConfig.trailingSlash && !hasTrailing) {
                  // trailingSlash: true — redirect /about → /about/
                  const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
                  const dest = bp + pathname + "/" + qs;
                  res.writeHead(308, { Location: dest });
                  res.end();
                  return;
                } else if (!nextConfig.trailingSlash && hasTrailing) {
                  // trailingSlash: false (default) — redirect /about/ → /about
                  const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
                  const dest = bp + pathname.replace(/\/+$/, "") + qs;
                  res.writeHead(308, { Location: dest });
                  res.end();
                  return;
                }
              }

              // Run middleware.ts if present
              if (middlewarePath) {
                // Only trust X-Forwarded-Proto when behind a trusted proxy
                const devTrustProxy = process.env.VINEXT_TRUST_PROXY === "1" || (process.env.VINEXT_TRUSTED_HOSTS ?? "").split(",").some(h => h.trim());
                const rawProto = devTrustProxy
                  ? String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
                  : "";
                const mwProto = rawProto === "https" || rawProto === "http" ? rawProto : "http";
                const origin = `${mwProto}://${req.headers.host || "localhost"}`;
                const middlewareRequest = new Request(new URL(url, origin), {
                  method: req.method,
                  headers: Object.fromEntries(
                    Object.entries(req.headers)
                      .filter(([, v]) => v !== undefined)
                      .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)])
                  ),
                });
                const result = await runMiddleware(server, middlewarePath, middlewareRequest);

                if (!result.continue) {
                  if (result.redirectUrl) {
                    res.writeHead(result.redirectStatus ?? 307, {
                      Location: result.redirectUrl,
                    });
                    res.end();
                    return;
                  }
                  if (result.response) {
                    res.statusCode = result.response.status;
                    for (const [key, value] of result.response.headers) {
                      res.appendHeader(key, value);
                    }
                    const body = await result.response.text();
                    res.end(body);
                    return;
                  }
                }

                // Apply middleware response headers
                if (result.responseHeaders) {
                  for (const [key, value] of result.responseHeaders) {
                    res.appendHeader(key, value);
                  }
                }

                // Apply middleware rewrite (URL and optional status code)
                if (result.rewriteUrl) {
                  url = result.rewriteUrl;
                }
                if (result.rewriteStatus) {
                  (req as any).__vinextRewriteStatus = result.rewriteStatus;
                }
              }

              // Apply custom headers from next.config.js
              if (nextConfig?.headers.length) {
                applyHeaders(pathname, res, nextConfig.headers);
              }

              // Apply redirects from next.config.js
              if (nextConfig?.redirects.length) {
                const redirected = applyRedirects(
                  pathname,
                  res,
                  nextConfig.redirects,
                );
                if (redirected) return;
              }

              // Apply rewrites from next.config.js (beforeFiles)
              let resolvedUrl = url;
              if (nextConfig?.rewrites.beforeFiles.length) {
                resolvedUrl =
                  applyRewrites(pathname, nextConfig.rewrites.beforeFiles) ??
                  url;
              }

              // External rewrite from beforeFiles — proxy to external URL
              if (isExternalUrl(resolvedUrl)) {
                await proxyExternalRewriteNode(req, res, resolvedUrl);
                return;
              }

              // Handle API routes first (pages/api/*)
              const resolvedPathname = resolvedUrl.split("?")[0];
              if (
                resolvedPathname.startsWith("/api/") ||
                resolvedPathname === "/api"
              ) {
                const apiRoutes = await apiRouter(pagesDir);
                const handled = await handleApiRoute(
                  server,
                  req,
                  res,
                  resolvedUrl,
                  apiRoutes,
                );
                if (handled) return;
                // No API route matched — fall through to 404
                res.statusCode = 404;
                res.end("404 - API route not found");
                return;
              }

              const routes = await pagesRouter(pagesDir);

              // Apply afterFiles rewrites — these run after initial route matching
              // If beforeFiles already rewrote the URL, afterFiles still run on the
              // *resolved* pathname. Next.js applies these when route matching succeeds
              // but allows overriding with rewrites.
              if (nextConfig?.rewrites.afterFiles.length) {
                const afterRewrite = applyRewrites(
                  resolvedUrl.split("?")[0],
                  nextConfig.rewrites.afterFiles,
                );
                if (afterRewrite) resolvedUrl = afterRewrite;
              }

              // External rewrite from afterFiles — proxy to external URL
              if (isExternalUrl(resolvedUrl)) {
                await proxyExternalRewriteNode(req, res, resolvedUrl);
                return;
              }

              const handler = createSSRHandler(server, routes, pagesDir, nextConfig?.i18n);
              const mwStatus = (req as any).__vinextRewriteStatus as number | undefined;

              // Try rendering the resolved URL
              const match = matchRoute(resolvedUrl.split("?")[0], routes);
              if (match) {
                await handler(req, res, resolvedUrl, mwStatus);
                return;
              }

              // No route matched — try fallback rewrites
              if (nextConfig?.rewrites.fallback.length) {
                const fallbackRewrite = applyRewrites(
                  resolvedUrl.split("?")[0],
                  nextConfig.rewrites.fallback,
                );
                if (fallbackRewrite) {
                  // External fallback rewrite — proxy to external URL
                  if (isExternalUrl(fallbackRewrite)) {
                    await proxyExternalRewriteNode(req, res, fallbackRewrite);
                    return;
                  }
                  await handler(req, res, fallbackRewrite, mwStatus);
                  return;
                }
              }

              // No fallback matched — render as-is (will hit 404 handler)
              await handler(req, res, resolvedUrl, mwStatus);
            } catch (e) {
              next(e);
            }
          });
        };
      },
    },
    // Local image import transform:
    // When a source file imports a local image (e.g., `import hero from './hero.jpg'`),
    // this plugin transforms the default import to a StaticImageData object with
    // { src, width, height } so the next/image shim can set correct dimensions
    // on <img> tags, preventing CLS.
    //
    // Vite's default image import returns a URL string. We intercept this by
    // adding a `?vinext-meta` suffix: the original import gets the URL from Vite,
    // and we resolve the `?vinext-meta` virtual module to provide dimensions.
    {
      name: "vinext:image-imports",
      enforce: "pre",

      // Cache of image dimensions to avoid re-reading files
      _dimCache: imageImportDimCache,

      resolveId: {
        filter: { id: /\?vinext-meta$/ },
        handler(source, _importer) {
          if (!source.endsWith("?vinext-meta")) return null;
          // Resolve the real image path from the importer
          const realPath = source.replace("?vinext-meta", "");
          return `\0vinext-image-meta:${realPath}`;
        },
      },

      async load(id) {
        if (!id.startsWith("\0vinext-image-meta:")) return null;
        const imagePath = id.replace("\0vinext-image-meta:", "");

        // Read from cache first
        const cache = imageImportDimCache;
        let dims = cache.get(imagePath);
        if (!dims) {
          try {
            const { imageSize } = await import("image-size");
            const buffer = fs.readFileSync(imagePath);
            const result = imageSize(buffer);
            dims = { width: result.width ?? 0, height: result.height ?? 0 };
            cache.set(imagePath, dims);
          } catch {
            dims = { width: 0, height: 0 };
          }
        }

        return `export default ${JSON.stringify(dims)};`;
      },

      transform: {
        // Hook filter: Rolldown evaluates these on the Rust side, skipping
        // the JS handler entirely for files that don't match.
        filter: {
          id: {
            include: /\.(tsx?|jsx?|mjs)$/,
            exclude: /node_modules/,
          },
          code: new RegExp(`import\\s+\\w+\\s+from\\s+['"][^'"]+\\.(${IMAGE_EXTS})['"]`),
        },
        async handler(code, id) {
          // Defensive guard — duplicates filter logic
          if (id.includes("node_modules")) return null;
          if (id.startsWith("\0")) return null;
          if (!id.match(/\.(tsx?|jsx?|mjs)$/)) return null;

          const imageImportRe = new RegExp(`import\\s+(\\w+)\\s+from\\s+['"]([^'"]+\\.(${IMAGE_EXTS}))['"];?`, "g");
          if (!imageImportRe.test(code)) return null;

          imageImportRe.lastIndex = 0;

          const s = new MagicString(code);
          let hasChanges = false;

          let match;
          while ((match = imageImportRe.exec(code)) !== null) {
            const [fullMatch, varName, importPath] = match;
            const matchStart = match.index;
            const matchEnd = matchStart + fullMatch.length;

            // Resolve the absolute path of the image
            const dir = path.dirname(id);
            const absImagePath = path.resolve(dir, importPath);

            if (!fs.existsSync(absImagePath)) continue;

            // Replace the single import with two:
            // 1. Original import (Vite gives us the URL string)
            // 2. Meta import (we provide { width, height })
            // Combined into a StaticImageData object
            const urlVar = `__vinext_img_url_${varName}`;
            const metaVar = `__vinext_img_meta_${varName}`;
            const replacement =
              `import ${urlVar} from ${JSON.stringify(importPath)};\n` +
              `import ${metaVar} from ${JSON.stringify(absImagePath + "?vinext-meta")};\n` +
              `const ${varName} = { src: ${urlVar}, width: ${metaVar}.width, height: ${metaVar}.height };`;

            s.overwrite(matchStart, matchEnd, replacement);
            hasChanges = true;
          }

          if (!hasChanges) return null;

          return {
            code: s.toString(),
            map: s.generateMap({ hires: "boundary" }),
          };
        },
      },
    } as Plugin & { _dimCache: Map<string, { width: number; height: number }> },
    // Google Fonts self-hosting:
    // During production builds, fetches Google Fonts CSS + .woff2 files,
    // caches them locally in .vinext/fonts/, and rewrites font constructor
    // calls to pass _selfHostedCSS with @font-face rules pointing at local assets.
    // In dev mode, this plugin is a no-op (CDN loading is used instead).
    {
      name: "vinext:google-fonts",
      enforce: "pre",

      _isBuild: false,
      _fontCache: new Map<string, string>(), // url -> local @font-face CSS
      _cacheDir: "",

      configResolved(config) {
        (this as any)._isBuild = config.command === "build";
        (this as any)._cacheDir = path.join(config.root, ".vinext", "fonts");
      },

      transform: {
        // Hook filter: only invoke JS when code contains 'next/font/google'.
        // The _isBuild runtime check can't be expressed as a filter, but this
        // still eliminates nearly all Rust-to-JS calls since very few files
        // import from next/font/google.
        filter: {
          id: {
            include: /\.(tsx?|jsx?|mjs)$/,
            exclude: /node_modules/,
          },
          code: "next/font/google",
        },
        async handler(code, id) {
          if (!(this as any)._isBuild) return null;
          // Defensive guard — duplicates filter logic
          if (id.includes("node_modules")) return null;
          if (id.startsWith("\0")) return null;
          if (!id.match(/\.(tsx?|jsx?|mjs)$/)) return null;
          if (!code.includes("next/font/google")) return null;

          // Match font constructor calls: Inter({ weight: ..., subsets: ... })
          // We look for PascalCase or Name_Name identifiers followed by ({...})
          // This regex captures the font name and the options object literal
          const fontCallRe = /\b([A-Z][A-Za-z]*(?:_[A-Z][A-Za-z]*)*)\s*\(\s*(\{[^}]*\})\s*\)/g;

          // Also need to verify these names came from next/font/google import
          const importRe = /import\s*\{([^}]+)\}\s*from\s*['"]next\/font\/google['"]/;
          const importMatch = code.match(importRe);
          if (!importMatch) return null;

          const importedNames = new Set(
            importMatch[1].split(",").map((s) => s.trim()).filter(Boolean),
          );

          const s = new MagicString(code);
          let hasChanges = false;

          const cacheDir = (this as any)._cacheDir as string;
          const fontCache = (this as any)._fontCache as Map<string, string>;

          let match;
          while ((match = fontCallRe.exec(code)) !== null) {
            const [fullMatch, fontName, optionsStr] = match;
            if (!importedNames.has(fontName)) continue;

            // Convert PascalCase/Underscore to font family
            const family = fontName.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");

            // Parse options safely via AST — no eval/new Function
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let options: Record<string, any> = {};
            try {
              const parsed = parseStaticObjectLiteral(optionsStr);
              if (!parsed) continue; // Contains dynamic expressions, skip
              options = parsed as Record<string, any>;
            } catch {
              continue; // Can't parse options statically, skip
            }

            // Build the Google Fonts CSS URL
            const weights = options.weight
              ? Array.isArray(options.weight) ? options.weight : [options.weight]
              : [];
            const styles = options.style
              ? Array.isArray(options.style) ? options.style : [options.style]
              : [];
            const display = options.display ?? "swap";

            let spec = family.replace(/\s+/g, "+");
            if (weights.length > 0) {
              const hasItalic = styles.includes("italic");
              if (hasItalic) {
                const pairs: string[] = [];
                for (const w of weights) { pairs.push(`0,${w}`); pairs.push(`1,${w}`); }
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
                continue;
              }
            }

            // Inject _selfHostedCSS into the options object
            const matchStart = match.index;
            const matchEnd = matchStart + fullMatch.length;
            const escapedCSS = JSON.stringify(localCSS);
            const closingBrace = optionsStr.lastIndexOf("}");
            const optionsWithCSS = optionsStr.slice(0, closingBrace) +
              (optionsStr.slice(0, closingBrace).trim().endsWith("{") ? "" : ", ") +
              `_selfHostedCSS: ${escapedCSS}` +
              optionsStr.slice(closingBrace);

            const replacement = `${fontName}(${optionsWithCSS})`;
            s.overwrite(matchStart, matchEnd, replacement);
            hasChanges = true;
          }

          if (!hasChanges) return null;
          return {
            code: s.toString(),
            map: s.generateMap({ hires: "boundary" }),
          };
        },
      },
    } as Plugin & { _isBuild: boolean; _fontCache: Map<string, string>; _cacheDir: string },
    // Local font path resolution:
    // When a source file calls localFont({ src: "./font.woff2" }) or
    // localFont({ src: [{ path: "./font.woff2" }] }), the relative paths
    // won't resolve in the browser because the CSS is injected at runtime.
    // This plugin rewrites those path strings into Vite asset import
    // references so that both dev (/@fs/...) and prod (/assets/font-xxx.woff2)
    // URLs are correct.
    {
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
    } as Plugin,
    // "use cache" directive transform:
    // Detects "use cache" at file-level or function-level and wraps the
    // exports/functions with registerCachedFunction() from vinext/cache-runtime.
    // Runs without enforce so it executes after JSX transform (parseAst needs plain JS).
    {
      name: "vinext:use-cache",

      transform: {
        // Hook filter: only invoke JS when code contains 'use cache'.
        // The vast majority of files don't use this directive.
        filter: {
          id: {
            include: /\.(tsx?|jsx?|mjs)$/,
            exclude: /node_modules/,
          },
          code: "use cache",
        },
        async handler(code, id) {
          // Defensive guard — duplicates filter logic
          if (id.includes("node_modules")) return null;
          if (id.startsWith("\0")) return null;
          if (!id.match(/\.(tsx?|jsx?|mjs)$/)) return null;
          if (!code.includes("use cache")) return null;

          if (!resolvedRscTransformsPath) {
            throw new Error(
              "vinext: 'use cache' requires @vitejs/plugin-rsc to be installed.\n" +
              "Run: npm install -D @vitejs/plugin-rsc",
            );
          }
          const { transformWrapExport, transformHoistInlineDirective } = await import(pathToFileURL(resolvedRscTransformsPath).href);
          const ast = parseAst(code);

          // Check for file-level "use cache" directive
          const cacheDirective = (ast.body as any[]).find(
            (node: any) =>
              node.type === "ExpressionStatement" &&
              node.expression?.type === "Literal" &&
              typeof node.expression.value === "string" &&
              node.expression.value.startsWith("use cache"),
          );

          if (cacheDirective) {
            // File-level "use cache" — wrap function exports with
            // registerCachedFunction. Page default exports are wrapped directly
            // (they're leaf components). Layout/template defaults are excluded
            // because they receive {children} from the framework.
            const directiveValue: string = cacheDirective.expression.value;
            const variant = directiveValue === "use cache" ? "" : directiveValue.replace("use cache:", "").replace("use cache: ", "").trim();

            // Only skip default export wrapping for layouts and templates —
            // they receive {children} from the framework which requires
            // temporary reference handling that registerCachedFunction doesn't
            // support yet. Pages, not-found, loading, error, and default are
            // leaf components with no {children} prop and can be cached directly.
            const isLayoutOrTemplate = /\/(layout|template)\.(tsx?|jsx?|mjs)$/.test(id);

            const runtimeModuleUrl = pathToFileURL(path.join(shimsDir, "cache-runtime.js")).href;
            const result = transformWrapExport(code, ast as any, {
              runtime: (value: any, name: any) =>
                `(await import(${JSON.stringify(runtimeModuleUrl)})).registerCachedFunction(${value}, ${JSON.stringify(id + ":" + name)}, ${JSON.stringify(variant)})`,
              rejectNonAsyncFunction: false,
              filter: (name: any, meta: any) => {
                // Skip non-functions (constants, types, etc.)
                if (meta.isFunction === false) return false;
                // Skip the default export on layout/template files — these
                // receive {children} from the framework, and caching them
                // requires temporary reference handling for the children slot.
                // Named exports (e.g. generateMetadata) are still wrapped.
                if (isLayoutOrTemplate && name === "default") return false;
                return true;
              },
            });

            if (result.exportNames.length > 0) {
              // Remove the directive itself so it doesn't cause runtime errors
              const output = result.output;
              output.overwrite(cacheDirective.start, cacheDirective.end, `/* "use cache" — wrapped by vinext */`);
              return {
                code: output.toString(),
                map: output.generateMap({ hires: "boundary" }),
              };
            }

            // Even if no exports were wrapped, still strip the directive
            // (e.g., layout/template file with only a default export)
            const output = new MagicString(code);
            output.overwrite(cacheDirective.start, cacheDirective.end, `/* "use cache" — handled by vinext */`);
            return {
              code: output.toString(),
              map: output.generateMap({ hires: "boundary" }),
            };
          }

          // Check for function-level "use cache" directives
          // (e.g., async function getData() { "use cache"; ... })
          const hasInlineCache = code.includes("use cache") && !cacheDirective;
          if (hasInlineCache) {
            const runtimeModuleUrl2 = pathToFileURL(path.join(shimsDir, "cache-runtime.js")).href;

            try {
              const result = transformHoistInlineDirective(code, ast as any, {
                directive: /^use cache(:\s*\w+)?$/,
                runtime: (value: any, name: any, meta: any) => {
                  const directiveMatch = meta.directiveMatch[0];
                  const variant = directiveMatch === "use cache" ? "" : directiveMatch.replace("use cache:", "").replace("use cache: ", "").trim();
                  return `(await import(${JSON.stringify(runtimeModuleUrl2)})).registerCachedFunction(${value}, ${JSON.stringify(id + ":" + name)}, ${JSON.stringify(variant)})`;
                },
                rejectNonAsyncFunction: false,
              });

              if (result.names.length > 0) {
                return {
                  code: result.output.toString(),
                  map: result.output.generateMap({ hires: "boundary" }),
                };
              }
            } catch {
              // If hoisting fails (e.g., complex closure), fall through
            }
          }

          return null;
        },
      },
    },
    // Copy @vercel/og assets (font, WASM) to the RSC output directory.
    // @vercel/og uses readFileSync(new URL("./font.ttf", import.meta.url)) which
    // breaks when the module is bundled because Vite doesn't process
    // new URL(..., import.meta.url) for server-side (SSR/RSC) builds.
    // This plugin copies the required assets so they exist alongside the bundle.
    {
      name: "vinext:og-assets",
      apply: "build",
      enforce: "post",
      writeBundle: {
        sequential: true,
        order: "post",
        async handler(options) {
          const envName = this.environment?.name;
          if (envName !== "rsc") return;

          const outDir = options.dir;
          if (!outDir) return;

          // Check if the bundle references @vercel/og assets
          const indexPath = path.join(outDir, "index.js");
          if (!fs.existsSync(indexPath)) return;

          const content = fs.readFileSync(indexPath, "utf-8");
          const ogAssets = [
            "noto-sans-v27-latin-regular.ttf",
            "resvg.wasm",
          ];

          // Only copy if the bundle actually references these files
          const referencedAssets = ogAssets.filter(asset => content.includes(asset));
          if (referencedAssets.length === 0) return;

          // Find @vercel/og in node_modules
          try {
            const require = createRequire(import.meta.url);
            const ogPkgPath = require.resolve("@vercel/og/package.json");
            const ogDistDir = path.join(path.dirname(ogPkgPath), "dist");

            for (const asset of referencedAssets) {
              const src = path.join(ogDistDir, asset);
              const dest = path.join(outDir, asset);
              if (fs.existsSync(src) && !fs.existsSync(dest)) {
                fs.copyFileSync(src, dest);
              }
            }
          } catch {
            // @vercel/og not installed — nothing to copy
          }
        },
      },
    },
    // Cloudflare Workers production build integration:
    // After all environments are built, compute lazy chunks from the client
    // build manifest and inject globals into the worker entry.
    //
    // Pages Router: injects __VINEXT_CLIENT_ENTRY__, __VINEXT_SSR_MANIFEST__,
    //   and __VINEXT_LAZY_CHUNKS__ into the worker entry (found via wrangler.json).
    // App Router: the RSC plugin handles __VINEXT_CLIENT_ENTRY__ via
    //   loadBootstrapScriptContent(), but we still inject __VINEXT_LAZY_CHUNKS__
    //   and __VINEXT_SSR_MANIFEST__ into the worker entry at dist/server/index.js.
    // Both: generates _headers file for immutable asset caching.
    {
      name: "vinext:cloudflare-build",
      apply: "build",
      enforce: "post",
      closeBundle: {
        sequential: true,
        order: "post",
        async handler() {
          const envName = this.environment?.name
          if (!envName || !hasCloudflarePlugin) return;
          if (envName !== "client") return;

          const envConfig = this.environment?.config;
          if (!envConfig) return;
          const buildRoot = envConfig.root ?? process.cwd();
          const distDir = path.resolve(buildRoot, "dist");
          if (!fs.existsSync(distDir)) return;

          const clientDir = path.resolve(buildRoot, "dist", "client");

          // Read build manifest and compute lazy chunks (only reachable via
          // dynamic imports). This runs for BOTH App Router and Pages Router.
          // clientEntryFile is only used by the Pages Router path below —
          // App Router gets its client entry via the RSC plugin instead.
          let lazyChunksData: string[] | null = null;
          let clientEntryFile: string | null = null;
          const buildManifestPath = path.join(clientDir, ".vite", "manifest.json");
          if (fs.existsSync(buildManifestPath)) {
            try {
              const buildManifest = JSON.parse(fs.readFileSync(buildManifestPath, "utf-8"));
              for (const [, value] of Object.entries(buildManifest) as [string, any][]) {
                if (value && value.isEntry && value.file) {
                  clientEntryFile = value.file;
                  break;
                }
              }
              const lazy = computeLazyChunks(buildManifest);
              if (lazy.length > 0) lazyChunksData = lazy;
            } catch { /* ignore parse errors */ }
          }

          // Read SSR manifest for per-page CSS/JS injection
          let ssrManifestData: Record<string, string[]> | null = null;
          const ssrManifestPath = path.join(clientDir, ".vite", "ssr-manifest.json");
          if (fs.existsSync(ssrManifestPath)) {
            try {
              ssrManifestData = JSON.parse(fs.readFileSync(ssrManifestPath, "utf-8"));
            } catch { /* ignore parse errors */ }
          }

          if (hasAppDir) {
            // App Router: the RSC plugin handles __VINEXT_CLIENT_ENTRY__
            // via loadBootstrapScriptContent(), but we still need to inject
            // __VINEXT_LAZY_CHUNKS__ and __VINEXT_SSR_MANIFEST__ into the
            // worker entry at dist/server/index.js.
            const workerEntry = path.resolve(distDir, "server", "index.js");
            if (fs.existsSync(workerEntry) && (lazyChunksData || ssrManifestData)) {
              let code = fs.readFileSync(workerEntry, "utf-8");
              const globals: string[] = [];
              if (ssrManifestData) {
                globals.push(`globalThis.__VINEXT_SSR_MANIFEST__ = ${JSON.stringify(ssrManifestData)};`);
              }
              if (lazyChunksData) {
                globals.push(`globalThis.__VINEXT_LAZY_CHUNKS__ = ${JSON.stringify(lazyChunksData)};`);
              }
              code = globals.join("\n") + "\n" + code;
              fs.writeFileSync(workerEntry, code);
            }
          } else {
            // Pages Router: find worker output by scanning dist/ for a
            // directory containing wrangler.json (Cloudflare plugin default).
            let workerOutDir: string | null = null;
            for (const entry of fs.readdirSync(distDir)) {
              const candidate = path.join(distDir, entry);
              if (entry === "client") continue;
              if (fs.statSync(candidate).isDirectory() &&
                  fs.existsSync(path.join(candidate, "wrangler.json"))) {
                workerOutDir = candidate;
                break;
              }
            }
            if (!workerOutDir) return;

            const workerEntry = path.join(workerOutDir, "index.js");
            if (!fs.existsSync(workerEntry)) return;

            // Fallback: scan dist/client/assets/ for the client entry chunk.
            // Pages Router uses "vinext-client-entry", App Router uses
            // "vinext-app-browser-entry".
            if (!clientEntryFile) {
              const assetsDir = path.join(clientDir, "assets");
              if (fs.existsSync(assetsDir)) {
                const files = fs.readdirSync(assetsDir);
                const entry = files.find((f: string) =>
                  (f.includes("vinext-client-entry") || f.includes("vinext-app-browser-entry")) && f.endsWith(".js"));
                if (entry) clientEntryFile = "assets/" + entry;
              }
            }

            // Prepend globals to worker entry
            if (clientEntryFile || ssrManifestData || lazyChunksData) {
              let code = fs.readFileSync(workerEntry, "utf-8");
              const globals: string[] = [];
              if (clientEntryFile) {
                globals.push(`globalThis.__VINEXT_CLIENT_ENTRY__ = ${JSON.stringify(clientEntryFile)};`);
              }
              if (ssrManifestData) {
                globals.push(`globalThis.__VINEXT_SSR_MANIFEST__ = ${JSON.stringify(ssrManifestData)};`);
              }
              if (lazyChunksData) {
                globals.push(`globalThis.__VINEXT_LAZY_CHUNKS__ = ${JSON.stringify(lazyChunksData)};`);
              }
              code = globals.join("\n") + "\n" + code;
              fs.writeFileSync(workerEntry, code);
            }
          }

          // Generate _headers file for Cloudflare Workers static asset caching.
          // Vite outputs content-hashed files (JS, CSS, fonts) to the assetsDir
          // (defaults to "assets"). These are safe to cache indefinitely since
          // the hash changes on any content change. Without this, Cloudflare
          // serves them with max-age=0 which forces unnecessary revalidation
          // on every page load.
          const headersPath = path.join(clientDir, "_headers");
          if (!fs.existsSync(headersPath)) {
            const assetsDir = envConfig.build?.assetsDir ?? "assets";
            const headersContent = [
              "# Cache content-hashed assets immutably (generated by vinext)",
              `/${assetsDir}/*`,
              "  Cache-Control: public, max-age=31536000, immutable",
              "",
            ].join("\n");
            fs.writeFileSync(headersPath, headersContent);
          }
        },
      },
    },
  ];

  // Append auto-injected RSC plugins if applicable
  if (rscPluginPromise) {
    plugins.push(rscPluginPromise);
  }

  return plugins as Plugin[];
}

/**
 * Collect all NEXT_PUBLIC_* env vars and create Vite define entries
 * so they get inlined into the client bundle.
 */
function getNextPublicEnvDefines(): Record<string, string> {
  const defines: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("NEXT_PUBLIC_") && value !== undefined) {
      defines[`process.env.${key}`] = JSON.stringify(value);
    }
  }
  return defines;
}

/**
 * If the current position in `str` starts with a parenthesized group, consume
 * it and advance `re.lastIndex` past the closing `)`. Returns the group
 * contents or null if no group is present.
 */
function extractConstraint(str: string, re: RegExp): string | null {
  if (str[re.lastIndex] !== "(") return null;
  const start = re.lastIndex + 1;
  let depth = 1;
  let i = start;
  while (i < str.length && depth > 0) {
    if (str[i] === "(") depth++;
    else if (str[i] === ")") depth--;
    i++;
  }
  if (depth !== 0) return null;
  re.lastIndex = i;
  return str.slice(start, i - 1);
}

/**
 * Match a Next.js route pattern (e.g. "/blog/:slug", "/docs/:path*") against a pathname.
 * Returns matched params or null.
 *
 * Supports:
 *   :param     — matches a single path segment
 *   :param*    — matches zero or more segments (catch-all)
 *   :param+    — matches one or more segments
 *   (regex)    — inline regex patterns in the source
 */
export function matchConfigPattern(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  // If the pattern contains regex groups like (\\d+) or (.*), use regex matching.
  // Also enter this branch when a catch-all parameter (:param* or :param+) is
  // followed by a literal suffix (e.g. "/:path*.md"). Without this, the suffix
  // pattern falls through to the simple segment matcher which incorrectly treats
  // the whole segment (":path*.md") as a named parameter and matches everything.
  if (
    pattern.includes("(") ||
    pattern.includes("\\") ||
    /:[\w-]+[*+][^/]/.test(pattern)
  ) {
    try {
      // Extract named params and their constraints from the pattern.
      // :param(constraint) -> use constraint as the regex group
      // :param -> ([^/]+)
      // :param* -> (.*)
      // :param+ -> (.+)
      // Param names may contain hyphens (e.g. :auth-method, :sign-in).
      const paramNames: string[] = [];
      // Single-pass conversion with procedural suffix handling. The tokenizer
      // matches only simple, non-overlapping tokens; quantifier/constraint
      // suffixes after :param are consumed procedurally to avoid polynomial
      // backtracking in the regex engine.
      let regexStr = "";
      const tokenRe = /:([\w-]+)|[.]|[^:.]+/g; // lgtm[js/redos] — alternatives are non-overlapping (`:` and `.` excluded from `[^:.]+`)
      let tok: RegExpExecArray | null;
      while ((tok = tokenRe.exec(pattern)) !== null) {
        if (tok[1] !== undefined) {
          const name = tok[1];
          const rest = pattern.slice(tokenRe.lastIndex);
          // Check for quantifier (* or +) with optional constraint
          if (rest.startsWith("*") || rest.startsWith("+")) {
            const quantifier = rest[0];
            tokenRe.lastIndex += 1;
            const constraint = extractConstraint(pattern, tokenRe);
            paramNames.push(name);
            if (constraint !== null) {
              regexStr += `(${constraint})`;
            } else {
              regexStr += quantifier === "*" ? "(.*)" : "(.+)";
            }
          } else {
            // Check for inline constraint without quantifier
            const constraint = extractConstraint(pattern, tokenRe);
            paramNames.push(name);
            regexStr += constraint !== null ? `(${constraint})` : "([^/]+)";
          }
        } else if (tok[0] === ".") {
          regexStr += "\\.";
        } else {
          regexStr += tok[0];
        }
      }
      const re = safeRegExp("^" + regexStr + "$");
      if (!re) return null;
      const match = re.exec(pathname);
      if (!match) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < paramNames.length; i++) {
        params[paramNames[i]] = match[i + 1] ?? "";
      }
      return params;
    } catch {
      // Fall through to segment-based matching
    }
  }

  // Check for catch-all patterns (:param* or :param+) without regex groups
  // Param names may contain hyphens (e.g. :sign-in*, :sign-up+).
  const catchAllMatch = pattern.match(/:([\w-]+)(\*|\+)$/);
  if (catchAllMatch) {
    const prefix = pattern.slice(0, pattern.lastIndexOf(":"));
    const paramName = catchAllMatch[1];
    const isPlus = catchAllMatch[2] === "+";

    if (!pathname.startsWith(prefix.replace(/\/$/, ""))) return null;

    const rest = pathname.slice(prefix.replace(/\/$/, "").length);
    // For :path+ we need at least one segment (non-empty after the prefix)
    if (isPlus && (!rest || rest === "/")) return null;
    // For :path* zero segments is fine
    let restValue = rest.startsWith("/") ? rest.slice(1) : rest;
    // NOTE: Do NOT decodeURIComponent here. The pathname is already decoded at
    // the entry point. Decoding again would create a double-decode vector.
    return { [paramName]: restValue };
  }

  // Simple segment-based matching for exact patterns and :param
  const parts = pattern.split("/");
  const pathParts = pathname.split("/");

  if (parts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(":")) {
      params[parts[i].slice(1)] = pathParts[i];
    } else if (parts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Sanitize a redirect/rewrite destination by collapsing leading slashes and
 * backslashes to a single "/" for non-external URLs. Browsers interpret "\"
 * as "/" in URL contexts, so "\/evil.com" becomes "//evil.com" (protocol-relative).
 */
function sanitizeDestinationLocal(dest: string): string {
  if (dest.startsWith("http://") || dest.startsWith("https://")) return dest;
  dest = dest.replace(/^[\\/]+/, "/");
  return dest;
}

/**
 * Apply redirect rules from next.config.js.
 * Returns true if a redirect was applied.
 */
function applyRedirects(
  pathname: string,
  res: any,
  redirects: NextRedirect[],
): boolean {
  for (const redirect of redirects) {
    const params = matchConfigPattern(pathname, redirect.source);
    if (params) {
      let dest = redirect.destination;
      for (const [key, value] of Object.entries(params)) {
        dest = dest.replace(`:${key}*`, value);
        dest = dest.replace(`:${key}+`, value);
        dest = dest.replace(`:${key}`, value);
      }
      // Sanitize to prevent open redirect via protocol-relative URLs
      dest = sanitizeDestinationLocal(dest);
      res.writeHead(redirect.permanent ? 308 : 307, { Location: dest });
      res.end();
      return true;
    }
  }
  return false;
}

/**
 * Proxy an external rewrite in the Node.js dev server context.
 *
 * Converts the Node.js IncomingMessage into a Web Request, calls
 * proxyExternalRequest(), and pipes the response back to the Node.js
 * ServerResponse.
 */
async function proxyExternalRewriteNode(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  externalUrl: string,
): Promise<void> {
  try {
    const proto = "http";
    const host = req.headers.host || "localhost";
    const origin = `${proto}://${host}`;
    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const init: RequestInit & { duplex?: string } = {
      method,
      headers: Object.fromEntries(
        Object.entries(req.headers)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]),
      ),
    };
    if (hasBody) {
      const { Readable } = await import("node:stream");
      init.body = Readable.toWeb(req) as unknown as ReadableStream;
      init.duplex = "half";
    }
    const webRequest = new Request(new URL(req.url ?? "/", origin), init);
    const proxyResponse = await proxyExternalRequest(webRequest, externalUrl);

    // Preserve multi-value headers (e.g. Set-Cookie) — Object.fromEntries()
    // would collapse them into a single value.
    const nodeHeaders: Record<string, string | string[]> = {};
    proxyResponse.headers.forEach((value, key) => {
      const existing = nodeHeaders[key];
      if (existing !== undefined) {
        nodeHeaders[key] = Array.isArray(existing)
          ? [...existing, value]
          : [existing, value];
      } else {
        nodeHeaders[key] = value;
      }
    });
    res.writeHead(proxyResponse.status, nodeHeaders);

    if (proxyResponse.body) {
      const { Readable: ReadableImport } = await import("node:stream");
      const nodeStream = ReadableImport.fromWeb(proxyResponse.body as unknown as import("stream/web").ReadableStream);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    console.error("[vinext] External rewrite proxy error:", e);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end("Bad Gateway");
    }
  }
}

/**
 * Apply rewrite rules from next.config.js.
 * Returns the rewritten URL or null if no rewrite matched.
 */
function applyRewrites(
  pathname: string,
  rewrites: NextRewrite[],
): string | null {
  for (const rewrite of rewrites) {
    const params = matchConfigPattern(pathname, rewrite.source);
    if (params) {
      let dest = rewrite.destination;
      for (const [key, value] of Object.entries(params)) {
        dest = dest.replace(`:${key}*`, value);
        dest = dest.replace(`:${key}+`, value);
        dest = dest.replace(`:${key}`, value);
      }
      // Sanitize to prevent open redirect via protocol-relative URLs
      dest = sanitizeDestinationLocal(dest);
      return dest;
    }
  }
  return null;
}

/**
 * Apply custom header rules from next.config.js.
 */
function applyHeaders(
  pathname: string,
  res: any,
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>,
): void {
  for (const rule of headers) {
    const escaped = escapeHeaderSource(rule.source);
    const sourceRegex = safeRegExp("^" + escaped + "$");
    if (sourceRegex && sourceRegex.test(pathname)) {
      for (const header of rule.headers) {
        res.setHeader(header.key, header.value);
      }
    }
  }
}

/**
 * Find a file by name (without extension) in a directory.
 * Checks .tsx, .ts, .jsx, .js extensions.
 */
function findFileWithExts(dir: string, name: string): string | null {
  const extensions = [".tsx", ".ts", ".jsx", ".js"];
  for (const ext of extensions) {
    const filePath = path.join(dir, name + ext);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

/**
 * Check if the project has .mdx files in app/ or pages/ directories.
 */
function hasMdxFiles(root: string, appDir: string | null, pagesDir: string | null): boolean {
  const dirs = [appDir, pagesDir].filter(Boolean) as string[];
  for (const dir of dirs) {
    if (fs.existsSync(dir) && scanDirForMdx(dir)) return true;
  }
  return false;
}

function scanDirForMdx(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (scanDirForMdx(full)) return true;
      } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
        return true;
      }
    }
  } catch {
    // ignore unreadable dirs
  }
  return false;
}

// Public exports for static export
export { staticExportPages, staticExportApp } from "./build/static-export.js";
export type { StaticExportResult, StaticExportOptions, AppStaticExportOptions } from "./build/static-export.js";

// Exported for CLI and testing
export { clientManualChunks, clientOutputConfig, clientTreeshakeConfig, computeLazyChunks };
export { resolvePostcssStringPlugins as _resolvePostcssStringPlugins };
export { parseStaticObjectLiteral as _parseStaticObjectLiteral };
