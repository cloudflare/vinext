import type { Plugin, PluginOption, UserConfig, ViteDevServer } from "vite";
import { loadEnv, parseAst } from "vite";
import { pagesRouter, apiRouter, invalidateRouteCache, matchRoute } from "./routing/pages-router.js";
import { generateServerEntry as _generateServerEntry } from "./entries/pages-server-entry.js";
import { generateClientEntry as _generateClientEntry } from "./entries/pages-client-entry.js";
import { appRouter, invalidateAppRouteCache } from "./routing/app-router.js";
import { createValidFileMatcher } from "./routing/file-matcher.js";
import { createSSRHandler } from "./server/dev-server.js";
import { handleApiRoute } from "./server/api-handler.js";
import { createDirectRunner } from "./server/dev-module-runner.js";
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
  type NextHeader,
} from "./config/next-config.js";

import { findMiddlewareFile, runMiddleware } from "./server/middleware.js";
import { logRequest, now } from "./server/request-log.js";
import { normalizePath } from "./server/normalize-path.js";
import { findInstrumentationFile, runInstrumentation } from "./server/instrumentation.js";
import { PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER } from "./shims/constants.js";
import { validateDevRequest } from "./server/dev-origin-check.js";
import {
  isExternalUrl,
  proxyExternalRequest,
  matchHeaders,
  matchRedirect,
  matchRewrite,
  requestContextFromRequest,
  sanitizeDestination,
  type RequestContext,
} from "./config/config-matchers.js";
import { scanMetadataFiles } from "./server/metadata-routes.js";
import { staticExportPages } from "./build/static-export.js";
import { detectPackageManager } from "./utils/project.js";
import { asyncHooksStubPlugin } from "./plugins/async-hooks-stub.js";
import { hasWranglerConfig, formatMissingCloudflarePluginError } from "./deploy.js";
import tsconfigPaths from "vite-tsconfig-paths";
import react, { Options as VitePluginReactOptions } from "@vitejs/plugin-react";
import MagicString from "magic-string";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";
import commonjs from "vite-plugin-commonjs";

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
  /**
   * Options passed to @vitejs/plugin-react (React Fast Refresh + JSX transform).
   * Enabled by default. Set to `false` to disable (e.g. if you already have
   * @vitejs/plugin-react in your vite.config.ts), or pass an options object
   * to customize the Babel transform.
   * @default true
   */
  react?: VitePluginReactOptions | boolean;
}

