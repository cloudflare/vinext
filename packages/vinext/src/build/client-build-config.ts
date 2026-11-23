import { createHash } from "node:crypto";
import type { UserConfig } from "vite";
import path, { toSlash } from "pathslash";
import { WORKER_IMAGE_METADATA_PREFIX } from "../plugins/worker-image-imports.js";
import { stripViteModuleQuery } from "../utils/path.js";

type ClientAssetFileNameInfo = {
  readonly name?: string;
  readonly names?: readonly string[];
  readonly originalFileName?: string;
  readonly originalFileNames?: readonly string[];
};

const ROUTE_OWNED_CLIENT_SHIMS = new Set([
  "app-router-tree-context",
  "compat-router",
  "dynamic",
  "dynamic-preload-chunks",
  "form",
  "image",
  // Only image-props imports it. A group also takes in its modules'
  // dependencies, so in "vinext" it would load ipaddr.js on every page.
  "image-config",
  "image-props",
  "internal/hybrid-client-route-owner",
  "layout-segment-context",
  "legacy-image",
  "link",
  "offline",
  "router",
  "script",
  "web-vitals",
]);

// Shims that only pages import: the Pages client entry and router never do.
// Pages builds leave them to graph-based chunking so they load with the pages
// that use them, instead of with the shared "vinext" chunk on every page. The
// shims the entry imports stay in "vinext", so page chunks never import the
// entry chunk. `image-config` is listed because a group also takes in its
// modules' dependencies, so it would keep ipaddr.js in "vinext".
const PAGE_OWNED_CLIENT_SHIMS = new Set([
  "dynamic",
  "dynamic-preload-chunks",
  "form",
  "image",
  "image-config",
  "image-props",
  "legacy-image",
  "offline",
  "script",
  "web-vitals",
  // next/error imports next/navigation. The router still loads it lazily for
  // the default error page.
  "error",
]);

// The App Router navigation runtime: the prefetch cache, history writes and
// navigation. Only the App Router browser entry imports it statically; next/link
// loads it lazily and next/form imports it. Builds with Pages Router pages give
// it a chunk of its own. In "vinext" it, and its server/ dependencies, would
// load on every Pages Router page; left to graph-based chunking, Link's lazy App
// Router imports would split it into many small chunks. App-only builds keep it
// in "vinext": every page loads it, so its own chunk would be an extra request.
const APP_ROUTER_RUNTIME_SHIMS = new Set([
  "app-router-navigation",
  "app-router-scroll-state",
  "internal/app-prefetch-rsc-request",
]);

// Modules the App Router navigation runtime shares with next/link, next/router
// and the config matchers. A group also takes in its modules' dependencies, so
// these would otherwise join "vinext-app-router" and every page using those
// shims would load the runtime.
const APP_ROUTER_RUNTIME_SHARED_MODULES = new Set([
  "client/navigation-runtime",
  "server/headers",
  "utils/external-url",
  "utils/html-limited-bots",
]);

// The next/navigation hooks and the client navigation state they read. A
// Pages-only build gives them a chunk of their own, which loads only with the
// pages that import next/navigation or next/error. They can't join the App
// Router runtime's chunk, which imports them: those pages would load the
// runtime too.
const PAGES_NAVIGATION_SHIMS = new Set([
  "internal/navigation-untracked",
  "internal/pages-router-accessor",
  "navigation",
  "navigation-context-state",
  "navigation-errors",
  "ppr-fallback-shell",
  "readonly-url-search-params",
  "unrecognized-action-error",
]);

// Next.js emits CSS under `static/css/` as `[contenthash].css` and CSS url()
// dependencies (images, fonts, …) under `static/media/` as
// `[name].[hash:8][ext]`. Mirror that layout so migrated apps keep stable,
// Next-shaped asset URLs, and CSS URLs never expose source file names.
const NEXT_CLIENT_CSS_ASSET_FILE_NAMES = "css/[hash][extname]";
const NEXT_CLIENT_STATIC_MEDIA_FILE_NAMES = "media/[name].[hash:8][extname]";

function joinAssetFileNamePattern(assetsDir: string, pattern: string): string {
  // Strip trailing slashes without a regex (avoids a needless ReDoS lint flag;
  // `assetsDir` is build-time config, but a plain loop is clearer and linear).
  let end = assetsDir.length;
  while (end > 0 && assetsDir[end - 1] === "/") end -= 1;
  const normalized = assetsDir.slice(0, end);
  return normalized ? `${normalized}/${pattern}` : pattern;
}

/**
 * Routes client assets into Next-compatible subtrees: `.css` sources go to
 * `<assetsDir>/css/`, everything else to `<assetsDir>/media/`. Returned as a
 * function so it can inspect every source-name candidate Rolldown records for
 * an asset (a single output asset can carry several `originalFileNames`).
 */
export function createClientAssetFileNames(assetsDir: string) {
  const cssAssetFileNames = joinAssetFileNamePattern(assetsDir, NEXT_CLIENT_CSS_ASSET_FILE_NAMES);
  const mediaAssetFileNames = joinAssetFileNamePattern(
    assetsDir,
    NEXT_CLIENT_STATIC_MEDIA_FILE_NAMES,
  );

  return function getClientAssetFileNames(assetInfo: ClientAssetFileNameInfo): string {
    const candidates = [
      ...(assetInfo.names ?? []),
      assetInfo.name,
      ...(assetInfo.originalFileNames ?? []),
      assetInfo.originalFileName,
    ];
    const isCss = candidates.some((name) => name?.toLowerCase().endsWith(".css"));
    return isCss ? cssAssetFileNames : mediaAssetFileNames;
  };
}

/**
 * Extract the npm package name from a module ID (file path).
 * Returns null if not in node_modules.
 *
 * Handles scoped packages (@org/pkg) and pnpm-style paths
 * (node_modules/.pnpm/pkg@ver/node_modules/pkg).
 */
function getPackageName(id: string): string | null {
  const normalizedId = toSlash(id);
  const nmIdx = normalizedId.lastIndexOf("node_modules/");
  if (nmIdx === -1) return null;
  const rest = normalizedId.slice(nmIdx + "node_modules/".length);
  if (rest.startsWith("@")) {
    // Scoped package: @org/pkg
    const parts = rest.split("/");
    return parts.length >= 2 ? parts[0] + "/" + parts[1] : null;
  }
  return rest.split("/")[0] || null;
}

/**
 * The App Router client build module that registers the client references
 * whose modules are in the "vinext" chunk (see
 * plugins/rsc-client-reference-loaders.ts). It joins that chunk, so it loads
 * with the browser entry without adding to the entry's own chunk.
 */
export const RESOLVED_EAGER_CLIENT_REFERENCES_ID = "\0virtual:vinext-client-reference-eager";

/**
 * Create a manualChunks function for client builds.
 *
 * Splits the client bundle into:
 * - "framework" — React, ReactDOM, and scheduler (loaded on every page)
 * - "vinext"    — shared vinext runtime shims
 * - "vinext-navigation" — the next/navigation hooks, in Pages Router builds
 * - "vinext-app-router" — the App Router navigation runtime, in builds with
 *   Pages Router pages
 *
 * Route-owned (App Router) or page-owned (Pages Router) client shims and all
 * other vendor code are left to the bundler's graph-based chunking so they
 * load only where they're used.
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
 * - The bundler's graph-based splitting already handles the common case
 *   well: shared dependencies between routes get their own chunks,
 *   and route-specific code stays in route chunks.
 */
export function createClientManualChunks(
  shimsDir: string,
  preserveRouteBoundaries = false,
  splitAppRouterRuntime = true,
) {
  // Both client entries import this hook state, and so does next/navigation.
  // Keep it in "vinext" so a navigation chunk never imports the entry chunk.
  const instrumentationStatePrefix = path.join(shimsDir, "../client/instrumentation-client-state.");
  const sourceDir = toSlash(path.join(shimsDir, "../"));
  return function clientManualChunks(id: string): string | undefined {
    // Check the shims prefix before the node_modules branch: for an installed
    // copy the shims live under <app>/node_modules/vinext/dist/shims/, so the
    // node_modules early return would otherwise swallow them and the "vinext"
    // chunk would never form, leaving the shims to graph-based splitting that
    // can place them in a static import cycle with the browser entry chunk.
    //
    // `shimsDir` is slash-normalized with a trailing slash; the bundler-provided
    // id can carry native backslashes on Windows, so slash it before matching.
    if (id === RESOLVED_EAGER_CLIENT_REFERENCES_ID) return "vinext";
    const slashedId = toSlash(id);
    if (slashedId.startsWith(shimsDir)) {
      const relativeId = slashedId.slice(shimsDir.length).split("?", 1)[0] ?? "";
      const extensionIndex = relativeId.lastIndexOf(".");
      const shimName = extensionIndex === -1 ? relativeId : relativeId.slice(0, extensionIndex);
      const ownedShims = preserveRouteBoundaries
        ? ROUTE_OWNED_CLIENT_SHIMS
        : PAGE_OWNED_CLIENT_SHIMS;
      if (ownedShims.has(shimName)) return undefined;
      if (splitAppRouterRuntime && APP_ROUTER_RUNTIME_SHIMS.has(shimName)) {
        return "vinext-app-router";
      }
      if (!preserveRouteBoundaries && PAGES_NAVIGATION_SHIMS.has(shimName)) {
        return "vinext-navigation";
      }
      return "vinext";
    }
    if (slashedId.startsWith(instrumentationStatePrefix)) return "vinext";
    if (slashedId.startsWith(sourceDir)) {
      const relativeId = slashedId.slice(sourceDir.length).split("?", 1)[0] ?? "";
      const extensionIndex = relativeId.lastIndexOf(".");
      const moduleName = extensionIndex === -1 ? relativeId : relativeId.slice(0, extensionIndex);
      if (APP_ROUTER_RUNTIME_SHARED_MODULES.has(moduleName)) return "vinext";
    }

    // React framework — always loaded, shared across all pages.
    // Isolating React into its own chunk is the single highest-value
    // split: it's ~130KB compressed, loaded on every page, and its
    // content hash rarely changes between deploys.
    if (id.includes("node_modules")) {
      const pkg = getPackageName(id);
      if (!pkg) return undefined;
      if (pkg === "react-dom") {
        // The server renderer (Fizz: renderToString / renderToReadableStream /
        // renderToStaticMarkup, plus the prerender "static" APIs) is only needed
        // by client code that explicitly imports those APIs.
        // Keying the always-loaded "framework" chunk on the bare package name
        // ("react-dom") would otherwise drag react-dom/server.browser — and its
        // sizeable cjs implementation — into every page, even though most client
        // routes do not render to a string (an embedded Sanity Studio is one
        // example that does). Split those entrypoints into their own chunk
        // so the server renderer loads lazily, only on routes that use it,
        // instead of weighing down first paint on every page.
        const sub = slashedId.slice(slashedId.lastIndexOf("react-dom/") + "react-dom/".length);
        if (
          sub.startsWith("server.") ||
          sub.startsWith("static.") ||
          sub.startsWith("cjs/react-dom-server")
        ) {
          return "react-dom-server";
        }
        return "framework";
      }
      if (pkg === "react" || pkg === "scheduler") {
        return "framework";
      }
      // Let the bundler handle all other vendor code via its default
      // graph-based splitting. This produces a reasonable number of
      // shared chunks (typically 5-15) based on actual import patterns,
      // with good compression efficiency.
      return undefined;
    }

    return undefined;
  };
}