export default function vinext(options: VinextOptions = {}): PluginOption[] {
  let root: string;
  let pagesDir: string;
  let appDir: string;
  let hasAppDir = false;
  let hasPagesDir = false;
  let nextConfig: ResolvedNextConfig;
  let fileMatcher: ReturnType<typeof createValidFileMatcher>;
  let middlewarePath: string | null = null;
  let instrumentationPath: string | null = null;
  let hasCloudflarePlugin = false;
  let hasNitroPlugin = false;

  // Resolve shim paths - works both from source (.ts) and built (.js)
  const shimsDir = path.resolve(__dirname, "shims");

  // Shim alias map — populated in config(), used by resolveId() for .js variants
  let nextShimMap: Record<string, string> = {};

  /**
   * Generate the virtual SSR server entry module.
   * This is the entry point for `vite build --ssr`.
   */
  async function generateServerEntry(): Promise<string> {
    return _generateServerEntry(pagesDir, nextConfig, fileMatcher, middlewarePath, instrumentationPath);
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
    return _generateClientEntry(pagesDir, nextConfig, fileMatcher);
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
        "Run: " + detectPackageManager(process.cwd()) + " @vitejs/plugin-rsc",
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

  // Shared state for the MDX proxy plugin. Populated during config() if MDX
  // files are detected and @mdx-js/rollup is installed.
  let mdxDelegate: Plugin | null = null;

  const reactPlugin = options.react === false
    ? false
    : react(options.react === true ? undefined : options.react);

  const plugins: PluginOption[] = [
    // Resolve tsconfig paths/baseUrl aliases so real-world Next.js repos
    // that use @/*, #/*, or baseUrl imports work out of the box.
    tsconfigPaths(),
    // React Fast Refresh + JSX transform for client components.
    reactPlugin,
    // Transform CJS require()/module.exports to ESM before other plugins
    // analyze imports (RSC directive scanning, shim resolution, etc.)
    commonjs(),
    {
      name: "vinext:config",
      enforce: "pre",

      async config(config, env) {
        root = config.root ?? process.cwd();

        // Load .env files into process.env before anything else.
        // Next.js loads .env files before evaluating next.config.js, so
        // env vars are available in config, server-side code, and as
        // NEXT_PUBLIC_* defines for the client bundle.
        // Pass '' as prefix to load ALL vars, not just VITE_-prefixed ones.
        const mode = env?.mode ?? "development";
        const envDir = config.envDir ?? root;
        const dotenvVars = loadEnv(mode, envDir, "");
        for (const [key, value] of Object.entries(dotenvVars)) {
          if (process.env[key] === undefined) {
            process.env[key] = value;
          }
        }
        // Align NODE_ENV with Next.js semantics: build -> production, serve -> development.
        // Next.js unconditionally forces NODE_ENV during build/dev, so we do the same.
        let resolvedNodeEnv: string;
        if (mode === "test") {
          resolvedNodeEnv = "test";
        } else if (env?.command === "build") {
          resolvedNodeEnv = "production";
        } else {
          resolvedNodeEnv = "development";
        }
        if (process.env.NODE_ENV !== resolvedNodeEnv) {
          process.env.NODE_ENV = resolvedNodeEnv;
        }

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
        const phase = env?.command === "build" ? PHASE_PRODUCTION_BUILD : PHASE_DEVELOPMENT_SERVER;
        const rawConfig = await loadNextConfig(root, phase);
        nextConfig = await resolveNextConfig(rawConfig, root);
        fileMatcher = createValidFileMatcher(nextConfig.pageExtensions);

        // Merge env from next.config.js with NEXT_PUBLIC_* env vars
        const defines = getNextPublicEnvDefines();
        if (
          !config.define ||
          typeof config.define !== "object" ||
          !("process.env.NODE_ENV" in config.define)
        ) {
          defines["process.env.NODE_ENV"] = JSON.stringify(resolvedNodeEnv);
        }
        for (const [key, value] of Object.entries(nextConfig.env)) {
          // Skip NODE_ENV from next.config.js env — Next.js ignores it too,
          // and it would silently override the value we just set above.
          if (key === "NODE_ENV") continue;
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
        // Expose dangerouslyAllowSVG flag for the image shim's auto-skip logic.
        // When false (default), .svg sources bypass the optimization endpoint.
        defines["process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_SVG"] = JSON.stringify(
          String(nextConfig.images?.dangerouslyAllowSVG ?? false),
        );
        // Draft mode secret — generated once at build time so the
        // __prerender_bypass cookie is consistent across all server
        // instances (e.g. multiple Cloudflare Workers isolates).
        defines["process.env.__VINEXT_DRAFT_SECRET"] = JSON.stringify(
          crypto.randomUUID(),
        );

        // Build the shim alias map — used by both resolve.alias and resolveId
        // (resolveId handles .js extension variants for libraries like nuqs)
        nextShimMap = {
          ...nextConfig.aliases,
          "next/link": path.join(shimsDir, "link"),
          "next/head": path.join(shimsDir, "head"),
          "next/router": path.join(shimsDir, "router"),
          "next/compat/router": path.join(shimsDir, "compat-router"),
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
        hasNitroPlugin = pluginsFlat.some(
          (p: any) => p && typeof p === "object" && typeof p.name === "string" && (
            p.name === "nitro" || p.name.startsWith("nitro:")
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
        if (!hasMdxPlugin && hasMdxFiles(root, hasAppDir ? appDir : null, hasPagesDir ? pagesDir : null)) {
          try {
            const mdxRollup = await import("@mdx-js/rollup");
            const mdxFactory = mdxRollup.default ?? mdxRollup;
            const mdxOpts: Record<string, unknown> = {};
            if (nextConfig.mdx) {
              if (nextConfig.mdx.remarkPlugins) mdxOpts.remarkPlugins = nextConfig.mdx.remarkPlugins;
              if (nextConfig.mdx.rehypePlugins) mdxOpts.rehypePlugins = nextConfig.mdx.rehypePlugins;
              if (nextConfig.mdx.recmaPlugins) mdxOpts.recmaPlugins = nextConfig.mdx.recmaPlugins;
            }
            mdxDelegate = mdxFactory(mdxOpts);
            if (nextConfig.mdx) {
              console.log("[vinext] Auto-injected @mdx-js/rollup with remark/rehype plugins from next.config");
            } else {
              console.log("[vinext] Auto-injected @mdx-js/rollup for MDX support");
            }
          } catch {
            // @mdx-js/rollup not installed — warn but don't fail
            console.warn(
              "[vinext] MDX files detected but @mdx-js/rollup is not installed. " +
              "Install it with: " + detectPackageManager(process.cwd()) + " @mdx-js/rollup"
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
        const isMultiEnv = hasAppDir || hasCloudflarePlugin || hasNitroPlugin;

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
          // Configure SSR transform behaviour for Node targets.
          // - `external`: React packages are loaded natively by Node (CJS)
          //   rather than through Vite's ESM evaluator.
          // - `noExternal: true`: force everything else through Vite's
          //   transform pipeline so non-JS imports (CSS, images) from
          //   node_modules don't hit Node's native ESM loader.
          //   Any user-provided `ssr.noExternal` is intentionally superseded
          //   by this setting; only `ssr.external` entries escape Vite's transform.
          // Skip when targeting bundled runtimes (Cloudflare/Nitro bundle everything).
          // This also resolves extensionless-import issues in packages like
          // `validator` (see #189) by routing them through Vite's resolver.
          ...(hasCloudflarePlugin || hasNitroPlugin ? {} : {
            ssr: {
              external: ["react", "react-dom", "react-dom/server"],
              noExternal: true,
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
          // Exclude @vercel/og so Vite's esbuild pre-bundler doesn't cache it
          // before our vinext:og-font-patch transform can inline the font and
          // patch the yoga WASM instantiation for workerd compatibility.
          optimizeDeps: {
            exclude: ["vinext", "@vercel/og"],
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

        // Collect user-provided ssr.external so we can propagate it into
        // both the RSC and SSR environment configs. Vite's `ssr.*` config
        // only applies to the default `ssr` environment, not custom ones
        // like `rsc`. Native addon packages (e.g. better-sqlite3) listed
        // in ssr.external must be externalized from ALL server environments.
        // Vite's SSROptions.external is `string[] | true`; handle both forms.
        const userSsrExternal: string[] | true = Array.isArray(config.ssr?.external)
          ? config.ssr.external
          : config.ssr?.external === true
            ? true
            : [];

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
              ...(hasCloudflarePlugin || hasNitroPlugin ? {} : {
                resolve: {
                  // Externalize native/heavy packages so the RSC environment
                  // loads them natively via Node rather than through Vite's
                  // ESM module evaluator (which can't handle native addons).
                  // Note: Do NOT externalize react/react-dom here — they must
                  // be bundled with the "react-server" condition for RSC.
                  // Skip when targeting bundled runtimes (Cloudflare/Nitro).
                  external: userSsrExternal === true ? true : [
                    "satori",
                    "@resvg/resvg-js",
                    "yoga-wasm-web",
                    ...userSsrExternal,
                  ],
                  // Force all node_modules through Vite's transform pipeline
                  // so non-JS imports (CSS, images) don't hit Node's native
                  // ESM loader. Matches Next.js behavior of bundling everything.
                  // Packages in `external` above take precedence per Vite rules.
                  // When user sets `ssr.external: true`, skip noExternal since
                  // everything is already externalized.
                  ...(userSsrExternal === true ? {} : { noExternal: true as const }),
                },
              }),
              optimizeDeps: {
                exclude: ["vinext", "@vercel/og"],
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
              ...(hasCloudflarePlugin || hasNitroPlugin ? {} : {
                resolve: {
                  external: userSsrExternal === true ? true : [...userSsrExternal],
                  // Force all node_modules through Vite's transform pipeline
                  // so non-JS imports (CSS, images) don't hit Node's native
                  // ESM loader. Matches Next.js behavior of bundling everything.
                  // When user sets `ssr.external: true`, skip noExternal since
                  // everything is already externalized.
                  ...(userSsrExternal === true ? {} : { noExternal: true as const }),
                },
              }),
              optimizeDeps: {
                exclude: ["vinext", "@vercel/og"],
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
              // Explicitly mark as client consumer so other plugins (e.g. Nitro)
              // can detect this during configEnvironment hooks — before Vite
              // applies the default consumer based on environment name.
              // Without this, Nitro's configEnvironment creates a server-side
              // service for the client environment, causing virtual module
              // imports to leak to Node's native ESM loader (ERR_UNSUPPORTED_ESM_URL_SCHEME).
              consumer: "client",
              optimizeDeps: {
                exclude: ["vinext"],
                // React packages aren't crawled from app/ source files,
                // so must be pre-included to avoid late discovery (#25).
                include: [
                  "react",
                  "react-dom",
                  "react-dom/client",
                  "react/jsx-runtime",
                  "react/jsx-dev-runtime",
                ],
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
              consumer: "client",
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

        // Fail the build when targeting Cloudflare Workers without the
        // cloudflare() plugin. Without it, wrangler's esbuild can't resolve
        // virtual:vinext-rsc-entry and produces a cryptic error. (#325)
        if (
          config.command === "build" &&
          !hasCloudflarePlugin &&
          !hasNitroPlugin &&
          hasWranglerConfig(root)
        ) {
          throw new Error(
            formatMissingCloudflarePluginError({
              isAppRouter: hasAppDir,
              configFile: config.configFile,
            }),
          );
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
          const routes = await appRouter(appDir, nextConfig?.pageExtensions, fileMatcher);
          const metaRoutes = scanMetadataFiles(appDir);
          // Check for global-error.tsx at app root
          const globalErrorPath = findFileWithExts(
            appDir,
            "global-error",
            fileMatcher,
          );
          return generateRscEntry(appDir, routes, middlewarePath, metaRoutes, globalErrorPath, nextConfig?.basePath, nextConfig?.trailingSlash, {
            redirects: nextConfig?.redirects,
            rewrites: nextConfig?.rewrites,
            headers: nextConfig?.headers,
            allowedOrigins: nextConfig?.serverActionsAllowedOrigins,
            allowedDevOrigins: nextConfig?.allowedDevOrigins,
            bodySizeLimit: nextConfig?.serverActionsBodySizeLimit,
          }, instrumentationPath);
        }
        if (id === RESOLVED_APP_SSR_ENTRY && hasAppDir) {
          return generateSsrEntry();
        }
        if (id === RESOLVED_APP_BROWSER_ENTRY && hasAppDir) {
          return generateBrowserEntry();
        }
      },
    },
    // Stub node:async_hooks in client builds — see src/plugins/async-hooks-stub.ts
    asyncHooksStubPlugin,
    // Proxy plugin for @mdx-js/rollup. The real MDX plugin is created lazily
    // during vinext:config's config() (when MDX files are detected), but
    // plugins returned from config() hooks run too late in the pipeline —
    // after vite:import-analysis. This top-level proxy with enforce:"pre"
    // ensures MDX transforms run at the correct stage. Both vinext:config
    // and this proxy are enforce:"pre", and vinext:config comes first in
    // the array, so mdxDelegate is already set when this proxy's hooks fire.
    {
      name: "vinext:mdx",
      enforce: "pre",
      config(config, env) {
        if (!mdxDelegate?.config) return;
        const hook = mdxDelegate.config;
        const fn = typeof hook === "function" ? hook : hook.handler;
        return fn.call(this, config, env);
      },
      transform(code, id, options) {
        // Skip ?raw and other query imports — @mdx-js/rollup ignores the query
        // and would compile the file as MDX instead of returning raw text.
        if (id.includes("?")) return;
        if (!mdxDelegate?.transform) return;
        const hook = mdxDelegate.transform;
        const fn = typeof hook === "function" ? hook : hook.handler;
        return fn.call(this, code, id, options);
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
      // Even with @vitejs/plugin-react providing React Fast Refresh,
      // the Pages Router injects hydration via inline <script type="module">
      // which may not be tracked in Vite's module graph. Explicitly
      // sending full-reload ensures changes are always reflected in
      // the browser.
      hotUpdate(options: { file: string; server: ViteDevServer; modules: any[] }) {
        if (!hasPagesDir || hasAppDir) return;
        if (options.file.startsWith(pagesDir) && fileMatcher.extensionRegex.test(options.file)) {
          options.server.environments.client.hot.send({ type: "full-reload" });
          return [];
        }
      },

      configureServer(server: ViteDevServer) {
        // Watch pages directory for file additions/removals to invalidate route cache.
        const pageExtensions = fileMatcher.extensionRegex;

        // Build a long-lived ModuleRunner for loading all Pages Router modules
        // (middleware, API routes, SSR page rendering) on every request.
        //
        // We must NOT use server.ssrLoadModule() here: when @cloudflare/vite-plugin
        // is present its environments replace the SSR transport, causing
        // SSRCompatModuleRunner to crash with:
        //   TypeError: Cannot read properties of undefined (reading 'outsideEmitter')
        // on the very first request.
        //
        // createDirectRunner() builds a runner on environment.fetchModule() which
        // is a plain async method — safe with all plugin combinations, including
        // @cloudflare/vite-plugin.
        //
        // The runner is created lazily on first use so that all environments are
        // fully registered before we inspect them. We prefer "ssr", then any
        // non-"rsc" environment, then whatever is available.
        let pagesRunner: import("vite/module-runner").ModuleRunner | null = null;
        function getPagesRunner() {
          if (!pagesRunner) {
            const env =
              server.environments["ssr"] ??
              Object.values(server.environments).find((e) => e !== server.environments["rsc"]) ??
              Object.values(server.environments)[0];
            pagesRunner = createDirectRunner(env);
          }
          return pagesRunner;
        }

        /**
         * Invalidate the virtual RSC entry module in Vite's module graph.
         *
         * The App Router route table is baked into the virtual RSC entry
         * at generation time. When routes are added or removed, clearing
         * the route cache alone is not enough: the virtual module must
         * also be invalidated so Vite re-calls the load() hook to
         * regenerate the entry with the updated route table.
         */
        function invalidateRscEntryModule() {
          const rscEnv = server.environments["rsc"];
          if (!rscEnv) return;
          const mod = rscEnv.moduleGraph.getModuleById(RESOLVED_RSC_ENTRY);
          if (mod) {
            rscEnv.moduleGraph.invalidateModule(mod);
            rscEnv.hot.send({ type: "full-reload" });
          }
        }

        server.watcher.on("add", (filePath: string) => {
          if (hasPagesDir && filePath.startsWith(pagesDir) && pageExtensions.test(filePath)) {
            invalidateRouteCache(pagesDir);
          }
          if (hasAppDir && filePath.startsWith(appDir) && pageExtensions.test(filePath)) {
            invalidateAppRouteCache();
            invalidateRscEntryModule();
          }
        });
        server.watcher.on("unlink", (filePath: string) => {
          if (hasPagesDir && filePath.startsWith(pagesDir) && pageExtensions.test(filePath)) {
            invalidateRouteCache(pagesDir);
          }
          if (hasAppDir && filePath.startsWith(appDir) && pageExtensions.test(filePath)) {
            invalidateAppRouteCache();
            invalidateRscEntryModule();
          }
        });

        // ── Dev request origin check ─────────────────────────────────────
        // Registered directly (not in the returned function) so it runs
        // BEFORE Vite's built-in middleware. This ensures all requests
        // (including /@*, /__vite*, /node_modules* paths) are validated
        // before Vite serves any content.
        server.middlewares.use((req: any, res: any, next: any) => {
          const blockReason = validateDevRequest(
            {
              origin: req.headers.origin as string | undefined,
              host: req.headers.host,
              "x-forwarded-host": req.headers["x-forwarded-host"] as string | undefined,
              "sec-fetch-site": req.headers["sec-fetch-site"] as string | undefined,
              "sec-fetch-mode": req.headers["sec-fetch-mode"] as string | undefined,
            },
            nextConfig?.allowedDevOrigins,
          );
          if (blockReason) {
            console.warn(`[vinext] Blocked dev request: ${blockReason} (${req.url})`);
            res.writeHead(403, { "Content-Type": "text/plain" });
            res.end("Forbidden");
            return;
          }
          next();
        });

        // Return a function to register middleware AFTER Vite's built-in middleware
        return () => {
          // Run instrumentation.ts register() if present (once at server startup).
          // Must be inside the returned function so that all environments are
          // fully registered before getPagesRunner() inspects them.
          //
          // App Router: register() is baked into the generated RSC entry as a
          // top-level await, so it runs inside the Worker process (or RSC Vite
          // environment) — the same process as request handling. Calling
          // runInstrumentation() here too would run it a second time in the host
          // process, which is wrong when @cloudflare/vite-plugin is present.
          //
          // Pages Router prod: register() is baked into generateServerEntry() as
          // a top-level await, so it runs inside the Worker bundle — the same
          // process as request handling. configureServer() is never called during
          // a prod build, so there is no double-invocation risk there either.
          //
          // We pass getPagesRunner() (createDirectRunner) rather than server so
          // that this is safe when @cloudflare/vite-plugin is present. That
          // plugin replaces the SSR environment's hot channel, causing
          // server.ssrLoadModule() to crash with outsideEmitter. The runner
          // calls environment.fetchModule() directly and never touches the hot
          // channel, making it safe with all Vite plugin combinations.
          if (instrumentationPath && !hasAppDir) {
            runInstrumentation(getPagesRunner(), instrumentationPath).catch((err) => {
              console.error("[vinext] Instrumentation error:", err);
            });
          }
          // App Router request logging in dev server
          //
          // For App Router, the RSC plugin handles requests internally.
          // We install a timing middleware here that:
          //   1. Intercepts writeHead() to pluck the X-Vinext-Timing header
          //      (compileMs,renderMs) that the RSC entry attaches before
          //      it is flushed to the client.
          //   2. Logs the full request after res finishes, using those timings.
          if (hasAppDir) {
            server.middlewares.use((req, res, next) => {
              const url = req.url ?? "/";
              // Skip Vite internals, HMR, and static assets.
              // Do NOT skip .rsc-suffixed URLs or RSC wire requests (Accept: text/x-component)
              // — those are soft navigations and should be logged like any other page request.
              const [pathname] = url.split("?");
              if (
                url.startsWith("/@") ||
                url.startsWith("/__vite") ||
                url.startsWith("/node_modules") ||
                (url.includes(".") && !pathname.endsWith(".html") && !pathname.endsWith(".rsc"))
              ) {
                return next();
              }
              const _reqStart = now();
              let _compileMs: number | undefined;
              let _renderMs: number | undefined;

              // Intercept setHeader and writeHead so we can strip X-Vinext-Timing
              // before it reaches the client and capture the compile/render split.
              // The RSC plugin may set headers either way depending on its version.
              // Parse the three-part X-Vinext-Timing header:
              //   "handlerStart,inHandlerCompileMs,renderMs"
              //
              // True compile time = time the RSC plugin spent loading/transforming
              // modules before our handler code ran, plus any in-handler work before
              // renderToReadableStream. Concretely:
              //   compileMs = (handlerStart - _reqStart) + inHandlerCompileMs
              //   renderMs  = renderMs from header, or -1 for RSC-only (soft-nav)
              //               responses where rendering is not measured in the handler.
              //               In that case the middleware computes render time as
              //               totalMs - compileMs.
              //
              // handlerStart is performance.now() recorded at the very top of
              // _handleRequest in the generated RSC entry. _reqStart is recorded
              // here in the Node middleware, one stack frame before the RSC plugin
              // loads the module. The gap between them is exactly the Vite
              // compile/transform cost.
              function _parseTiming(raw: unknown) {
                const [handlerStart, inHandlerCompileMs, renderMs] = String(raw).split(",").map((v) => Number(v));
                if (!Number.isNaN(handlerStart) && !Number.isNaN(inHandlerCompileMs) && inHandlerCompileMs !== -1) {
                  _compileMs = Math.max(0, Math.round(handlerStart - _reqStart)) + inHandlerCompileMs;
                }
                if (!Number.isNaN(renderMs) && renderMs !== -1) {
                  _renderMs = renderMs;
                }
              }

              const _origSetHeader = res.setHeader.bind(res);
              res.setHeader = function (name, value) {
                if (name.toLowerCase() === "x-vinext-timing") {
                  _parseTiming(value);
                  return res; // drop the header — don't forward to client
                }
                return _origSetHeader(name, value);
              };

              const _origWriteHead = res.writeHead.bind(res);
              res.writeHead = function (statusCode, ...args: any[]) {
                // Normalise the optional headers argument (may be reason, headers object, or both).
                let headers: Record<string, unknown> | undefined;
                const [reasonOrHeaders, maybeHeaders] = args;
                if (typeof reasonOrHeaders === "string") {
                  headers = maybeHeaders;
                } else {
                  headers = reasonOrHeaders;
                }

                // Pull timing out of the headers object when present.
                if (headers && typeof headers === "object" && !Array.isArray(headers)) {
                  const timingKey = Object.keys(headers).find(
                    (k) => k.toLowerCase() === "x-vinext-timing",
                  );
                  if (timingKey) {
                    _parseTiming(headers[timingKey]);
                    delete headers[timingKey];
                  }
                }

                return _origWriteHead(statusCode, ...args);
              };

              res.on("finish", () => {
                // Strip .rsc suffix — it's an internal RSC protocol detail,
                // not part of the actual page path the user navigated to.
                const logUrl = url.replace(/\.rsc(\?|$)/, "$1");
                const totalMs = now() - _reqStart;

                // For RSC-only responses (soft nav), renderMs is -1 (sentinel meaning
                // "not measured in the handler"). Compute it as totalMs - compileMs,
                // which is how long the RSC stream took to fully flush to the client —
                // matching what Next.js shows for soft navigations.
                const resolvedRenderMs = _renderMs !== undefined
                  ? _renderMs
                  : (_compileMs !== undefined ? Math.max(0, Math.round(totalMs - _compileMs)) : undefined);

                logRequest({
                  method: req.method ?? "GET",
                  url: logUrl,
                  status: res.statusCode,
                  totalMs,
                  compileMs: _compileMs,
                  renderMs: resolvedRenderMs,
                });
              });

              next();
            });
          }

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

              // ── Cross-origin request protection (defense-in-depth) ──────
              // The pre-Vite middleware above already blocks cross-origin
              // requests before Vite serves any content. This second check
              // guards the Pages Router handler specifically, in case the
              // middleware ordering changes or new middleware is added between
              // the two. Both calls use the same validateDevRequest() function.
              const blockReason = validateDevRequest(
                {
                  origin: req.headers.origin as string | undefined,
                  host: req.headers.host,
                  "x-forwarded-host": req.headers["x-forwarded-host"] as string | undefined,
                  "sec-fetch-site": req.headers["sec-fetch-site"] as string | undefined,
                  "sec-fetch-mode": req.headers["sec-fetch-mode"] as string | undefined,
                },
                nextConfig?.allowedDevOrigins,
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
                // Also block internal Vite paths (/@*, /__vite*, /node_modules*)
                // to prevent redirecting to dev server endpoints.
                if (
                  !imgUrl ||
                  !imgUrl.startsWith("/") ||
                  imgUrl.startsWith("//") ||
                  imgUrl.startsWith("/@") ||
                  imgUrl.startsWith("/__vite") ||
                  imgUrl.startsWith("/node_modules")
                ) {
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
              if (nextConfig && pathname !== "/" && pathname !== "/api" && !pathname.startsWith("/api/")) {
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
                const result = await runMiddleware(getPagesRunner(), middlewarePath, middlewareRequest);

                if (!result.continue) {
                  if (result.redirectUrl) {
                    const redirectHeaders: Record<string, string | string[]> = { Location: result.redirectUrl };
                    if (result.responseHeaders) {
                      for (const [key, value] of result.responseHeaders) {
                        const existing = redirectHeaders[key];
                        if (existing === undefined) {
                          redirectHeaders[key] = value;
                        } else if (Array.isArray(existing)) {
                          existing.push(value);
                        } else {
                          redirectHeaders[key] = [existing, value];
                        }
                      }
                    }
                    res.writeHead(result.redirectStatus ?? 307, redirectHeaders);
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

                // Apply middleware response headers. Unpack
                // x-middleware-request-* headers into req.headers so
                // config has/missing conditions and downstream handlers
                // see middleware-modified cookies and headers.
                if (result.responseHeaders) {
                  const mwReqPrefix = "x-middleware-request-";
                  for (const [key, value] of result.responseHeaders) {
                    if (key.startsWith(mwReqPrefix)) {
                      const realName = key.slice(mwReqPrefix.length);
                      req.headers[realName] = value;
                    } else if (!key.startsWith("x-middleware-")) {
                      res.appendHeader(key, value);
                    }
                  }
                }

                // Apply middleware rewrite (URL and optional status code)
                if (result.rewriteUrl) {
                  url = result.rewriteUrl;
                  // Write the rewritten URL back onto req.url so every subsequent
                  // handler in the connect chain sees the correct path. The local
                  // `url` variable is only visible within this handler — anything
                  // further down the chain (Vite's built-in middleware, the
                  // Cloudflare plugin's handler, or any other connect middleware)
                  // reads req.url directly. Without this, a middleware rewrite
                  // would be invisible to those handlers and the original URL
                  // would be dispatched instead.
                  req.url = url;
                }
                if (result.rewriteStatus) {
                  (req as any).__vinextRewriteStatus = result.rewriteStatus;
                }
              }

              // ── Cloudflare Workers dev mode ────────────────────────────
              // When @cloudflare/vite-plugin is present, ALL rendering runs
              // inside the miniflare Worker subprocess — both App Router (via
              // virtual:vinext-rsc-entry) and Pages Router (via
              // virtual:vinext-server-entry → renderPage/handleApiRoute).
              //
              // The Worker entry already handles config redirects, rewrites,
              // headers, and all routing internally. Running them here too
              // would duplicate that logic and produce incorrect behaviour
              // (double redirects, headers set on the wrong object, etc.).
              //
              // Middleware.ts is the only thing that belongs in the host connect
              // handler — it has already run above. Any terminal middleware
              // result (redirect, block response) has already been sent.
              // Any rewrite has been written back to req.url above so the
              // Cloudflare plugin's handler sees the correct path.
              //
              // Call next() to hand off to the Cloudflare plugin's connect
              // handler, which dispatches the request to miniflare.
              if (hasCloudflarePlugin) return next();

              // Build request context once for has/missing condition checks
              // across headers, redirects, and rewrites.
              // Convert Node.js IncomingMessage headers to a Web Request for
              // requestContextFromRequest(), which uses the standard Web API.
              const reqUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
              const reqCtxHeaders = new Headers(
                Object.fromEntries(
                  Object.entries(req.headers)
                    .filter(([, v]) => v !== undefined)
                    .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)])
                ),
              );
              const reqCtx: RequestContext = requestContextFromRequest(
                new Request(reqUrl, { headers: reqCtxHeaders }),
              );

              // Apply custom headers from next.config.js
              if (nextConfig?.headers.length) {
                applyHeaders(pathname, res, nextConfig.headers, reqCtx);
              }

              // Apply redirects from next.config.js
              if (nextConfig?.redirects.length) {
                const redirected = applyRedirects(
                  pathname,
                  res,
                  nextConfig.redirects,
                  reqCtx,
                );
                if (redirected) return;
              }

              // Apply rewrites from next.config.js (beforeFiles)
              let resolvedUrl = url;
              if (nextConfig?.rewrites.beforeFiles.length) {
                resolvedUrl =
                  applyRewrites(pathname, nextConfig.rewrites.beforeFiles, reqCtx) ??
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
                const apiRoutes = await apiRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher);
                const handled = await handleApiRoute(
                  server,
                  req,
                  res,
                  resolvedUrl,
                  apiRoutes,
                );
                if (handled) return;

                // No API route matched — if app dir exists, let the RSC plugin handle it
                // (app/api/* route handlers live there). Otherwise hard-404.
                if (hasAppDir) return next();

                res.statusCode = 404;
                res.end("404 - API route not found");
                return;
              }

              const routes = await pagesRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher);

              // Apply afterFiles rewrites — these run after initial route matching
              // If beforeFiles already rewrote the URL, afterFiles still run on the
              // *resolved* pathname. Next.js applies these when route matching succeeds
              // but allows overriding with rewrites.
              if (nextConfig?.rewrites.afterFiles.length) {
                const afterRewrite = applyRewrites(
                  resolvedUrl.split("?")[0],
                  nextConfig.rewrites.afterFiles,
                  reqCtx,
                );
                if (afterRewrite) resolvedUrl = afterRewrite;
              }

              // External rewrite from afterFiles — proxy to external URL
              if (isExternalUrl(resolvedUrl)) {
                await proxyExternalRewriteNode(req, res, resolvedUrl);
                return;
              }

              const handler = createSSRHandler(server, routes, pagesDir, nextConfig?.i18n, fileMatcher);
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
                  reqCtx,
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

              // No fallback matched - if app dir exists, let the RSC plugin handle it,
              // otherwise render via the pages SSR handler (will 404 for unknown routes).
              if (hasAppDir) return next();

              await handler(req, res, resolvedUrl, mwStatus);
            } catch (e) {
              next(e);
            }
          });
        };
      },
    },
    // Strip server-only data-fetching exports (getServerSideProps, getStaticProps,
    // getStaticPaths) from page modules in the client bundle. These functions
    // often import server-only modules (database drivers, fs, etc.) that would
    // break or bloat the client bundle. Next.js does this via an SWC transform
    // (next-ssg-transform); we use Vite's parseAst + MagicString.
    //
    // Only applies to client builds (not SSR) and only to files under the
    // pages/ directory.
    {
      name: "vinext:strip-server-exports",
      transform: {
        // Only match page source files, not node_modules
        filter: { id: /\.(tsx?|jsx?|mjs)$/ },
        handler(code, id) {
          const ssr = this.environment?.name !== "client";
          if (ssr) return null;
          if (!hasPagesDir) return null;
          // Only transform files under the pages/ directory
          if (!id.startsWith(pagesDir)) return null;
          // Skip API routes, _app, _document, _error
          const relativePath = id.slice(pagesDir.length);
          if (relativePath.startsWith("/api/") || relativePath === "/api") return null;
          if (/\/_(?:app|document|error)\b/.test(relativePath)) return null;

          const result = stripServerExports(code);
          if (!result) return null;
          return { code: result, map: null };
        },
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
              "Run: " + detectPackageManager(process.cwd()) + " @vitejs/plugin-rsc",
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
    // Inline binary assets fetched via `fetch(new URL("./asset", import.meta.url))`.
    //
    // Some bundled libraries (notably @vercel/og) load assets at module init time
    // with the pattern:
    //
    //   fetch(new URL("./some-font.ttf", import.meta.url)).then(res => res.arrayBuffer())
    //
    // This works in browser and standard Node.js because import.meta.url is a real
    // file:// URL. In Cloudflare Workers (both wrangler dev and production), however,
    // import.meta.url is the string "worker" — not a URL — so new URL(...) throws
    // "TypeError: Invalid URL string" and the Worker fails to start.
    //
    // Fix: at Vite transform time, find every such pattern, resolve the referenced
    // file relative to the module's actual path on disk (available as `id`), read it,
    // and replace the entire fetch(new URL(...)) expression with an inline base64 IIFE
    // that resolves synchronously. This eliminates the runtime fetch entirely and works
    // in all environments (workerd, Node.js, browser).
    //
    // Note: WASM files imported via `import ... from "./foo.wasm?module"` are handled
    // by the bundler/Vite directly and do not need this treatment. Only assets that
    // are runtime-fetched (not statically imported) need to be inlined here.
    {
      name: "vinext:og-inline-fetch-assets",
      enforce: "pre",
      transform(code, id) {
        // Quick bail-out: only process modules that use new URL(..., import.meta.url)
        if (!code.includes("import.meta.url")) {
          return null;
        }

        const moduleDir = path.dirname(id);
        let newCode = code;
        let didReplace = false;

        // Pattern 1 — edge build: fetch(new URL("./file", import.meta.url)).then((res) => res.arrayBuffer())
        // Replace with an inline IIFE that decodes the asset as base64 and returns Promise<ArrayBuffer>.
        if (code.includes("fetch(")) {
          const fetchPattern = /fetch\(\s*new URL\(\s*(["'])(\.\/[^"']+)\1\s*,\s*import\.meta\.url\s*\)\s*\)(?:\.then\(\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{?\s*return\s+[^.]+\.arrayBuffer\(\)\s*\}?\s*\)|\.then\(\s*\([^)]*\)\s*=>\s*[^.]+\.arrayBuffer\(\)\s*\))/g;

          for (const match of code.matchAll(fetchPattern)) {
            const fullMatch = match[0];
            const relPath = match[2]; // e.g. "./noto-sans-v27-latin-regular.ttf"
            const absPath = path.resolve(moduleDir, relPath);

            let fileBase64: string;
            try {
              fileBase64 = fs.readFileSync(absPath).toString("base64");
            } catch {
              // File not found on disk — skip (may be a runtime-only asset)
              continue;
            }

            // Replace fetch(...).then(...) with an inline IIFE that returns Promise<ArrayBuffer>.
            const inlined = [
              `(function(){`,
              `var b=${JSON.stringify(fileBase64)};`,
              `var r=atob(b);`,
              `var a=new Uint8Array(r.length);`,
              `for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);`,
              `return Promise.resolve(a.buffer);`,
              `})()`,
            ].join("");

            newCode = newCode.replaceAll(fullMatch, inlined);
            didReplace = true;
          }
        }

        // Pattern 2 — node build: readFileSync(fileURLToPath(new URL("./file", import.meta.url)))
        // Replace with Buffer.from("<base64>", "base64"), which returns a Buffer (compatible with
        // both font data passed to satori and WASM bytes passed to initWasm).
        if (code.includes("readFileSync(")) {
          const readFilePattern = /[a-zA-Z_$][a-zA-Z0-9_$]*\.readFileSync\(\s*(?:[a-zA-Z_$][a-zA-Z0-9_$]*\.)?fileURLToPath\(\s*new URL\(\s*(["'])(\.\/[^"']+)\1\s*,\s*import\.meta\.url\s*\)\s*\)\s*\)/g;

          for (const match of newCode.matchAll(readFilePattern)) {
            const fullMatch = match[0];
            const relPath = match[2]; // e.g. "./noto-sans-v27-latin-regular.ttf"
            const absPath = path.resolve(moduleDir, relPath);

            let fileBase64: string;
            try {
              fileBase64 = fs.readFileSync(absPath).toString("base64");
            } catch {
              // File not found on disk — skip
              continue;
            }

            // Replace readFileSync(...) with Buffer.from("<base64>", "base64").
            // Buffer is always available in Node.js and in the vinext SSR/RSC environments.
            const inlined = `Buffer.from(${JSON.stringify(fileBase64)},"base64")`;

            newCode = newCode.replaceAll(fullMatch, inlined);
            didReplace = true;
          }
        }

        if (!didReplace) return null;
        return { code: newCode, map: null };
      },
    },
    // Copy @vercel/og binary assets to the RSC output directory for production builds.
    //
    // The edge build (dist/index.edge.js) uses:
    //   - fetch(new URL("./noto-sans...", import.meta.url))  → inlined by og-inline-fetch-assets
    //   - import resvg_wasm from "./resvg.wasm?module"       → static Vite import, emitted by Rollup
    //
    // The node build (dist/index.node.js) uses:
    //   - fs.readFileSync(fileURLToPath(new URL("./noto-sans...", import.meta.url)))  → inlined
    //   - fs.readFileSync(fileURLToPath(new URL("./resvg.wasm", import.meta.url)))   → inlined
    //
    // Both builds' font + WASM assets are inlined as base64 by vinext:og-inline-fetch-assets,
    // so no file copy is strictly needed. This plugin is kept as a safety net for any edge-build
    // ?module WASM imports that Rollup/Vite might not emit correctly in the RSC environment.
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
          // The font is inlined as base64 by vinext:og-inline-fetch-assets, so only
          // the WASM needs to be present as a file alongside the bundle.
          const ogAssets = [
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
    // Write image config JSON for the App Router production server.
    // The App Router RSC entry doesn't export vinextConfig (that's a Pages
    // Router pattern), so we write a separate JSON file at build time that
    // prod-server.ts reads at startup for SVG/security header config.
    {
      name: "vinext:image-config",
      apply: "build",
      enforce: "post",
      writeBundle: {
        sequential: true,
        order: "post",
        handler(options) {
          const envName = this.environment?.name;
          if (envName !== "rsc") return;

          const outDir = options.dir;
          if (!outDir) return;

          const imageConfig = {
            dangerouslyAllowSVG: nextConfig?.images?.dangerouslyAllowSVG,
            contentDispositionType: nextConfig?.images?.contentDispositionType,
            contentSecurityPolicy: nextConfig?.images?.contentSecurityPolicy,
          };

          fs.writeFileSync(
            path.join(outDir, "image-config.json"),
            JSON.stringify(imageConfig),
          );
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
            fs.mkdirSync(clientDir, { recursive: true });
            fs.writeFileSync(headersPath, headersContent);
          }
        },
      },
    },
    {
      // @vercel/og patch for workerd (cloudflare-dev + cloudflare-workers)
      //
      // @vercel/og/dist/index.edge.js has one remaining workerd issue after the
      // generic vinext:og-inline-fetch-assets plugin runs (which already handles
      // the font fetch pattern):
      //
      // YOGA WASM: yoga-layout embeds its WASM as a base64 data URL and instantiates
      // it via WebAssembly.instantiate(bytes) at runtime.
      // workerd forbids dynamic WASM compilation from bytes — WASM must be loaded
      // through the module system as a pre-compiled WebAssembly.Module.
      // Fix: extract the yoga WASM bytes at Vite transform time (Node.js), write
      // yoga.wasm to @vercel/og/dist/, import it via `?module` so @cloudflare/vite-plugin
      // can serve it through the module system, and inject h2.instantiateWasm to
      // use the pre-compiled module instead of bytes.
      name: "vinext:og-font-patch",
      enforce: "pre" as const,
      transform(code: string, id: string) {
        if (!id.includes("@vercel/og") || !id.includes("index.edge.js")) return null;
        let result = code;

        // ── Extract yoga WASM and import via ?module ──────────────────────────────────
        // yoga-layout's emscripten bundle sets H to a data URL containing the yoga WASM,
        // then later calls WebAssembly.instantiate(bytes, imports), which workerd rejects.
        // Emscripten supports a custom h2.instantiateWasm(imports, callback) escape hatch
        // that we inject to use a pre-compiled WebAssembly.Module loaded via ?module.
        const YOGA_DATA_URL_RE = /H = "data:application\/octet-stream;base64,([A-Za-z0-9+/]+=*)";/;
        const yogaMatch = YOGA_DATA_URL_RE.exec(result);
        if (yogaMatch) {
          const yogaBase64 = yogaMatch[1];
          const distDir = path.dirname(id);
          const yogaWasmPath = path.join(distDir, "yoga.wasm");
          // Write yoga.wasm to disk idempotently at transform time (Node.js side)
          if (!fs.existsSync(yogaWasmPath)) {
            fs.writeFileSync(yogaWasmPath, Buffer.from(yogaBase64, "base64"));
          }
          // Disable the data-URL branch so emscripten doesn't try to instantiate from bytes
          result = result.replace(yogaMatch[0], `H = "";`);
          // Patch the loadYoga call site to inject instantiateWasm using the ?module import
          const YOGA_CALL = `yoga_wasm_base64_esm_default()`;
          const YOGA_CALL_PATCHED =
            `yoga_wasm_base64_esm_default({ instantiateWasm: function(imports, callback) {` +
            ` WebAssembly.instantiate(yoga_wasm_module, imports).then(function(inst) { callback(inst); });` +
            ` return {}; } })`;
          result = result.replace(YOGA_CALL, YOGA_CALL_PATCHED);
          // Prepend the yoga wasm ?module import so @cloudflare/vite-plugin handles it
          result = `import yoga_wasm_module from "./yoga.wasm?module";\n` + result;
        }

        if (result === code) return null;
        return { code: result, map: null };
      },
    },
  ];

  // Append auto-injected RSC plugins if applicable
  if (rscPluginPromise) {
    plugins.push(rscPluginPromise);
  }

  return plugins;
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

// matchConfigPattern is imported from config-matchers.ts and re-exported
// for tests and other consumers that import it from vinext's main entry.
// The duplicate local implementation and its extractConstraint helper
// have been removed in favor of the canonical config-matchers.ts version
// which uses a single-pass tokenizer (fixing the chained .replace()
// divergence that CodeQL flagged as incomplete sanitization).
export { matchConfigPattern } from "./config/config-matchers.js";

/**
 * Strip server-only data-fetching exports (getServerSideProps,
 * getStaticProps, getStaticPaths) from page modules for the client
 * bundle. Uses Vite's parseAst (Rollup/acorn) for correct handling
 * of all export patterns including function expressions, arrow
 * functions with TS return types, and re-exports.
 *
 * Modeled after Next.js's SWC `next-ssg-transform`.
 */
function stripServerExports(code: string): string | null {
  const SERVER_EXPORTS = new Set(["getServerSideProps", "getStaticProps", "getStaticPaths"]);
  if (![...SERVER_EXPORTS].some(name => code.includes(name))) return null;

  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code);
  } catch {
    // If parsing fails (shouldn't happen post-JSX/TS transform), bail out
    return null;
  }

  const s = new MagicString(code);
  let changed = false;

  for (const node of ast.body as any[]) {
    if (node.type !== "ExportNamedDeclaration") continue;

    // Case 1: export function name() {} / export async function name() {}
    // Case 2: export const/let/var name = ...
    if (node.declaration) {
      const decl = node.declaration;
      if (decl.type === "FunctionDeclaration" && SERVER_EXPORTS.has(decl.id?.name)) {
        s.overwrite(node.start, node.end, `export function ${decl.id.name}() { return { props: {} }; }`);
        changed = true;
      } else if (decl.type === "VariableDeclaration") {
        for (const declarator of decl.declarations) {
          if (declarator.id?.type === "Identifier" && SERVER_EXPORTS.has(declarator.id.name)) {
            s.overwrite(node.start, node.end, `export const ${declarator.id.name} = undefined;`);
            changed = true;
          }
        }
      }
      continue;
    }

    // Case 3: export { getServerSideProps } or export { getServerSideProps as gSSP }
    if (node.specifiers && node.specifiers.length > 0 && !node.source) {
      const kept: any[] = [];
      const stripped: string[] = [];
      for (const spec of node.specifiers) {
        // spec.local.name is the binding name, spec.exported.name is the export name
        const exportedName = spec.exported?.name ?? spec.exported?.value;
        if (SERVER_EXPORTS.has(exportedName)) {
          stripped.push(exportedName);
        } else {
          kept.push(spec);
        }
      }
      if (stripped.length > 0) {
        // Build replacement: keep non-server specifiers, add stubs for stripped ones
        const parts: string[] = [];
        if (kept.length > 0) {
          const keptStr = kept.map((sp: any) => {
            const local = sp.local.name;
            const exported = sp.exported?.name ?? sp.exported?.value;
            return local === exported ? local : `${local} as ${exported}`;
          }).join(", ");
          parts.push(`export { ${keptStr} };`);
        }
        for (const name of stripped) {
          parts.push(`export const ${name} = undefined;`);
        }
        s.overwrite(node.start, node.end, parts.join("\n"));
        changed = true;
      }
    }
  }

  if (!changed) return null;
  return s.toString();
}


/**
 * Apply redirect rules from next.config.js.
 * Returns true if a redirect was applied.
 */
function applyRedirects(
  pathname: string,
  res: any,
  redirects: NextRedirect[],
  ctx: RequestContext,
): boolean {
  const result = matchRedirect(pathname, redirects, ctx);
  if (result) {
    // Sanitize to prevent open redirect via protocol-relative URLs
    const dest = sanitizeDestination(result.destination);
    res.writeHead(result.permanent ? 308 : 307, { Location: dest });
    res.end();
    return true;
  }
  return false;
}

/*
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
  ctx: RequestContext,
): string | null {
  const dest = matchRewrite(pathname, rewrites, ctx);
  if (dest) {
    // Sanitize to prevent open redirect via protocol-relative URLs
    return sanitizeDestination(dest);
  }
  return null;
}

/**
 * Apply custom header rules from next.config.js.
 * Middleware headers take precedence: if a header key was already set on the
 * response (by middleware), the config value is skipped for that key.
 */
function applyHeaders(
  pathname: string,
  res: any,
  headers: NextHeader[],
  ctx: RequestContext,
): void {
  const matched = matchHeaders(pathname, headers, ctx);
  for (const header of matched) {
    // Use append semantics for headers where multiple values must coexist
    // (Vary, Set-Cookie). Using setHeader() on these would destroy
    // existing values like "Vary: RSC, Accept".
    const lk = header.key.toLowerCase();
    if (lk === "set-cookie") {
      // Node.js res.getHeader("set-cookie") returns string[] when
      // multiple Set-Cookie headers have been set. Preserve the array.
      const existing = res.getHeader(lk);
      if (Array.isArray(existing)) {
        res.setHeader(header.key, [...existing, header.value]);
      } else if (existing) {
        res.setHeader(header.key, [String(existing), header.value]);
      } else {
        res.setHeader(header.key, header.value);
      }
    } else if (lk === "vary") {
      const existing = res.getHeader(lk);
      if (existing) {
        res.setHeader(header.key, existing + ", " + header.value);
      } else {
        res.setHeader(header.key, header.value);
      }
    } else {
      // Middleware headers take precedence: skip config keys already set by
      // middleware so middleware always wins over next.config.js headers.
      if (!res.getHeader(lk)) {
        res.setHeader(header.key, header.value);
      }
    }
  }
}

/**
 * Find a file by name (without extension) in a directory.
 * Checks the configured page extensions.
 */
function findFileWithExts(
  dir: string,
  name: string,
  matcher: ReturnType<typeof createValidFileMatcher>,
): string | null {
  for (const ext of matcher.dottedExtensions) {
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

// Export NextConfig type so next.config.ts files can import it from "vinext"
// instead of "next".
export type { NextConfig } from "./config/next-config.js";

// Exported for CLI and testing
export { clientManualChunks, clientOutputConfig, clientTreeshakeConfig, computeLazyChunks };
export { resolvePostcssStringPlugins as _resolvePostcssStringPlugins };
export { parseStaticObjectLiteral as _parseStaticObjectLiteral };
export { stripServerExports as _stripServerExports };
export { asyncHooksStubPlugin as _asyncHooksStubPlugin };