/**
 * Client JS is emitted as hash-only `<assetsDir>/chunks/[hash].js`. Rolldown
 * names a chunk after its first module, so `[name]` would publish component
 * and source file names in public asset URLs. Next.js doesn't put component
 * names in production chunk URLs either: webpack names split chunks by
 * deterministic numeric id. Users can opt back into `[name]` through their own
 * Vite config; see createClientOutputFileNameDefaults.
 */
function createClientFileNameConfig(assetsDir: string) {
  const chunksDir = `${assetsDir}/chunks`;
  return {
    entryFileNames: `${chunksDir}/[hash].js`,
    chunkFileNames: `${chunksDir}/[hash].js`,
  };
}

/**
 * Web Worker output names. Workers are hash-only like client chunks, so their
 * URLs don't publish source file names. Vite bundles each worker separately
 * and stores the outputs by file name, so two workers' entries or chunks with
 * identical code would share `[hash].js` and one's source map would overwrite
 * the other's. Each name therefore also carries an opaque id derived from the
 * chunk's module ids (root-relative for files).
 */
export function createWorkerFileNames(assetsDir: string, root: string) {
  const workersDir = `${assetsDir}/workers`;
  const fileName = (chunk: { facadeModuleId: string | null; moduleIds?: readonly string[] }) => {
    const ids = chunk.facadeModuleId ? [chunk.facadeModuleId] : (chunk.moduleIds ?? []);
    // Each id is serialized with a tag, so distinct ids never collide.
    // Absolute file paths are made root-relative, keeping their query
    // (`lazy.js?one` and `lazy.js?two` are distinct modules), and so is the
    // image path in vinext's worker image metadata ids. Other ids are kept
    // verbatim: path.relative would resolve a virtual id against the cwd.
    // Names thus don't depend on where the app lives or the build was launched.
    const chunkId = JSON.stringify(
      ids.map((id) => {
        const file = stripViteModuleQuery(id);
        if (path.isAbsolute(file)) {
          return ["file", toSlash(path.relative(root, file)) + id.slice(file.length)];
        }
        const imagePath = id.startsWith(WORKER_IMAGE_METADATA_PREFIX)
          ? id.slice(WORKER_IMAGE_METADATA_PREFIX.length)
          : undefined;
        if (imagePath !== undefined && path.isAbsolute(imagePath)) {
          return ["image-meta", toSlash(path.relative(root, imagePath))];
        }
        return ["id", id];
      }),
    );
    const idHash = createHash("sha256").update(chunkId).digest("hex").slice(0, 8);
    return `${workersDir}/${idHash}-[hash].js`;
  };
  return { entryFileNames: fileName, chunkFileNames: fileName };
}

/**
 * vinext's client output file names, limited to the ones the incoming client
 * environment config leaves unset. Vite merges `config` hook results over the
 * user's config, so vinext applies these from `configEnvironment` instead: by
 * then the user's top-level `build` and `environments.client.build` are merged
 * into the client environment, and a user-provided pattern wins.
 *
 * Returns null for array-shaped output, which cannot be augmented without Vite
 * concatenating a second output entry. Array-shaped client output is advanced
 * config vinext doesn't support: Vite also appends vinext's own client output
 * object (code splitting) to the user's array, producing an extra bundle.
 */
export function createClientOutputFileNameDefaults(
  output: VinextBuildBundlerOptions["output"],
  assetsDir: string,
) {
  if (Array.isArray(output)) return null;
  const configured = output ?? {};
  const { entryFileNames, chunkFileNames } = createClientFileNameConfig(assetsDir);
  return {
    ...(configured.entryFileNames === undefined ? { entryFileNames } : {}),
    ...(configured.chunkFileNames === undefined ? { chunkFileNames } : {}),
    ...(configured.assetFileNames === undefined
      ? { assetFileNames: createClientAssetFileNames(assetsDir) }
      : {}),
  };
}

/** Entry, chunk and asset file names from a (non-array) bundler output config. */
export function getOutputFileNames(
  output: VinextBuildBundlerOptions["output"],
): Pick<VinextBuildOutput, "entryFileNames" | "chunkFileNames" | "assetFileNames"> {
  if (!output || Array.isArray(output)) return {};
  const { entryFileNames, chunkFileNames, assetFileNames } = output;
  return { entryFileNames, chunkFileNames, assetFileNames };
}

/**
 * User-provided client file name patterns vinext cannot serve correctly:
 * - outside `assetsDir`: built-asset URLs, immutable caching and
 *   precompression all assume client output lives there;
 * - without `[hash]`: everything under `assetsDir` is served
 *   `immutable`, so an unhashed URL would pin stale code for a year;
 * - JS not ending in `.js`: client metadata and Pages Router script
 *   tags only recognize `.js` chunks;
 * - assets not ending in `[extname]` (or `.[ext]`): CSS without its real
 *   extension is served as `application/octet-stream` and rejected by browsers.
 * - asset basenames not starting with `[name].` or `[name]-`: restoring CSS
 *   `url()` assets deduplicated across builds swaps the source stem at the
 *   start of the emitted basename (see css-url-assets.ts), so any other
 *   placement or delimiter drops the hash from the restored sibling.
 * This is a guard against common mistakes, not full validation: function
 * patterns and array-shaped output are advanced config left to the user to
 * keep within these rules.
 */
export function findUnsupportedClientOutputFileNames(
  output: VinextBuildBundlerOptions["output"],
  assetsDir: string,
): string[] {
  if (!output || Array.isArray(output)) return [];
  const unsupported: string[] = [];
  for (const key of ["entryFileNames", "chunkFileNames", "assetFileNames"] as const) {
    const value = output[key];
    if (typeof value !== "string") continue;
    const problems = [
      !value.startsWith(`${assetsDir}/`) && `outside "${assetsDir}/"`,
      !value.includes("[hash") && "no [hash]",
      key !== "assetFileNames" && !value.endsWith(".js") && 'not ".js"',
      key === "assetFileNames" &&
        !value.endsWith("[extname]") &&
        !value.endsWith(".[ext]") &&
        "not ending in [extname]",
      key === "assetFileNames" &&
        !/^\[name\][.-]/.test(value.slice(value.lastIndexOf("/") + 1)) &&
        'basename not starting with "[name]." or "[name]-"',
    ].filter(Boolean);
    if (problems.length > 0) {
      unsupported.push(`${key}: ${JSON.stringify(value)} (${problems.join(", ")})`);
    }
  }
  return unsupported;
}

export function createClientCodeSplittingConfig(
  clientManualChunks: (id: string) => string | undefined,
) {
  const chunkGroup = (chunkName: string) => ({
    name(moduleId: string) {
      return clientManualChunks(moduleId) === chunkName ? chunkName : null;
    },
  });
  // A group also takes in its modules' dependencies that no earlier group has
  // taken. Groups are ordered from the most widely loaded chunk down, so
  // "vinext" (every page) never imports "vinext-navigation" (the pages that use
  // next/navigation), and neither imports "vinext-app-router". They keep the
  // default priority so user and plugin groups, merged ahead of them, still
  // win. The next/navigation hooks are smaller than `minSize`, which would drop
  // their chunk and leave them to the App Router runtime's.
  return {
    minSize: 10_000,
    groups: [
      {
        name(moduleId: string) {
          const chunkName = clientManualChunks(moduleId);
          return chunkName === "vinext-navigation" || chunkName === "vinext-app-router"
            ? null
            : (chunkName ?? null);
        },
      },
      { ...chunkGroup("vinext-navigation"), minSize: 0 },
      chunkGroup("vinext-app-router"),
    ],
  };
}

/**
 * Collect the modules that root the Pages Router "pages-app" chunk: `_app`'s
 * static imports, short of the modules the first vinext group takes ahead of
 * it ("framework", "vinext" and "react-dom-server"). Every page loads `_app`,
 * so splitting its imports only adds requests: a module that `_app` and some
 * pages both import would otherwise get a shared chunk of its own. Next.js
 * keeps `pages/_app` unsplit for the same reason. `_app`'s next/navigation
 * hooks load on every page too, so they join it rather than load on their own.
 *
 * Rolldown adds what these modules use to the chunk (following only the
 * re-exports of a side-effect-free barrel that are used), while `_app` itself
 * keeps its own chunk: the client entry imports it, and the Pages manifests
 * look it up by its source path. An import that statically leads back to
 * `_app` or to an app module the client entry loads (a page, which it loads
 * with `import()`, or instrumentation-client and what that loads) stays out:
 * Rolldown would pull that module into the group too, and the entry would then
 * load the whole group before `_app`. Modules the first group takes with its
 * own (vinext's runtime helpers) don't count.
 */
export function collectPagesAppChunkRoots(
  appId: string,
  moduleIds: Iterable<string>,
  getModuleInfo: (id: string) => {
    readonly isEntry: boolean;
    readonly importedIds: readonly string[];
    readonly importers: readonly string[];
    readonly dynamicImporters: readonly string[];
  } | null,
  clientManualChunks: (id: string) => string | undefined,
): Set<string> {
  // Modules the first group doesn't name may join the "pages-app" chunk.
  const joinsGroup = (id: string) => {
    const chunkName = clientManualChunks(id);
    return (
      chunkName === undefined ||
      chunkName === "vinext-navigation" ||
      chunkName === "vinext-app-router"
    );
  };

  // Every module that `ids` load statically, `ids` included.
  const closure = (ids: string[]) => {
    const modules = new Set<string>();

    while (ids.length > 0) {
      const id = ids.pop()!;
      if (modules.has(id)) continue;

      modules.add(id);
      ids.push(...(getModuleInfo(id)?.importedIds ?? []));
    }

    return modules;
  };

  // Seed the modules that must stay out: `_app`, and what the client entry
  // loads beyond the first group's own modules, statically or with `import()`.
  const leadsToEntry = new Set([appId]);
  const entries: string[] = [];
  const firstGroupModules: string[] = [];
  const dynamicTargets: string[] = [];

  for (const id of moduleIds) {
    const info = getModuleInfo(id);
    if (info?.isEntry) entries.push(id);

    if (!joinsGroup(id)) firstGroupModules.push(id);
    else if (info?.dynamicImporters.length) dynamicTargets.push(id);
  }

  const firstGroupTakes = closure(firstGroupModules);
  const entryModules = closure(entries);
  for (const id of entryModules) {
    if (joinsGroup(id) && !firstGroupTakes.has(id)) leadsToEntry.add(id);
  }
  // Other `import()` targets load after `_app`, like a `next/dynamic`
  // component of a page. One that `_app`'s imports reach statically loads with
  // them anyway, and this graph is from before tree-shaking, which may drop an
  // `import()` of a package's unused export.
  for (const id of dynamicTargets) {
    const info = getModuleInfo(id);
    if (info?.dynamicImporters.some((importer) => entryModules.has(importer))) {
      leadsToEntry.add(id);
    }
  }

  // Anything that statically imports one of those leads to it too.
  const pending = [...leadsToEntry];
  while (pending.length > 0) {
    for (const importer of getModuleInfo(pending.pop()!)?.importers ?? []) {
      if (leadsToEntry.has(importer)) continue;

      leadsToEntry.add(importer);
      pending.push(importer);
    }
  }

  const roots = new Set<string>();
  for (const id of getModuleInfo(appId)?.importedIds ?? []) {
    if (joinsGroup(id) && !leadsToEntry.has(id)) roots.add(id);
  }

  // Stylesheets that only `_app` imports stay in its chunk: a chunk of only
  // stylesheets still gets a JavaScript file under strict execution order,
  // which wraps even their empty modules, so every page would load it for
  // nothing. One that a page imports too keeps the group, so it loads once,
  // in `_app`'s import order.
  const onlyAppStylesheets = [...roots].every(
    (id) =>
      isStylesheetModule(id) &&
      (getModuleInfo(id)?.importers ?? []).every((importer) => importer === appId),
  );
  if (onlyAppStylesheets) return new Set();

  return roots;
}

/**
 * Pages Router code splitting: vinext's groups, with the "pages-app" chunk of
 * {@link collectPagesAppChunkRoots} after the first one. The returned group
 * reads `appRoots` when Rolldown chunks the bundle, so a plugin fills it in
 * once the client module graph is known.
 */
export function createPagesClientCodeSplittingConfig(
  base: ReturnType<typeof createClientCodeSplittingConfig>,
  appRoots: ReadonlySet<string>,
) {
  const [first, ...rest] = base.groups;

  const pagesAppGroup = {
    name(moduleId: string) {
      return appRoots.has(moduleId) ? "pages-app" : null;
    },
    // `_app` may import less than the default `minSize`.
    minSize: 0,
  };

  return { pagesAppGroup, codeSplitting: { ...base, groups: [first!, pagesAppGroup, ...rest] } };
}

/**
 * Next.js' webpack `splitChunks.minSize` for Pages Router builds: a module
 * group shared by pages but smaller than this is copied into each of them
 * rather than loaded as a chunk of its own.
 */
export const PAGES_INLINE_COMMON_CHUNK_MAX_SIZE = 20_000;

export const STYLESHEET_MODULE_RE = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;
const NON_STYLESHEET_QUERY_RE = /[?&](?:inline|url|raw|transform-only)\b/;

/**
 * Whether `id` is a stylesheet whose CSS goes into its chunk's stylesheet,
 * short of `?inline`, `?url` and `?raw` imports (and the `?transform-only`
 * module behind a `?url` one).
 */
export function isStylesheetModule(id: string): boolean {
  return STYLESHEET_MODULE_RE.test(id) && !NON_STYLESHEET_QUERY_RE.test(id);
}

/**
 * Collect the stylesheets that must keep a chunk of their own: those that the
 * same set of entries (the client entry, pages, `import()` targets) loads
 * statically, when together they hold at least
 * {@link PAGES_INLINE_COMMON_CHUNK_MAX_SIZE} of CSS. Rolldown groups a common
 * chunk's modules by that set, and webpack applies `minSize` to the CSS of
 * each such group, so the CSS a set of pages shares gets one stylesheet once
 * it's large and is otherwise copied into each page's stylesheet. Rolldown's
 * own size check only counts the JavaScript a stylesheet compiles to.
 *
 * So do the stylesheets that a non-page `import()` target (`next/dynamic`)
 * loads with other entries. Webpack leaves out of a dynamic chunk what the
 * page importing it already has, but Rolldown has one chunk per `import()`
 * target, and a copy there would link the CSS again after the page's own.
 */
export function collectUncopiedStylesheets(
  stylesheetSizes: ReadonlyMap<string, number>,
  getModuleInfo: (id: string) => {
    readonly isEntry: boolean;
    readonly importers: readonly string[];
    readonly dynamicImporters: readonly string[];
  } | null,
  // The client entry, which loads the pages.
  pageLoaderId: string,
): Set<string> {
  const groups = new Map<string, { size: number; ids: string[] }>();
  const uncopied = new Set<string>();

  // Stylesheets share most of their importers.
  const infos = new Map<string, ReturnType<typeof getModuleInfo>>();
  const infoOf = (id: string) => {
    if (!infos.has(id)) infos.set(id, getModuleInfo(id));
    return infos.get(id)!;
  };

  for (const [id, size] of stylesheetSizes) {
    // Gone from the module graph since an earlier watch build.
    if (!infoOf(id)) continue;

    // Every entry that loads the stylesheet statically.
    const entries: string[] = [];
    let loadsDynamically = false;
    const visited = new Set([id]);
    const pending = [id];

    while (pending.length > 0) {
      const moduleId = pending.pop()!;
      const info = infoOf(moduleId);
      if (!info) continue;

      if (info.isEntry || info.dynamicImporters.length > 0) entries.push(moduleId);
      if (info.dynamicImporters.some((importer) => importer !== pageLoaderId)) {
        loadsDynamically = true;
      }

      for (const importer of info.importers) {
        if (visited.has(importer)) continue;

        visited.add(importer);
        pending.push(importer);
      }
    }

    if (loadsDynamically && entries.length > 1) {
      uncopied.add(id);
      continue;
    }

    const key = entries.sort().join("\0");
    const group = groups.get(key) ?? { size: 0, ids: [] };

    group.size += size;
    group.ids.push(id);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.size < PAGES_INLINE_COMMON_CHUNK_MAX_SIZE) continue;
    for (const id of group.ids) uncopied.add(id);
  }

  return uncopied;
}

/**
 * Collect the modules of the common chunks that Rolldown would copy into two
 * chunks that load together. Inlining copies a small common chunk into each
 * chunk that imports it, so a page that loads two of those downloads the
 * module twice, and links a stylesheet's rules twice: the second copy follows
 * the first chunk's own stylesheet and overrides it. Webpack and Turbopack
 * give a page one copy of each module. These chunks keep a file of their own.
 *
 * Rolldown groups the modules that no chunk group takes by the entries (the
 * client entry, pages, `import()` targets) that load them statically. Two
 * chunks load together when an entry loads both, or when one of them loads
 * with every page: an `isAlwaysLoaded` entry (`_app`) loads it. Rolldown
 * leaves out the copies that load after one the client entry loads, as every
 * other chunk does. That only counts where the client entry's imports
 * survive: the output drops an unused import of a module `declaresSideEffects`
 * reports (see createSideEffectsDeclarationCheck).
 */
export function collectDoublyCopiedModules(
  moduleIds: Iterable<string>,
  getModuleInfo: (id: string) => {
    readonly isEntry: boolean;
    readonly importedIds: readonly string[];
    readonly importers: readonly string[];
    readonly dynamicImporters: readonly string[];
  } | null,
  options: {
    /** The chunk group that takes the module, if one does. */
    groupOf: (id: string) => string | undefined;
    isAlwaysLoaded: (entryId: string) => boolean;
    declaresSideEffects?: (id: string) => boolean;
  },
): Set<string> {
  const infos = new Map<string, NonNullable<ReturnType<typeof getModuleInfo>>>();
  for (const id of moduleIds) {
    const info = getModuleInfo(id);
    if (info) infos.set(id, info);
  }

  const entries = [...infos.keys()].filter((id) => {
    const info = infos.get(id)!;
    return info.isEntry || info.dynamicImporters.length > 0;
  });

  // The entries that load each module statically, by index, in order.
  const loadedBy = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const pending = [entry];

    while (pending.length > 0) {
      const id = pending.pop()!;
      const indexes = loadedBy.get(id) ?? [];
      if (indexes.at(-1) === index) continue;

      indexes.push(index);
      loadedBy.set(id, indexes);
      pending.push(...(infos.get(id)?.importedIds ?? []));
    }
  });

  // Each module's chunk: its group's, its entry's, or the common chunk of the
  // entries that load it, keyed by their indexes.
  const entryIds = new Set(entries);
  const chunks = new Map<string, string>();
  const commonChunks = new Map<string, string[]>();
  for (const id of infos.keys()) {
    const group = options.groupOf(id);
    const indexes = loadedBy.get(id) ?? [];
    let chunk: string;

    if (group !== undefined) chunk = `group:${group}`;
    else if (entryIds.has(id)) chunk = `entry:${id}`;
    else if (indexes.length === 1) chunk = `entry:${entries[indexes[0]!]}`;
    else {
      chunk = indexes.join(",");
      const ids = commonChunks.get(chunk) ?? [];
      ids.push(id);
      commonChunks.set(chunk, ids);
    }

    chunks.set(id, chunk);
  }

  const alwaysLoaded = new Set<number>();
  entries.forEach((entry, index) => {
    if (options.isAlwaysLoaded(entry)) alwaysLoaded.add(index);
  });

  // The modules that a configured entry (the client entry) still loads once
  // tree-shaking drops its unused imports.
  const loadedFirst = new Set<string>();
  const pendingFirst = entries.filter((id) => infos.get(id)!.isEntry);
  while (pendingFirst.length > 0) {
    const id = pendingFirst.pop()!;
    if (loadedFirst.has(id)) continue;
    loadedFirst.add(id);
    for (const imported of infos.get(id)?.importedIds ?? []) {
      if (!options.declaresSideEffects?.(imported)) pendingFirst.push(imported);
    }
  }

  const copiedTwice = new Set<string>();
  for (const [chunk, ids] of commonChunks) {
    if (ids.some((id) => loadedFirst.has(id))) continue;

    // The entries that load each chunk that imports this one.
    const importerChunks = new Map<string, Set<number>>();
    for (const id of ids) {
      for (const importer of infos.get(id)!.importers) {
        const importerChunk = chunks.get(importer);
        if (importerChunk === undefined || importerChunk === chunk) continue;

        const indexes = importerChunks.get(importerChunk) ?? new Set();
        for (const index of loadedBy.get(importer) ?? []) indexes.add(index);
        importerChunks.set(importerChunk, indexes);
      }
    }

    const importerLoads = [...importerChunks.values()];

    const loaded = new Set<number>();
    let loadsWithEveryPage = false;
    let loadTogether = false;
    for (const indexes of importerLoads) {
      for (const index of indexes) {
        if (loaded.has(index)) loadTogether = true;
        if (alwaysLoaded.has(index)) loadsWithEveryPage = true;
      }
      for (const index of indexes) loaded.add(index);
    }

    if (loadTogether || (loadsWithEveryPage && importerLoads.length > 1)) {
      for (const id of ids) copiedTwice.add(id);
    }
  }

  return copiedTwice;
}

/** Rolldown 1.2.18 added `codeSplitting.experimentalInlineCommonChunks`. */
export function supportsInlineCommonChunks(rolldownVersion: string): boolean {
  const [release = "", prerelease] = rolldownVersion.split("-", 2);
  const [major = 0, minor = 0, patch = 0] = release.split(".").map(Number);

  if (major !== 1) return major > 1;
  if (minor !== 2) return minor > 2;
  return patch > 18 || (patch === 18 && prerelease === undefined);
}

type InlineCommonChunksOutput = {
  readonly codeSplitting?: unknown;
  readonly format?: string;
  readonly preserveModules?: boolean;
  readonly strictExecutionOrder?: boolean;
};

/**
 * Copy small Pages Router common chunks into the chunks that import them, as
 * Next.js' webpack (below {@link PAGES_INLINE_COMMON_CHUNK_MAX_SIZE}) and
 * Turbopack (at any size) duplicate small modules that several pages share
 * instead of loading each set of them as a separate tiny chunk. Rolldown keeps
 * one instance of each copied module and only evaluates it when an importer
 * needs it, as both bundlers do. A chunk holding one of `uncopiedModules`
 * ({@link collectUncopiedStylesheets}, {@link collectDoublyCopiedModules})
 * isn't copied.
 *
 * Returns the output options with inlining turned on, or undefined when the
 * Rolldown version or other options (which Rolldown rejects in combination
 * with it) rule it out, or when the output already configures it.
 */
export function withInlineCommonChunks<Output extends InlineCommonChunksOutput>(
  output: Output,
  options: {
    preserveEntrySignatures?: unknown;
    onDemandWrapping?: unknown;
    rolldownVersion: string;
    uncopiedModules: ReadonlySet<string>;
  },
): Output | undefined {
  const codeSplitting = output.codeSplitting;

  const isEsmOutput =
    output.format === undefined ||
    output.format === "es" ||
    output.format === "esm" ||
    output.format === "module";
  const keepsEntrySignatures =
    options.preserveEntrySignatures !== undefined && options.preserveEntrySignatures !== false;

  if (
    !supportsInlineCommonChunks(options.rolldownVersion) ||
    !codeSplitting ||
    typeof codeSplitting !== "object" ||
    "experimentalInlineCommonChunks" in codeSplitting ||
    !isEsmOutput ||
    output.preserveModules === true ||
    output.strictExecutionOrder === false ||
    keepsEntrySignatures ||
    options.onDemandWrapping === true
  ) {
    return undefined;
  }

  return {
    ...output,
    codeSplitting: {
      ...codeSplitting,
      experimentalInlineCommonChunks: {
        maxSize: PAGES_INLINE_COMMON_CHUNK_MAX_SIZE,
        exclude: (id: string) => options.uncopiedModules.has(id),
      },
    },
  };
}

/**
 * Matches React framework packages (and the RSC flight runtime) inside
 * `node_modules`. Used to split them into a dedicated "framework" chunk in the
 * RSC server build.
 *
 * Why the RSC build needs this: without an explicit framework chunk, the
 * bundler colocates React into whichever chunk first reaches it — typically the
 * RSC entry chunk, which also carries the root layout's CSS. Modules that only
 * import React for runtime helpers (notably `app/global-not-found.tsx`, which
 * replaces the root layout for route-miss 404s) then import that entry chunk
 * and inherit the root layout's CSS in their `serverResources` metadata. The
 * 404 document ends up linking the layout's stylesheet last, so the layout's
 * rules win the cascade over global-not-found's — the bug tracked in
 * https://github.com/cloudflare/vinext/issues/1549.
 *
 * Splitting React into its own (CSS-free) chunk means global-not-found imports
 * the framework chunk instead of the layout-bearing entry chunk, so it no
 * longer inherits the root layout's CSS. The match list mirrors the client
 * build's `framework` chunk, plus `react-server-dom-webpack` for the RSC flight
 * runtime that the server environment bundles.
 *
 * Uses `[\\/]` rather than `/` for the path separator so it matches on Windows
 * too, per the rolldown `codeSplitting` docs.
 */
const FRAMEWORK_PACKAGES = ["react", "react-dom", "scheduler", "react-server-dom-webpack"] as const;

/**
 * Regex matching any {@link FRAMEWORK_PACKAGES} package inside `node_modules`.
 * Derived from the package list so the regex and {@link isRscFrameworkModule}
 * predicate can't drift.
 */
export const RSC_FRAMEWORK_CHUNK_TEST = new RegExp(
  `[\\\\/]node_modules[\\\\/](${FRAMEWORK_PACKAGES.join("|")})[\\\\/]`,
);

export function isRscFrameworkModule(id: string): boolean {
  if (!id.includes("node_modules")) return false;
  const pkg = getPackageName(id);
  return pkg !== null && (FRAMEWORK_PACKAGES as readonly string[]).includes(pkg);
}

/**
 * Keep virtual entry ids out of emitted RSC chunk filenames.
 *
 * Rolldown's entries-aware chunk names can contain the `\\0` virtual-id marker,
 * which is not a portable module-specifier or filesystem name. Preserve every
 * other character and remove both the printable and actual-NUL forms.
 */
export function sanitizeRscChunkFileName(name: string): string {
  const withoutVirtualMarkers = name.replaceAll("\\0", "");
  const invalid = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
  let sanitized = "";
  for (const character of withoutVirtualMarkers) {
    sanitized += character.charCodeAt(0) <= 31 || invalid.has(character) ? "_" : character;
  }
  return sanitized;
}

/**
 * Output config that isolates React (and the RSC flight runtime) into a
 * dedicated "framework" chunk in the RSC server build. See
 * {@link RSC_FRAMEWORK_CHUNK_TEST} for the motivation (issue #1549). Framework
 * modules that are only reachable through dynamic imports must stay out of the
 * eager framework chunk (issue #2073).
 */
export function createRscFrameworkChunkOutputConfig() {
  return {
    sanitizeFileName: sanitizeRscChunkFileName,
    codeSplitting: {
      groups: [
        {
          name: "framework",
          test: RSC_FRAMEWORK_CHUNK_TEST,
          // Split by the entries that use each module so lazy framework
          // imports cannot become eager Worker-startup dependencies (#2073).
          entriesAware: true,
        },
      ],
    },
  };
}

/**
 * Returns Rolldown treeshake configuration for production client builds.
 *
 * The key optimization is moduleSideEffects: "no-external", which is supported
 * by Rolldown and provides the DCE benefits for barrel-exporting libraries. It
 * treats node_modules as side-effect-free while preserving side effects in
 * local code.
 */
export function getClientTreeshakeConfig() {
  return {
    moduleSideEffects: "no-external" as const,
  };
}

type VinextBuildConfig = NonNullable<UserConfig["build"]>;
type VinextBuildBundlerOptions = NonNullable<VinextBuildConfig["rolldownOptions"]>;

export function getBuildBundlerOptions(
  build: UserConfig["build"] | undefined,
): VinextBuildBundlerOptions | undefined {
  return build?.rolldownOptions;
}

export function withBuildBundlerOptions(
  bundlerOptions: VinextBuildBundlerOptions,
): Partial<VinextBuildConfig> {
  return { rolldownOptions: bundlerOptions };
}

type VinextBuildOutput = Exclude<
  NonNullable<VinextBuildBundlerOptions["output"]>,
  readonly unknown[]
>;
type VinextCodeSplittingConfig = Exclude<NonNullable<VinextBuildOutput["codeSplitting"]>, boolean>;
type ChunkFileNames = NonNullable<VinextBuildOutput["chunkFileNames"]>;
type ChunkFileNameFunction = Exclude<ChunkFileNames, string>;

/**
 * Keep vinext modules partitioned by the stage entries that actually use them.
 * Without an entry-aware catch-all, Rolldown may merge a small helper shared by
 * request/response entries into a response-heavy chunk; importing that helper
 * then evaluates React and renderer code on a request-stage cache hit.
 */
export function createMultiStageCodeSplittingConfig(
  existing: VinextBuildOutput["codeSplitting"],
): VinextCodeSplittingConfig & { groups: NonNullable<VinextCodeSplittingConfig["groups"]> } {
  const base = existing && typeof existing === "object" ? existing : {};
  return {
    ...base,
    groups: [
      {
        name: "vinext-stage-runtime",
        test: /(?:^|[/\\])(?:packages[/\\]vinext[/\\]src|(?:packages[/\\]vinext|node_modules[/\\](?:\.pnpm[/\\][^/\\]+[/\\]node_modules[/\\])?vinext)[/\\]dist)[/\\]/,
        entriesAware: true,
      },
      ...(base.groups ?? []),
    ],
  };
}

/**
 * Keep router stage chunks beside the server entry so their generated
 * `./vinext-client-assets.js` and deploy-filled cacheability externals continue
 * to resolve. Other chunks keep
 * the host's existing output pattern (or vinext's server-assets default).
 */
export function createMultiStageChunkFileNames(
  assetsDir: string,
  existing: VinextBuildOutput["chunkFileNames"],
): ChunkFileNameFunction {
  return (chunk) => {
    const name = sanitizeRscChunkFileName(chunk.name);
    if (
      chunk.moduleIds?.some((id) =>
        /\/server\/app-ssr-entry\.[cm]?[jt]sx?$/.test(toSlash(id.split("?", 1)[0] ?? "")),
      ) ||
      [
        "app-router-entry",
        "pages-router-entry",
        "app-response-stage-entry",
        "pages-request-stage-entry",
        "pages-response-stage-entry",
        "virtual_vinext-rsc-entry",
        "virtual_vinext-request-stage",
        "virtual_vinext-response-stage",
      ].some((entryName) => name.includes(entryName))
    ) {
      return `${name}-[hash].js`;
    }
    if (typeof existing === "function") return existing({ ...chunk, name });
    const pattern = existing ?? joinAssetFileNamePattern(assetsDir, "[name]-[hash].js");
    return pattern.replaceAll("[name]", name);
  };
}

/**
 * The client environment builds after RSC and SSR, and Vite empties its
 * output directory first. A client output directory that is, or contains, a
 * server output directory would therefore delete the server build.
 */
export function assertClientOutDirIsSeparate(
  root: string,
  dirs: { clientOutDir?: string; outDir?: string; rscOutDir?: string; ssrOutDir?: string },
): void {
  if (!dirs.clientOutDir) return;
  const clientOutDir = path.resolve(root, dirs.clientOutDir);
  const outDir = dirs.outDir ?? "dist";
  const serverOutDirs = [
    ["rscOutDir", dirs.rscOutDir ?? path.join(outDir, "server")],
    ["ssrOutDir", dirs.ssrOutDir ?? path.join(outDir, "server", "ssr")],
    // BUILD_ID, vinext-server.json and the prerender output live here.
    ["the server metadata directory", path.join(outDir, "server")],
  ] as const;
  for (const [name, dir] of serverOutDirs) {
    const relative = path.relative(clientOutDir, path.resolve(root, dir));
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) continue;
    throw new Error(
      `[vinext] clientOutDir "${dirs.clientOutDir}" contains ${name} "${dir}". ` +
        "The client build runs last and empties its output directory, which would delete " +
        "the server build. Use separate output directories.",
    );
  }
}

function hasChunkGroups(output: unknown, ownGroups: ReadonlySet<unknown>): boolean {
  if (!output || typeof output !== "object") return false;
  const { advancedChunks, codeSplitting, manualChunks } = output as {
    advancedChunks?: { groups?: readonly unknown[] };
    codeSplitting?: unknown;
    manualChunks?: unknown;
  };
  if (manualChunks !== undefined) return true;
  const groups = [
    ...(advancedChunks?.groups ?? []),
    ...((codeSplitting && typeof codeSplitting === "object"
      ? (codeSplitting as { groups?: readonly unknown[] }).groups
      : undefined) ?? []),
  ];
  return groups.some((group) => !ownGroups.has(group));
}

/**
 * Whether client output options have chunk groups (`codeSplitting.groups`,
 * `advancedChunks.groups` or `manualChunks`) other than vinext's own
 * `ownGroups`, whether they came from the user or another plugin. vinext's
 * client-reference route grouping is disabled in that case: a manual group can
 * move modules out of a route group's chunk, and that combination has been
 * seen to evaluate modules out of order and break hydration.
 */
export function hasUserClientChunkGroups(
  output: unknown,
  ownGroups: ReadonlySet<unknown>,
): boolean {
  return Array.isArray(output)
    ? output.some((entry) => hasChunkGroups(entry, ownGroups))
    : hasChunkGroups(output, ownGroups);
}
