/**
 * App Router RSC entry generator.
 *
 * Generates the virtual RSC entry module for the App Router.
 * The RSC entry does route matching and renders the component tree,
 * then delegates to the SSR entry for HTML generation.
 *
 * Previously housed in server/app-dev-server.ts.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  NextHeader,
  NextI18nConfig,
  NextRedirect,
  NextRewrite,
} from "../config/next-config.js";
import type { AppRoute } from "../routing/app-router.js";
import { generateDevOriginCheckCode } from "../server/dev-origin-check.js";
import type { MetadataFileRoute } from "../server/metadata-routes.js";
import {
  generateMiddlewareMatcherCode,
  generateNormalizePathCode,
  generateSafeRegExpCode,
  generateRouteMatchNormalizationCode,
} from "../server/middleware-codegen.js";
import { isProxyFile } from "../server/middleware.js";

// Pre-computed absolute paths for generated-code imports. The virtual RSC
// entry can't use relative imports (it has no real file location), so we
// resolve these at code-generation time and embed them as absolute paths.
const configMatchersPath = fileURLToPath(
  new URL("../config/config-matchers.js", import.meta.url),
).replace(/\\/g, "/");
const requestPipelinePath = fileURLToPath(
  new URL("../server/request-pipeline.js", import.meta.url),
).replace(/\\/g, "/");
const requestContextShimPath = fileURLToPath(
  new URL("../shims/request-context.js", import.meta.url),
).replace(/\\/g, "/");
const routeTriePath = fileURLToPath(new URL("../routing/route-trie.js", import.meta.url)).replace(
  /\\/g,
  "/",
);

// Canonical order of HTTP method handlers supported by route.ts modules.
const ROUTE_HANDLER_HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];

// Runtime helpers injected into the generated RSC entry so OPTIONS/Allow handling
// logic stays alongside the route handler pipeline.
const routeHandlerHelperCode = String.raw`
// Duplicated from the build-time constant above via JSON.stringify.
const ROUTE_HANDLER_HTTP_METHODS = ${JSON.stringify(ROUTE_HANDLER_HTTP_METHODS)};

function collectRouteHandlerMethods(handler) {
  const methods = ROUTE_HANDLER_HTTP_METHODS.filter((method) => typeof handler[method] === "function");
  if (methods.includes("GET") && !methods.includes("HEAD")) {
    methods.push("HEAD");
  }
  return methods;
}

function buildRouteHandlerAllowHeader(exportedMethods) {
  const allow = new Set(exportedMethods);
  allow.add("OPTIONS");
  return Array.from(allow).sort().join(", ");
}
`;

/**
 * Resolved config options relevant to App Router request handling.
 * Passed from the Vite plugin where the full next.config.js is loaded.
 */
export interface AppRouterConfig {
  redirects?: NextRedirect[];
  rewrites?: {
    beforeFiles: NextRewrite[];
    afterFiles: NextRewrite[];
    fallback: NextRewrite[];
  };
  headers?: NextHeader[];
  /** Extra origins allowed for server action CSRF checks (from experimental.serverActions.allowedOrigins). */
  allowedOrigins?: string[];
  /** Extra origins allowed for dev server access (from allowedDevOrigins). */
  allowedDevOrigins?: string[];
  /** Body size limit for server actions in bytes (from experimental.serverActions.bodySizeLimit). */
  bodySizeLimit?: number;
  /** Internationalization routing config for middleware matcher locale handling. */
  i18n?: NextI18nConfig | null;
  /**
   * When true, the project has a `pages/` directory alongside the App Router.
   * The generated RSC entry exposes `/__vinext/prerender/pages-static-paths`
   * so `prerenderPages` can call `getStaticPaths` via `wrangler unstable_startWorker`
   * in CF Workers builds. `pageRoutes` is loaded from the SSR environment via
   * `import("./ssr/index.js")`, which re-exports it from
   * `virtual:vinext-server-entry` when this flag is set.
   */
  hasPagesDir?: boolean;
}

/**
 * Generate the virtual RSC entry module.
 *
 * This runs in the `rsc` Vite environment (react-server condition).
 * It matches the incoming request URL to an app route, builds the
 * nested layout + page tree, and renders it to an RSC stream.
 */
export function generateRscEntry(
  appDir: string,
  routes: AppRoute[],
  middlewarePath?: string | null,
  metadataRoutes?: MetadataFileRoute[],
  globalErrorPath?: string | null,
  basePath?: string,
  trailingSlash?: boolean,
  config?: AppRouterConfig,
  instrumentationPath?: string | null,
): string {
  const bp = basePath ?? "";
  const ts = trailingSlash ?? false;
  const redirects = config?.redirects ?? [];
  const rewrites = config?.rewrites ?? { beforeFiles: [], afterFiles: [], fallback: [] };
  const headers = config?.headers ?? [];
  const allowedOrigins = config?.allowedOrigins ?? [];
  const bodySizeLimit = config?.bodySizeLimit ?? 1 * 1024 * 1024;
  const i18nConfig = config?.i18n ?? null;
  const hasPagesDir = config?.hasPagesDir ?? false;
  // Build import map for all page and layout files
  const imports: string[] = [];
  const importMap: Map<string, string> = new Map();
  let importIdx = 0;

  function getImportVar(filePath: string): string {
    if (importMap.has(filePath)) return importMap.get(filePath)!;
    const varName = `mod_${importIdx++}`;
    const absPath = filePath.replace(/\\/g, "/");
    imports.push(`import * as ${varName} from ${JSON.stringify(absPath)};`);
    importMap.set(filePath, varName);
    return varName;
  }

  // Pre-register all modules
  for (const route of routes) {
    if (route.pagePath) getImportVar(route.pagePath);
    if (route.routePath) getImportVar(route.routePath);
    for (const layout of route.layouts) getImportVar(layout);
    for (const tmpl of route.templates) getImportVar(tmpl);
    if (route.loadingPath) getImportVar(route.loadingPath);
    if (route.errorPath) getImportVar(route.errorPath);
    if (route.layoutErrorPaths)
      for (const ep of route.layoutErrorPaths) {
        if (ep) getImportVar(ep);
      }
    if (route.notFoundPath) getImportVar(route.notFoundPath);
    for (const nfp of route.notFoundPaths || []) {
      if (nfp) getImportVar(nfp);
    }
    if (route.forbiddenPath) getImportVar(route.forbiddenPath);
    if (route.unauthorizedPath) getImportVar(route.unauthorizedPath);
    // Register parallel slot modules
    for (const slot of route.parallelSlots) {
      if (slot.pagePath) getImportVar(slot.pagePath);
      if (slot.defaultPath) getImportVar(slot.defaultPath);
      if (slot.layoutPath) getImportVar(slot.layoutPath);
      if (slot.loadingPath) getImportVar(slot.loadingPath);
      if (slot.errorPath) getImportVar(slot.errorPath);
      // Register intercepting route page modules
      for (const ir of slot.interceptingRoutes) {
        getImportVar(ir.pagePath);
      }
    }
  }

  // Build route table as serialized JS
  const routeEntries = routes.map((route) => {
    const layoutVars = route.layouts.map((l) => getImportVar(l));
    const templateVars = route.templates.map((t) => getImportVar(t));
    const notFoundVars = (route.notFoundPaths || []).map((nf) => (nf ? getImportVar(nf) : "null"));
    const slotEntries = route.parallelSlots.map((slot) => {
      const interceptEntries = slot.interceptingRoutes.map((ir) => {
        return `        {
          convention: ${JSON.stringify(ir.convention)},
          targetPattern: ${JSON.stringify(ir.targetPattern)},
          page: ${getImportVar(ir.pagePath)},
          params: ${JSON.stringify(ir.params)},
        }`;
      });
      return `      ${JSON.stringify(slot.name)}: {
        page: ${slot.pagePath ? getImportVar(slot.pagePath) : "null"},
        default: ${slot.defaultPath ? getImportVar(slot.defaultPath) : "null"},
        layout: ${slot.layoutPath ? getImportVar(slot.layoutPath) : "null"},
        loading: ${slot.loadingPath ? getImportVar(slot.loadingPath) : "null"},
        error: ${slot.errorPath ? getImportVar(slot.errorPath) : "null"},
        layoutIndex: ${slot.layoutIndex},
        intercepts: [
${interceptEntries.join(",\n")}
        ],
      }`;
    });
    const layoutErrorVars = (route.layoutErrorPaths || []).map((ep) =>
      ep ? getImportVar(ep) : "null",
    );
    return `  {
    pattern: ${JSON.stringify(route.pattern)},
    patternParts: ${JSON.stringify(route.patternParts)},
    isDynamic: ${route.isDynamic},
    params: ${JSON.stringify(route.params)},
    page: ${route.pagePath ? getImportVar(route.pagePath) : "null"},
    routeHandler: ${route.routePath ? getImportVar(route.routePath) : "null"},
    layouts: [${layoutVars.join(", ")}],
    routeSegments: ${JSON.stringify(route.routeSegments)},
    layoutTreePositions: ${JSON.stringify(route.layoutTreePositions)},
    templates: [${templateVars.join(", ")}],
    errors: [${layoutErrorVars.join(", ")}],
    slots: {
${slotEntries.join(",\n")}
    },
    loading: ${route.loadingPath ? getImportVar(route.loadingPath) : "null"},
    error: ${route.errorPath ? getImportVar(route.errorPath) : "null"},
    notFound: ${route.notFoundPath ? getImportVar(route.notFoundPath) : "null"},
    notFounds: [${notFoundVars.join(", ")}],
    forbidden: ${route.forbiddenPath ? getImportVar(route.forbiddenPath) : "null"},
    unauthorized: ${route.unauthorizedPath ? getImportVar(route.unauthorizedPath) : "null"},
  }`;
  });

  // Find root not-found/forbidden/unauthorized pages and root layouts for global error handling
  const rootRoute = routes.find((r) => r.pattern === "/");
  const rootNotFoundVar = rootRoute?.notFoundPath ? getImportVar(rootRoute.notFoundPath) : null;
  const rootForbiddenVar = rootRoute?.forbiddenPath ? getImportVar(rootRoute.forbiddenPath) : null;
  const rootUnauthorizedVar = rootRoute?.unauthorizedPath
    ? getImportVar(rootRoute.unauthorizedPath)
    : null;
  const rootLayoutVars = rootRoute ? rootRoute.layouts.map((l) => getImportVar(l)) : [];

  // Global error boundary (app/global-error.tsx)
  const globalErrorVar = globalErrorPath ? getImportVar(globalErrorPath) : null;

  // Build metadata route handling
  const effectiveMetaRoutes = metadataRoutes ?? [];
  const dynamicMetaRoutes = effectiveMetaRoutes.filter((r) => r.isDynamic);

  // Import dynamic metadata modules
  for (const mr of dynamicMetaRoutes) {
    getImportVar(mr.filePath);
  }

  // Build metadata route table
  // For static metadata files, read the file content at code-generation time
  // and embed it as base64. This ensures static metadata files work on runtimes
  // without filesystem access (e.g., Cloudflare Workers).
  //
  // For metadata routes in dynamic segments (e.g., /blog/[slug]/opengraph-image),
  // generate patternParts so the runtime can use matchPattern() instead of strict
  // equality — the same matching used for intercept routes.
  const metaRouteEntries = effectiveMetaRoutes.map((mr) => {
    // Convert dynamic segments in servedUrl to matchPattern format.
    // Keep in sync with routing/app-router.ts patternParts generation.
    //   [param]       → :param
    //   [...param]    → :param+
    //   [[...param]]  → :param*
    const patternParts =
      mr.isDynamic && mr.servedUrl.includes("[")
        ? JSON.stringify(
            mr.servedUrl
              .split("/")
              .filter(Boolean)
              .map((seg) => {
                if (seg.startsWith("[[...") && seg.endsWith("]]"))
                  return ":" + seg.slice(5, -2) + "*";
                if (seg.startsWith("[...") && seg.endsWith("]"))
                  return ":" + seg.slice(4, -1) + "+";
                if (seg.startsWith("[") && seg.endsWith("]")) return ":" + seg.slice(1, -1);
                return seg;
              }),
          )
        : null;

    if (mr.isDynamic) {
      return `  {
    type: ${JSON.stringify(mr.type)},
    isDynamic: true,
    servedUrl: ${JSON.stringify(mr.servedUrl)},
    contentType: ${JSON.stringify(mr.contentType)},
    module: ${getImportVar(mr.filePath)},${patternParts ? `\n    patternParts: ${patternParts},` : ""}
  }`;
    }
    // Static: read file and embed as base64
    let fileDataBase64 = "";
    try {
      const buf = fs.readFileSync(mr.filePath);
      fileDataBase64 = buf.toString("base64");
    } catch {
      // File unreadable — will serve empty response at runtime
    }
    return `  {
    type: ${JSON.stringify(mr.type)},
    isDynamic: false,
    servedUrl: ${JSON.stringify(mr.servedUrl)},
    contentType: ${JSON.stringify(mr.contentType)},
    fileDataBase64: ${JSON.stringify(fileDataBase64)},
  }`;
  });

  return `
import {
  renderToReadableStream,
  decodeReply,
  loadServerAction,
  createTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/rsc";
import { AsyncLocalStorage } from "node:async_hooks";
import { createElement, Suspense, Fragment } from "react";
import { setNavigationContext as _setNavigationContextOrig, getNavigationContext as _getNavigationContext } from "next/navigation";
import { setHeadersContext, headersContextFromRequest, getDraftModeCookieHeader, getAndClearPendingCookies, consumeDynamicUsage, markDynamicUsage, applyMiddlewareRequestHeaders, getHeadersContext, setHeadersAccessPhase } from "next/headers";
import { NextRequest, NextFetchEvent } from "next/server";
import { ErrorBoundary, NotFoundBoundary } from "vinext/error-boundary";
import { LayoutSegmentProvider } from "vinext/layout-segment-context";
import { MetadataHead, mergeMetadata, resolveModuleMetadata, ViewportHead, mergeViewport, resolveModuleViewport } from "vinext/metadata";
${middlewarePath ? `import * as middlewareModule from ${JSON.stringify(middlewarePath.replace(/\\/g, "/"))};` : ""}
${instrumentationPath ? `import * as _instrumentation from ${JSON.stringify(instrumentationPath.replace(/\\/g, "/"))};` : ""}
${effectiveMetaRoutes.length > 0 ? `import { sitemapToXml, robotsToText, manifestToJson } from ${JSON.stringify(fileURLToPath(new URL("../server/metadata-routes.js", import.meta.url)).replace(/\\/g, "/"))};` : ""}
import { requestContextFromRequest, normalizeHost, matchRedirect, matchRewrite, matchHeaders, isExternalUrl, proxyExternalRequest, sanitizeDestination } from ${JSON.stringify(configMatchersPath)};
import { validateCsrfOrigin, validateImageUrl, guardProtocolRelativeUrl, hasBasePath, stripBasePath, normalizeTrailingSlash, processMiddlewareHeaders } from ${JSON.stringify(requestPipelinePath)};
import { _consumeRequestScopedCacheLife, getCacheHandler } from "next/cache";
import { getRequestExecutionContext as _getRequestExecutionContext } from ${JSON.stringify(requestContextShimPath)};
import { ensureFetchPatch as _ensureFetchPatch, getCollectedFetchTags } from "vinext/fetch-cache";
import { buildRouteTrie as _buildRouteTrie, trieMatch as _trieMatch } from ${JSON.stringify(routeTriePath)};
// Import server-only state module to register ALS-backed accessors.
import "vinext/navigation-state";
import { runWithRequestContext as _runWithUnifiedCtx, createRequestContext as _createUnifiedCtx } from "vinext/unified-request-context";
import { reportRequestError as _reportRequestError } from "vinext/instrumentation";
import { getSSRFontLinks as _getSSRFontLinks, getSSRFontStyles as _getSSRFontStylesGoogle, getSSRFontPreloads as _getSSRFontPreloadsGoogle } from "next/font/google";
import { getSSRFontStyles as _getSSRFontStylesLocal, getSSRFontPreloads as _getSSRFontPreloadsLocal } from "next/font/local";
function _getSSRFontStyles() { return [..._getSSRFontStylesGoogle(), ..._getSSRFontStylesLocal()]; }
function _getSSRFontPreloads() { return [..._getSSRFontPreloadsGoogle(), ..._getSSRFontPreloadsLocal()]; }
${hasPagesDir ? `// Note: pageRoutes loaded lazily via SSR env in /__vinext/prerender/pages-static-paths handler` : ""}
${routeHandlerHelperCode}

// ALS used to suppress the expected "Invalid hook call" dev warning when
// layout/page components are probed outside React's render cycle. Patching
// console.error once at module load (instead of per-request) avoids the
// concurrent-request issue where request A's suppression filter could
// swallow real errors from request B.
const _suppressHookWarningAls = new AsyncLocalStorage();
const _origConsoleError = console.error;
console.error = (...args) => {
  if (_suppressHookWarningAls.getStore() === true &&
      typeof args[0] === "string" &&
      args[0].includes("Invalid hook call")) return;
  _origConsoleError.apply(console, args);
};

// Set navigation context in the ALS-backed store. "use client" components
// rendered during SSR need the pathname/searchParams/params but the SSR
// environment has a separate module instance of next/navigation.
// Use _getNavigationContext() to read the current context — never cache
// it in a module-level variable (that would leak between concurrent requests).
function setNavigationContext(ctx) {
  _setNavigationContextOrig(ctx);
}

// ISR cache is disabled in dev mode — every request re-renders fresh,
// matching Next.js dev behavior. Cache-Control headers are still emitted
// based on export const revalidate for testing purposes.
// Production ISR uses the MemoryCacheHandler (or configured KV handler).
//
// These helpers are inlined instead of imported from isr-cache.js because
// the virtual RSC entry module runs in the RSC Vite environment which
// cannot use dynamic imports at the module-evaluation level for server-only
// modules, and direct imports must use the pre-computed absolute paths.
async function __isrGet(key) {
  const handler = getCacheHandler();
  const result = await handler.get(key);
  if (!result || !result.value) return null;
  return { value: result, isStale: result.cacheState === "stale" };
}
async function __isrSet(key, data, revalidateSeconds, tags) {
  const handler = getCacheHandler();
  await handler.set(key, data, { revalidate: revalidateSeconds, tags: Array.isArray(tags) ? tags : [] });
}
function __pageCacheTags(pathname, extraTags) {
  const tags = [pathname, "_N_T_" + pathname];
  // Layout hierarchy tags — matches Next.js getDerivedTags.
  tags.push("_N_T_/layout");
  const segments = pathname.split("/");
  let built = "";
  for (let i = 1; i < segments.length; i++) {
    if (segments[i]) {
      built += "/" + segments[i];
      tags.push("_N_T_" + built + "/layout");
    }
  }
  // Leaf page tag — revalidatePath(path, "page") targets this.
  tags.push("_N_T_" + built + "/page");
  if (Array.isArray(extraTags)) {
    for (const tag of extraTags) {
      if (!tags.includes(tag)) tags.push(tag);
    }
  }
  return tags;
}
// Note: cache entries are written with \`headers: undefined\`. Next.js stores
// response headers (e.g. set-cookie from cookies().set() during render) in the
// cache entry so they can be replayed on HIT. We don't do this because:
//   1. Pages that call cookies().set() during render trigger dynamicUsedDuringRender,
//      which opts them out of ISR caching before we reach the write path.
//   2. Custom response headers set via next/headers are not yet captured separately
//      from the live Response object in vinext's server pipeline.
// In practice this means ISR-cached responses won't replay render-time set-cookie
// headers — but that case is already prevented by the dynamic-usage opt-out.
// TODO: capture render-time response headers for full Next.js parity.
const __pendingRegenerations = new Map();
function __triggerBackgroundRegeneration(key, renderFn) {
  if (__pendingRegenerations.has(key)) return;
  const promise = renderFn()
    .catch((err) => console.error("[vinext] ISR regen failed for " + key + ":", err))
    .finally(() => __pendingRegenerations.delete(key));
  __pendingRegenerations.set(key, promise);
  const ctx = _getRequestExecutionContext();
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(promise);
}
// HTML and RSC are stored under separate keys — matching Next.js's file-system
// layout (.html / .rsc) — so each request type reads and writes its own key
// independently with no races or partial-entry sentinels.
//
// Key format: "app:<buildId>:<pathname>:<suffix>"
// Long-pathname fallback: "app:<buildId>:__hash:<fnv1a64(pathname)>:<suffix>"
// Without buildId (should not happen in production): "app:<pathname>:<suffix>"
// The 200-char threshold keeps the full key well under Cloudflare KV's 512-byte limit
// even after adding the build ID and suffix. FNV-1a 64 is used for the hash (two
// 32-bit rounds) to give a ~64-bit output with negligible collision probability for
// realistic pathname lengths.
// Keep prefix construction and hashing logic in sync with isrCacheKey() in server/isr-cache.ts.
function __isrFnv1a64(s) {
  // h1 uses the standard FNV-1a 32-bit offset basis (0x811c9dc5).
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h1 ^= s.charCodeAt(i); h1 = (h1 * 0x01000193) >>> 0; }
  // h2 uses a different seed (0x050c5d1f — the FNV-1a hash of the string "vinext")
  // so the two rounds are independently seeded and their outputs are decorrelated.
  // Concatenating two independently-seeded 32-bit FNV-1a hashes gives an effective
  // 64-bit hash. A random non-standard seed would also work; we derive it from a
  // fixed string so the choice is auditable and deterministic across rebuilds.
  let h2 = 0x050c5d1f;
  for (let i = 0; i < s.length; i++) { h2 ^= s.charCodeAt(i); h2 = (h2 * 0x01000193) >>> 0; }
  return h1.toString(36) + h2.toString(36);
}
function __isrCacheKey(pathname, suffix) {
  const normalized = pathname === "/" ? "/" : pathname.replace(/\\/$/, "");
  // __VINEXT_BUILD_ID is replaced at compile time by Vite's define plugin.
  const buildId = process.env.__VINEXT_BUILD_ID;
  const prefix = buildId ? "app:" + buildId : "app";
  const key = prefix + ":" + normalized + ":" + suffix;
  if (key.length <= 200) return key;
  // Pathname too long — hash it to keep under KV's 512-byte key limit.
  return prefix + ":__hash:" + __isrFnv1a64(normalized) + ":" + suffix;
}
function __isrHtmlKey(pathname) { return __isrCacheKey(pathname, "html"); }
function __isrRscKey(pathname) { return __isrCacheKey(pathname, "rsc"); }
function __isrRouteKey(pathname) { return __isrCacheKey(pathname, "route"); }
// Verbose cache logging — opt in with NEXT_PRIVATE_DEBUG_CACHE=1.
// Matches the env var Next.js uses for its own cache debug output so operators
// have a single knob for all cache tracing.
const __isrDebug = process.env.NEXT_PRIVATE_DEBUG_CACHE
  ? console.debug.bind(console, "[vinext] ISR:")
  : undefined;

// Normalize null-prototype objects from matchPattern() into thenable objects
// that work both as Promises (for Next.js 15+ async params) and as plain
// objects with synchronous property access (for pre-15 code like params.id).
//
// matchPattern() uses Object.create(null), producing objects without
// Object.prototype. The RSC serializer rejects these. Spreading ({...obj})
// restores a normal prototype. Object.assign onto the Promise preserves
// synchronous property access (params.id, params.slug) that existing
// components and test fixtures rely on.
function makeThenableParams(obj) {
  const plain = { ...obj };
  return Object.assign(Promise.resolve(plain), plain);
}

// Resolve route tree segments to actual values using matched params.
// Dynamic segments like [id] are replaced with param values, catch-all
// segments like [...slug] are joined with "/", and route groups are kept as-is.
function __resolveChildSegments(routeSegments, treePosition, params) {
  var raw = routeSegments.slice(treePosition);
  var result = [];
  for (var j = 0; j < raw.length; j++) {
    var seg = raw[j];
    // Optional catch-all: [[...param]]
    if (seg.indexOf("[[...") === 0 && seg.charAt(seg.length - 1) === "]" && seg.charAt(seg.length - 2) === "]") {
      var pn = seg.slice(5, -2);
      var v = params[pn];
      // Skip empty optional catch-all (e.g., visiting /blog on [[...slug]] route)
      if (Array.isArray(v) && v.length === 0) continue;
      if (v == null) continue;
      result.push(Array.isArray(v) ? v.join("/") : v);
    // Catch-all: [...param]
    } else if (seg.indexOf("[...") === 0 && seg.charAt(seg.length - 1) === "]") {
      var pn2 = seg.slice(4, -1);
      var v2 = params[pn2];
      result.push(Array.isArray(v2) ? v2.join("/") : (v2 || seg));
    // Dynamic: [param]
    } else if (seg.charAt(0) === "[" && seg.charAt(seg.length - 1) === "]" && seg.indexOf(".") === -1) {
      var pn3 = seg.slice(1, -1);
      result.push(params[pn3] || seg);
    } else {
      result.push(seg);
    }
  }
  return result;
}

// djb2 hash — matches Next.js's stringHash for digest generation.
// Produces a stable numeric string from error message + stack.
function __errorDigest(str) {
  let hash = 5381;
  for (let i = str.length - 1; i >= 0; i--) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString();
}

// Sanitize an error for client consumption. In production, replaces the error
// with a generic Error that only carries a digest hash (matching Next.js
// behavior). In development, returns the original error for debugging.
// Navigation errors (redirect, notFound, etc.) are always passed through
// unchanged since their digests are used for client-side routing.
function __sanitizeErrorForClient(error) {
  // Navigation errors must pass through with their digest intact
  if (error && typeof error === "object" && "digest" in error) {
    const digest = String(error.digest);
    if (
      digest.startsWith("NEXT_REDIRECT;") ||
      digest === "NEXT_NOT_FOUND" ||
      digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")
    ) {
      return error;
    }
  }
  // In development, pass through the original error for debugging
  if (process.env.NODE_ENV !== "production") {
    return error;
  }
  // In production, create a sanitized error with only a digest hash
  const msg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack || "") : "";
  const sanitized = new Error(
    "An error occurred in the Server Components render. " +
    "The specific message is omitted in production builds to avoid leaking sensitive details. " +
    "A digest property is included on this error instance which may provide additional details about the nature of the error."
  );
  sanitized.digest = __errorDigest(msg + stack);
  return sanitized;
}

// onError callback for renderToReadableStream — preserves the digest for
// Next.js navigation errors (redirect, notFound, forbidden, unauthorized)
// thrown during RSC streaming (e.g. inside Suspense boundaries).
// For non-navigation errors in production, generates a digest hash so the
// error can be correlated with server logs without leaking details.
function rscOnError(error, requestInfo, errorContext) {
  if (error && typeof error === "object" && "digest" in error) {
    return String(error.digest);
  }

  // In dev, detect the "Only plain objects" RSC serialization error and emit
  // an actionable hint. This error occurs when a Server Component passes a
  // class instance, ES module namespace object, or null-prototype object as a
  // prop to a Client Component.
  //
  // Root cause: Vite bundles modules as true ESM (module namespace objects
  // have a null-like internal slot), while Next.js's webpack build produces
  // plain CJS-wrapped objects with __esModule:true. React's RSC serializer
  // accepts the latter as plain objects but rejects the former — which means
  // code that accidentally passes "import * as X" works in webpack/Next.js
  // but correctly fails in vinext.
  //
  // Common triggers:
  //   - "import * as utils from './utils'" passed as a prop
  //   - class instances (new Foo()) passed as props
  //   - Date / Map / Set instances passed as props
  //   - Objects with Object.create(null) (null prototype)
  if (
    process.env.NODE_ENV !== "production" &&
    error instanceof Error &&
    error.message.includes("Only plain objects, and a few built-ins, can be passed to Client Components")
  ) {
    console.error(
      "[vinext] RSC serialization error: a non-plain object was passed from a Server Component to a Client Component.\\n" +
      "\\n" +
      "Common causes:\\n" +
      "  * Passing a module namespace (import * as X) directly as a prop.\\n" +
      "    Unlike Next.js (webpack), Vite produces real ESM module namespace objects\\n" +
      "    which are not serializable. Fix: pass individual values instead,\\n" +
      "    e.g. <Comp value={module.value} />\\n" +
      "  * Passing a class instance (new Foo()) as a prop.\\n" +
      "    Fix: convert to a plain object, e.g. { id: foo.id, name: foo.name }\\n" +
      "  * Passing a Date, Map, or Set. Use .toISOString(), [...map.entries()], etc.\\n" +
      "  * Passing Object.create(null). Use { ...obj } to restore a prototype.\\n" +
      "\\n" +
      "Original error:",
      error.message,
    );
    return undefined;
  }

  if (requestInfo && errorContext && error) {
    _reportRequestError(
      error instanceof Error ? error : new Error(String(error)),
      requestInfo,
      errorContext,
    );
  }

  // In production, generate a digest hash for non-navigation errors
  if (process.env.NODE_ENV === "production" && error) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack || "") : "";
    return __errorDigest(msg + stack);
  }
  return undefined;
}

function createRscOnErrorHandler(request, pathname, routePath) {
  const requestInfo = {
    path: pathname,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
  };
  const errorContext = {
    routerKind: "App Router",
    routePath: routePath || pathname,
    routeType: "render",
  };
  return function(error) {
    return rscOnError(error, requestInfo, errorContext);
  };
}

${imports.join("\n")}

${
  instrumentationPath
    ? `// Run instrumentation register() exactly once, lazily on the first request.
// Previously this was a top-level await, which blocked the entire module graph
// from finishing initialization until register() resolved — adding that latency
// to every cold start. Moving it here preserves the "runs before any request is
// handled" guarantee while not blocking V8 isolate initialization.
// On Cloudflare Workers, module evaluation happens synchronously in the isolate
// startup phase; a top-level await extends that phase and increases cold-start
// wall time for all requests, not just the first.
let __instrumentationInitialized = false;
let __instrumentationInitPromise = null;
async function __ensureInstrumentation() {
  if (process.env.VINEXT_PRERENDER === "1") return;
  if (__instrumentationInitialized) return;
  if (__instrumentationInitPromise) return __instrumentationInitPromise;
  __instrumentationInitPromise = (async () => {
    if (typeof _instrumentation.register === "function") {
      await _instrumentation.register();
    }
    // Store the onRequestError handler on globalThis so it is visible to
    // reportRequestError() (imported as _reportRequestError above) regardless
    // of which Vite environment module graph it is called from. With
    // @vitejs/plugin-rsc the RSC and SSR environments run in the same Node.js
    // process and share globalThis. With @cloudflare/vite-plugin everything
    // runs inside the Worker so globalThis is the Worker's global — also correct.
    if (typeof _instrumentation.onRequestError === "function") {
      globalThis.__VINEXT_onRequestErrorHandler__ = _instrumentation.onRequestError;
    }
    __instrumentationInitialized = true;
  })();
  return __instrumentationInitPromise;
}`
    : ""
}

const routes = [
${routeEntries.join(",\n")}
];
const _routeTrie = _buildRouteTrie(routes);

const metadataRoutes = [
${metaRouteEntries.join(",\n")}
];

const rootNotFoundModule = ${rootNotFoundVar ? rootNotFoundVar : "null"};
const rootForbiddenModule = ${rootForbiddenVar ? rootForbiddenVar : "null"};
const rootUnauthorizedModule = ${rootUnauthorizedVar ? rootUnauthorizedVar : "null"};
const rootLayouts = [${rootLayoutVars.join(", ")}];

/**
 * Render an HTTP access fallback page (not-found/forbidden/unauthorized) with layouts and noindex meta.
 * Returns null if no matching component is available.
 *
 * @param opts.boundaryComponent - Override the boundary component (for layout-level notFound)
 * @param opts.layouts - Override the layouts to wrap with (for layout-level notFound, excludes the throwing layout)
 */
async function renderHTTPAccessFallbackPage(route, statusCode, isRscRequest, request, opts) {
  // Determine which boundary component to use based on status code
  let BoundaryComponent = opts?.boundaryComponent ?? null;
  if (!BoundaryComponent) {
    let boundaryModule;
    if (statusCode === 403) {
      boundaryModule = route?.forbidden ?? rootForbiddenModule;
    } else if (statusCode === 401) {
      boundaryModule = route?.unauthorized ?? rootUnauthorizedModule;
    } else {
      boundaryModule = route?.notFound ?? rootNotFoundModule;
    }
    BoundaryComponent = boundaryModule?.default ?? null;
  }
  const layouts = opts?.layouts ?? route?.layouts ?? rootLayouts;
  if (!BoundaryComponent) return null;

  // Resolve metadata and viewport from parent layouts so that not-found/error
  // pages inherit title, description, OG tags etc. — matching Next.js behavior.
  // Build the serial parent chain for layout metadata (same as buildPageElement).
  const _filteredLayouts = layouts.filter(Boolean);
  const _fallbackParams = opts?.matchedParams ?? route?.params ?? {};
  const _layoutMetaPromises = [];
  let _accumulatedMeta = Promise.resolve({});
  for (let _i = 0; _i < _filteredLayouts.length; _i++) {
    const _parentForLayout = _accumulatedMeta;
    const _metaP = resolveModuleMetadata(_filteredLayouts[_i], _fallbackParams, undefined, _parentForLayout)
      .catch((err) => { console.error("[vinext] Layout generateMetadata() failed:", err); return null; });
    _layoutMetaPromises.push(_metaP);
    _accumulatedMeta = _metaP.then(async (_r) =>
      _r ? mergeMetadata([await _parentForLayout, _r]) : await _parentForLayout
    );
  }
  const [_metaResults, _vpResults] = await Promise.all([
    Promise.all(_layoutMetaPromises),
    Promise.all(_filteredLayouts.map((mod) => resolveModuleViewport(mod, _fallbackParams).catch((err) => { console.error("[vinext] Layout generateViewport() failed:", err); return null; }))),
  ]);
  const metadataList = _metaResults.filter(Boolean);
  const viewportList = _vpResults.filter(Boolean);
  const resolvedMetadata = metadataList.length > 0 ? mergeMetadata(metadataList) : null;
  const resolvedViewport = mergeViewport(viewportList);

  // Build element: metadata head + noindex meta + boundary component wrapped in layouts
  // Always include charset and default viewport for parity with Next.js.
  const charsetMeta = createElement("meta", { charSet: "utf-8" });
  const noindexMeta = createElement("meta", { name: "robots", content: "noindex" });
  const headElements = [charsetMeta, noindexMeta];
  if (resolvedMetadata) headElements.push(createElement(MetadataHead, { metadata: resolvedMetadata }));
  headElements.push(createElement(ViewportHead, { viewport: resolvedViewport }));
  let element = createElement(Fragment, null, ...headElements, createElement(BoundaryComponent));
  if (isRscRequest) {
    // For RSC requests (client-side navigation), wrap the element with the same
    // component wrappers that buildPageElement() uses. Without these wrappers,
    // React's reconciliation would see a mismatched tree structure between the
    // old fiber tree (ErrorBoundary > LayoutSegmentProvider > html > body > NotFoundBoundary > ...)
    // and the new tree (html > body > ...), causing it to destroy and recreate
    // the entire DOM tree, resulting in a blank white page.
    //
    // We wrap each layout with LayoutSegmentProvider and add GlobalErrorBoundary
    // to match the wrapping order in buildPageElement(), ensuring smooth
    // client-side tree reconciliation.
    const _treePositions = route?.layoutTreePositions;
    const _routeSegs = route?.routeSegments || [];
    const _fallbackParams = opts?.matchedParams ?? route?.params ?? {};
    const _asyncFallbackParams = makeThenableParams(_fallbackParams);
    for (let i = layouts.length - 1; i >= 0; i--) {
      const LayoutComponent = layouts[i]?.default;
      if (LayoutComponent) {
        element = createElement(LayoutComponent, { children: element, params: _asyncFallbackParams });
        const _tp = _treePositions ? _treePositions[i] : 0;
        const _cs = __resolveChildSegments(_routeSegs, _tp, _fallbackParams);
        element = createElement(LayoutSegmentProvider, { childSegments: _cs }, element);
      }
    }
    ${
      globalErrorVar
        ? `
    const _GlobalErrorComponent = ${globalErrorVar}.default;
    if (_GlobalErrorComponent) {
      element = createElement(ErrorBoundary, {
        fallback: _GlobalErrorComponent,
        children: element,
      });
    }
    `
        : ""
    }
    const _pathname = new URL(request.url).pathname;
    const onRenderError = createRscOnErrorHandler(
      request,
      _pathname,
      route?.pattern ?? _pathname,
    );
    const rscStream = renderToReadableStream(element, { onError: onRenderError });
    // Do NOT clear context here — the RSC stream is consumed lazily by the client.
    // Clearing context now would cause async server components (e.g. NextIntlClientProviderServer)
    // that run during stream consumption to see null headers/navigation context and throw,
    // resulting in missing provider context on the client (e.g. next-intl useTranslations fails
    // with "context from NextIntlClientProvider was not found").
    // Context is cleared naturally when the ALS scope from runWithRequestContext unwinds.
    return new Response(rscStream, {
      status: statusCode,
      headers: { "Content-Type": "text/x-component; charset=utf-8", "Vary": "RSC, Accept" },
    });
  }
  // For HTML (full page load) responses, wrap with layouts only (no client-side
  // wrappers needed since SSR generates the complete HTML document).
  const _fallbackParamsHtml = opts?.matchedParams ?? route?.params ?? {};
  const _asyncFallbackParamsHtml = makeThenableParams(_fallbackParamsHtml);
  for (let i = layouts.length - 1; i >= 0; i--) {
    const LayoutComponent = layouts[i]?.default;
    if (LayoutComponent) {
      element = createElement(LayoutComponent, { children: element, params: _asyncFallbackParamsHtml });
    }
  }
  const _pathname = new URL(request.url).pathname;
  const onRenderError = createRscOnErrorHandler(
    request,
    _pathname,
    route?.pattern ?? _pathname,
  );
  const rscStream = renderToReadableStream(element, { onError: onRenderError });
  // Collect font data from RSC environment
  const fontData = {
    links: _getSSRFontLinks(),
    styles: _getSSRFontStyles(),
    preloads: _getSSRFontPreloads(),
  };
  const ssrEntry = await import.meta.viteRsc.loadModule("ssr", "index");
  const htmlStream = await ssrEntry.handleSsr(rscStream, _getNavigationContext(), fontData);
  setHeadersContext(null);
  setNavigationContext(null);
  const _respHeaders = { "Content-Type": "text/html; charset=utf-8", "Vary": "RSC, Accept" };
  const _linkParts = (fontData.preloads || []).map(function(p) { return "<" + p.href + ">; rel=preload; as=font; type=" + p.type + "; crossorigin"; });
  if (_linkParts.length > 0) _respHeaders["Link"] = _linkParts.join(", ");
  return new Response(htmlStream, {
    status: statusCode,
    headers: _respHeaders,
  });
}

/** Convenience: render a not-found page (404) */
async function renderNotFoundPage(route, isRscRequest, request, matchedParams) {
  return renderHTTPAccessFallbackPage(route, 404, isRscRequest, request, { matchedParams });
}

/**
 * Render an error.tsx boundary page when a server component or generateMetadata() throws.
 * Returns null if no error boundary component is available for this route.
 *
 * Next.js returns HTTP 200 when error.tsx catches an error (the error is "handled"
 * by the boundary). This matches that behavior intentionally.
 */
async function renderErrorBoundaryPage(route, error, isRscRequest, request, matchedParams) {
  // Resolve the error boundary component: leaf error.tsx first, then walk per-layout
  // errors from innermost to outermost (matching ancestor inheritance), then global-error.tsx.
  let ErrorComponent = route?.error?.default ?? null;
  let _isGlobalError = false;
  if (!ErrorComponent && route?.errors) {
    for (let i = route.errors.length - 1; i >= 0; i--) {
      if (route.errors[i]?.default) {
        ErrorComponent = route.errors[i].default;
        break;
      }
    }
  }
  ${
    globalErrorVar
      ? `
  if (!ErrorComponent) {
    ErrorComponent = ${globalErrorVar}?.default ?? null;
    _isGlobalError = !!ErrorComponent;
  }
  `
      : ""
  }
  if (!ErrorComponent) return null;

  const rawError = error instanceof Error ? error : new Error(String(error));
  // Sanitize the error in production to avoid leaking internal details
  // (database errors, file paths, stack traces) through error.tsx to the client.
  // In development, pass the original error for debugging.
  const errorObj = __sanitizeErrorForClient(rawError);
  // Only pass error — reset is a client-side concern (re-renders the segment) and
  // can't be serialized through RSC. The error.tsx component will receive reset=undefined
  // during SSR, which is fine — onClick={undefined} is harmless, and the real reset
  // function is only meaningful after hydration.
  let element = createElement(ErrorComponent, {
    error: errorObj,
  });

  // global-error.tsx provides its own <html> and <body> (it replaces the root
  // layout). Skip layout wrapping when rendering it to avoid double <html> tags.
  if (!_isGlobalError) {
    const layouts = route?.layouts ?? rootLayouts;
    if (isRscRequest) {
      // For RSC requests (client-side navigation), wrap with the same component
      // wrappers that buildPageElement() uses (LayoutSegmentProvider, GlobalErrorBoundary).
      // This ensures React can reconcile the tree without destroying the DOM.
      // Same rationale as renderHTTPAccessFallbackPage — see comment there.
      const _errTreePositions = route?.layoutTreePositions;
      const _errRouteSegs = route?.routeSegments || [];
      const _errParams = matchedParams ?? route?.params ?? {};
      const _asyncErrParams = makeThenableParams(_errParams);
      for (let i = layouts.length - 1; i >= 0; i--) {
        const LayoutComponent = layouts[i]?.default;
        if (LayoutComponent) {
          element = createElement(LayoutComponent, { children: element, params: _asyncErrParams });
          const _etp = _errTreePositions ? _errTreePositions[i] : 0;
          const _ecs = __resolveChildSegments(_errRouteSegs, _etp, _errParams);
          element = createElement(LayoutSegmentProvider, { childSegments: _ecs }, element);
        }
      }
      ${
        globalErrorVar
          ? `
      const _ErrGlobalComponent = ${globalErrorVar}.default;
      if (_ErrGlobalComponent) {
        element = createElement(ErrorBoundary, {
          fallback: _ErrGlobalComponent,
          children: element,
        });
      }
      `
          : ""
      }
    } else {
      // For HTML (full page load) responses, wrap with layouts only.
      const _errParamsHtml = matchedParams ?? route?.params ?? {};
      const _asyncErrParamsHtml = makeThenableParams(_errParamsHtml);
      for (let i = layouts.length - 1; i >= 0; i--) {
        const LayoutComponent = layouts[i]?.default;
        if (LayoutComponent) {
          element = createElement(LayoutComponent, { children: element, params: _asyncErrParamsHtml });
        }
      }
    }
  }

  const _pathname = new URL(request.url).pathname;
  const onRenderError = createRscOnErrorHandler(
    request,
    _pathname,
    route?.pattern ?? _pathname,
  );

  if (isRscRequest) {
    const rscStream = renderToReadableStream(element, { onError: onRenderError });
    // Do NOT clear context here — the RSC stream is consumed lazily by the client.
    // Clearing context now would cause async server components (e.g. NextIntlClientProviderServer)
    // that run during stream consumption to see null headers/navigation context and throw,
    // resulting in missing provider context on the client (e.g. next-intl useTranslations fails
    // with "context from NextIntlClientProvider was not found").
    // Context is cleared naturally when the ALS scope from runWithRequestContext unwinds.
    return new Response(rscStream, {
      status: 200,
      headers: { "Content-Type": "text/x-component; charset=utf-8", "Vary": "RSC, Accept" },
    });
  }

  // HTML (full page load) response — render through RSC → SSR pipeline
  const rscStream = renderToReadableStream(element, { onError: onRenderError });
  // Collect font data from RSC environment so error pages include font styles
  const fontData = {
    links: _getSSRFontLinks(),
    styles: _getSSRFontStyles(),
    preloads: _getSSRFontPreloads(),
  };
  const ssrEntry = await import.meta.viteRsc.loadModule("ssr", "index");
  const htmlStream = await ssrEntry.handleSsr(rscStream, _getNavigationContext(), fontData);
  setHeadersContext(null);
  setNavigationContext(null);
  const _errHeaders = { "Content-Type": "text/html; charset=utf-8", "Vary": "RSC, Accept" };
  const _errLinkParts = (fontData.preloads || []).map(function(p) { return "<" + p.href + ">; rel=preload; as=font; type=" + p.type + "; crossorigin"; });
  if (_errLinkParts.length > 0) _errHeaders["Link"] = _errLinkParts.join(", ");
  return new Response(htmlStream, {
    status: 200,
    headers: _errHeaders,
  });
}

function matchRoute(url) {
  const pathname = url.split("?")[0];
  let normalizedUrl = pathname === "/" ? "/" : pathname.replace(/\\/$/, "");
   // NOTE: Do NOT decodeURIComponent here. The caller is responsible for decoding
   // the pathname exactly once at the request entry point. Decoding again here
   // would cause inconsistent path matching between middleware and routing.
  const urlParts = normalizedUrl.split("/").filter(Boolean);
  return _trieMatch(_routeTrie, urlParts);
}

// matchPattern is kept for findIntercept (linear scan over small interceptLookup array).
function matchPattern(urlParts, patternParts) {
  const params = Object.create(null);
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    if (pp.endsWith("+")) {
      if (i !== patternParts.length - 1) return null;
      const paramName = pp.slice(1, -1);
      const remaining = urlParts.slice(i);
      if (remaining.length === 0) return null;
      params[paramName] = remaining;
      return params;
    }
    if (pp.endsWith("*")) {
      if (i !== patternParts.length - 1) return null;
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

// Build a global intercepting route lookup for RSC navigation.
// Maps target URL patterns to { sourceRouteIndex, slotName, interceptPage, params }.
const interceptLookup = [];
for (let ri = 0; ri < routes.length; ri++) {
  const r = routes[ri];
  if (!r.slots) continue;
  for (const [slotName, slotMod] of Object.entries(r.slots)) {
    if (!slotMod.intercepts) continue;
    for (const intercept of slotMod.intercepts) {
      interceptLookup.push({
        sourceRouteIndex: ri,
        slotName,
        targetPattern: intercept.targetPattern,
        targetPatternParts: intercept.targetPattern.split("/").filter(Boolean),
        page: intercept.page,
        params: intercept.params,
      });
    }
  }
}

/**
 * Check if a pathname matches any intercepting route.
 * Returns the match info or null.
 */
function findIntercept(pathname) {
  const urlParts = pathname.split("/").filter(Boolean);
  for (const entry of interceptLookup) {
    const params = matchPattern(urlParts, entry.targetPatternParts);
    if (params !== null) {
      return { ...entry, matchedParams: params };
    }
  }
  return null;
}

async function buildPageElement(route, params, opts, searchParams) {
  const PageComponent = route.page?.default;
  if (!PageComponent) {
    return createElement("div", null, "Page has no default export");
  }

  // Resolve metadata and viewport from layouts and page.
  //
  // generateMetadata() accepts a "parent" (Promise of ResolvedMetadata) as its
  // second argument (Next.js 13+). The parent resolves to the accumulated
  // merged metadata of all ancestor segments, enabling patterns like:
  //
  //   const previousImages = (await parent).openGraph?.images ?? []
  //   return { openGraph: { images: ['/new-image.jpg', ...previousImages] } }
  //
  // Next.js uses an eager-execution-with-serial-resolution approach:
  // all generateMetadata() calls are kicked off concurrently, but each
  // segment's "parent" promise resolves only after the preceding segment's
  // metadata is resolved and merged. This preserves concurrency for I/O-bound
  // work while guaranteeing that parent data is available when needed.
  //
  // We build a chain: layoutParentPromises[0] = Promise.resolve({}) (no parent
  // for root layout), layoutParentPromises[i+1] resolves to merge(layouts[0..i]),
  // and pageParentPromise resolves to merge(all layouts).
  //
  // IMPORTANT: Layout metadata errors are swallowed (.catch(() => null)) because
  // a layout's generateMetadata() failing should not crash the page.
  // Page metadata errors are NOT swallowed — if the page's generateMetadata()
  // throws, the error propagates out of buildPageElement() so the caller can
  // route it to the nearest error.tsx boundary (or global-error.tsx).
  const layoutMods = route.layouts.filter(Boolean);

  // Build the parent promise chain and kick off metadata resolution in one pass.
  // Each layout module is called exactly once. layoutMetaPromises[i] is the
  // promise for layout[i]'s own metadata result.
  //
  // All calls are kicked off immediately (concurrent I/O), but each layout's
  // "parent" promise only resolves after the preceding layout's metadata is done.
  const layoutMetaPromises = [];
  let accumulatedMetaPromise = Promise.resolve({});
  for (let i = 0; i < layoutMods.length; i++) {
    const parentForThisLayout = accumulatedMetaPromise;
    // Kick off this layout's metadata resolution now (concurrent with others).
    const metaPromise = resolveModuleMetadata(layoutMods[i], params, undefined, parentForThisLayout)
      .catch((err) => { console.error("[vinext] Layout generateMetadata() failed:", err); return null; });
    layoutMetaPromises.push(metaPromise);
    // Advance accumulator: resolves to merged(layouts[0..i]) once layout[i] is done.
    accumulatedMetaPromise = metaPromise.then(async (result) =>
      result ? mergeMetadata([await parentForThisLayout, result]) : await parentForThisLayout
    );
  }
  // Page's parent is the fully-accumulated layout metadata.
  const pageParentPromise = accumulatedMetaPromise;

  // Convert URLSearchParams → plain object so we can pass it to
  // resolveModuleMetadata (which expects Record<string, string | string[]>).
  // This same object is reused for pageProps.searchParams below.
  const spObj = {};
  let hasSearchParams = false;
  if (searchParams && searchParams.forEach) {
    searchParams.forEach(function(v, k) {
      hasSearchParams = true;
      if (k in spObj) {
        spObj[k] = Array.isArray(spObj[k]) ? spObj[k].concat(v) : [spObj[k], v];
      } else {
        spObj[k] = v;
      }
    });
  }

  const [layoutMetaResults, layoutVpResults, pageMeta, pageVp] = await Promise.all([
    Promise.all(layoutMetaPromises),
    Promise.all(layoutMods.map((mod) => resolveModuleViewport(mod, params).catch((err) => { console.error("[vinext] Layout generateViewport() failed:", err); return null; }))),
    route.page ? resolveModuleMetadata(route.page, params, spObj, pageParentPromise) : Promise.resolve(null),
    route.page ? resolveModuleViewport(route.page, params) : Promise.resolve(null),
  ]);

  const metadataList = [...layoutMetaResults.filter(Boolean), ...(pageMeta ? [pageMeta] : [])];
  const viewportList = [...layoutVpResults.filter(Boolean), ...(pageVp ? [pageVp] : [])];
  const resolvedMetadata = metadataList.length > 0 ? mergeMetadata(metadataList) : null;
  const resolvedViewport = mergeViewport(viewportList);

  // Build nested layout tree from outermost to innermost.
  // Next.js 16 passes params/searchParams as Promises (async pattern)
  // but pre-16 code accesses them as plain objects (params.id).
  // makeThenableParams() normalises null-prototype + preserves both patterns.
  const asyncParams = makeThenableParams(params);
  const pageProps = { params: asyncParams };
  if (searchParams) {
    // Always provide searchParams prop when the URL object is available, even
    // when the query string is empty -- pages that do "await searchParams" need
    // it to be a thenable rather than undefined.
    pageProps.searchParams = makeThenableParams(spObj);
    // If the URL has query parameters, mark the page as dynamic.
    // In Next.js, only accessing the searchParams prop signals dynamic usage,
    // but a Proxy-based approach doesn't work here because React's RSC debug
    // serializer accesses properties on all props (e.g. $$typeof check in
    // isClientReference), triggering the Proxy even when user code doesn't
    // read searchParams. Checking for non-empty query params is a safe
    // approximation: pages with query params in the URL are almost always
    // dynamic, and this avoids false positives from React internals.
    if (hasSearchParams) markDynamicUsage();
  }
  let element = createElement(PageComponent, pageProps);

  // Wrap page with empty segment provider so useSelectedLayoutSegments()
  // returns [] when called from inside a page component (leaf node).
  element = createElement(LayoutSegmentProvider, { childSegments: [] }, element);

  // Add metadata + viewport head tags (React 19 hoists title/meta/link to <head>)
  // Next.js always injects charset and default viewport even when no metadata/viewport
  // is exported. We replicate that by always emitting these essential head elements.
  {
    const headElements = [];
    // Always emit <meta charset="utf-8"> — Next.js includes this on every page
    headElements.push(createElement("meta", { charSet: "utf-8" }));
    if (resolvedMetadata) headElements.push(createElement(MetadataHead, { metadata: resolvedMetadata }));
    headElements.push(createElement(ViewportHead, { viewport: resolvedViewport }));
    element = createElement(Fragment, null, ...headElements, element);
  }

  // Wrap with loading.tsx Suspense if present
  if (route.loading?.default) {
    element = createElement(
      Suspense,
      { fallback: createElement(route.loading.default) },
      element,
    );
  }

  // Wrap with the leaf's error.tsx ErrorBoundary if it's not already covered
  // by a per-layout error boundary (i.e., the leaf has error.tsx but no layout).
  // Per-layout error boundaries are interleaved with layouts below.
  {
    const lastLayoutError = route.errors ? route.errors[route.errors.length - 1] : null;
    if (route.error?.default && route.error !== lastLayoutError) {
      element = createElement(ErrorBoundary, {
        fallback: route.error.default,
        children: element,
      });
    }
  }

  // Wrap with NotFoundBoundary so client-side notFound() renders not-found.tsx
  // instead of crashing the React tree. Must be above ErrorBoundary since
  // ErrorBoundary re-throws notFound errors.
  // Pre-render the not-found component as a React element since it may be a
  // server component (not a client reference) and can't be passed as a function prop.
  {
    const NotFoundComponent = route.notFound?.default ?? ${rootNotFoundVar ? `${rootNotFoundVar}?.default` : "null"};
    if (NotFoundComponent) {
      element = createElement(NotFoundBoundary, {
        fallback: createElement(NotFoundComponent),
        children: element,
      });
    }
  }

  // Wrap with templates (innermost first, then outer)
  // Templates are like layouts but re-mount on navigation (client-side concern).
  // On the server, they just wrap the content like layouts do.
  if (route.templates) {
    for (let i = route.templates.length - 1; i >= 0; i--) {
      const TemplateComponent = route.templates[i]?.default;
      if (TemplateComponent) {
        element = createElement(TemplateComponent, { children: element, params });
      }
    }
  }

  // Wrap with layouts (innermost first, then outer).
  // At each layout level, first wrap with that level's error boundary (if any)
  // so the boundary is inside the layout and catches errors from children.
  // This matches Next.js behavior: Layout > ErrorBoundary > children.
  // Parallel slots are passed as named props to the innermost layout
  // (the layout at the same directory level as the page/slots)
  for (let i = route.layouts.length - 1; i >= 0; i--) {
    // Wrap with per-layout error boundary before wrapping with layout.
    // This places the ErrorBoundary inside the layout, catching errors
    // from child segments (matching Next.js per-segment error handling).
    if (route.errors && route.errors[i]?.default) {
      element = createElement(ErrorBoundary, {
        fallback: route.errors[i].default,
        children: element,
      });
    }

    const LayoutComponent = route.layouts[i]?.default;
    if (LayoutComponent) {
      // Per-layout NotFoundBoundary: wraps this layout's children so that
      // notFound() thrown from a child layout is caught here.
      // Matches Next.js behavior where each segment has its own boundary.
      // The boundary at level N catches errors from Layout[N+1] and below,
      // but NOT from Layout[N] itself (which propagates to level N-1).
      {
        const LayoutNotFound = route.notFounds?.[i]?.default;
        if (LayoutNotFound) {
          element = createElement(NotFoundBoundary, {
            fallback: createElement(LayoutNotFound),
            children: element,
          });
        }
      }

      const layoutProps = { children: element, params: makeThenableParams(params) };

      // Add parallel slot elements to the layout that defines them.
      // Each slot has a layoutIndex indicating which layout it belongs to.
      if (route.slots) {
        for (const [slotName, slotMod] of Object.entries(route.slots)) {
          // Attach slot to the layout at its layoutIndex, or to the innermost layout if -1
          const targetIdx = slotMod.layoutIndex >= 0 ? slotMod.layoutIndex : route.layouts.length - 1;
          if (i !== targetIdx) continue;
          // Check if this slot has an intercepting route that should activate
          let SlotPage = null;
          let slotParams = params;

          if (opts && opts.interceptSlot === slotName && opts.interceptPage) {
            // Use the intercepting route's page component
            SlotPage = opts.interceptPage.default;
            slotParams = opts.interceptParams || params;
          } else {
            SlotPage = slotMod.page?.default || slotMod.default?.default;
          }

          if (SlotPage) {
            let slotElement = createElement(SlotPage, { params: makeThenableParams(slotParams) });
            // Wrap with slot-specific layout if present.
            // In Next.js, @slot/layout.tsx wraps the slot's page content
            // before it is passed as a prop to the parent layout.
            const SlotLayout = slotMod.layout?.default;
            if (SlotLayout) {
              slotElement = createElement(SlotLayout, {
                children: slotElement,
                params: makeThenableParams(slotParams),
              });
            }
            // Wrap with slot-specific loading if present
            if (slotMod.loading?.default) {
              slotElement = createElement(Suspense,
                { fallback: createElement(slotMod.loading.default) },
                slotElement,
              );
            }
            // Wrap with slot-specific error boundary if present
            if (slotMod.error?.default) {
              slotElement = createElement(ErrorBoundary, {
                fallback: slotMod.error.default,
                children: slotElement,
              });
            }
            layoutProps[slotName] = slotElement;
          }
        }
      }

      element = createElement(LayoutComponent, layoutProps);

      // Wrap the layout with LayoutSegmentProvider so useSelectedLayoutSegments()
      // called INSIDE this layout gets the correct child segments. We resolve the
      // route tree segments using actual param values and pass them through context.
      // We wrap the layout (not just children) because hooks are called from
      // components rendered inside the layout's own JSX.
      const treePos = route.layoutTreePositions ? route.layoutTreePositions[i] : 0;
      const childSegs = __resolveChildSegments(route.routeSegments || [], treePos, params);
      element = createElement(LayoutSegmentProvider, { childSegments: childSegs }, element);
    }
  }

  // Wrap with global error boundary if app/global-error.tsx exists.
  // This must be present in both HTML and RSC paths so the component tree
  // structure matches — otherwise React reconciliation on client-side navigation
  // would see a mismatched tree and destroy/recreate the DOM.
  //
  // For RSC requests (client-side nav), this provides error recovery on the client.
  // For HTML requests (initial page load), the ErrorBoundary catches during SSR
  // but produces double <html>/<body> (root layout + global-error). The request
  // handler detects this via the rscOnError flag and re-renders without layouts.
  ${
    globalErrorVar
      ? `
  const GlobalErrorComponent = ${globalErrorVar}.default;
  if (GlobalErrorComponent) {
    element = createElement(ErrorBoundary, {
      fallback: GlobalErrorComponent,
      children: element,
    });
  }
  `
      : ""
  }

  return element;
}

${middlewarePath ? generateMiddlewareMatcherCode("modern") : ""}

const __basePath = ${JSON.stringify(bp)};
const __trailingSlash = ${JSON.stringify(ts)};
const __i18nConfig = ${JSON.stringify(i18nConfig)};
const __configRedirects = ${JSON.stringify(redirects)};
const __configRewrites = ${JSON.stringify(rewrites)};
const __configHeaders = ${JSON.stringify(headers)};
const __allowedOrigins = ${JSON.stringify(allowedOrigins)};

${generateDevOriginCheckCode(config?.allowedDevOrigins)}

// ── ReDoS-safe regex compilation (still needed for middleware matching) ──
${generateSafeRegExpCode("modern")}

// ── Path normalization ──────────────────────────────────────────────────
${generateNormalizePathCode("modern")}
${generateRouteMatchNormalizationCode("modern")}

// ── Config pattern matching, redirects, rewrites, headers, CSRF validation,
//    external URL proxy, cookie parsing, and request context are imported from
//    config-matchers.ts and request-pipeline.ts (see import statements above).
//    This eliminates ~250 lines of duplicated inline code and ensures the
//    single-pass tokenizer in config-matchers.ts is used consistently
//    (fixing the chained .replace() divergence flagged by CodeQL).

/**
 * Build a request context from the live ALS HeadersContext, which reflects
 * any x-middleware-request-* header mutations applied by middleware.
 * Used for afterFiles and fallback rewrite has/missing evaluation — these
 * run after middleware in the App Router execution order.
 */
function __buildPostMwRequestContext(request) {
  const url = new URL(request.url);
  const ctx = getHeadersContext();
  if (!ctx) return requestContextFromRequest(request);
  // ctx.cookies is a Map<string, string> (HeadersContext), but RequestContext
  // requires a plain Record<string, string> for has/missing cookie evaluation
  // (config-matchers.ts uses obj[key] not Map.get()). Convert here.
  const cookiesRecord = Object.fromEntries(ctx.cookies);
  return {
    headers: ctx.headers,
    cookies: cookiesRecord,
    query: url.searchParams,
    host: normalizeHost(ctx.headers.get("host"), url.hostname),
  };
}

/**
 * Maximum server-action request body size.
 * Configurable via experimental.serverActions.bodySizeLimit in next.config.
 * Defaults to 1MB, matching the Next.js default.
 * @see https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions#bodysizelimit
 * Prevents unbounded request body buffering.
 */
var __MAX_ACTION_BODY_SIZE = ${JSON.stringify(bodySizeLimit)};

/**
 * Read a request body as text with a size limit.
 * Enforces the limit on the actual byte stream to prevent bypasses
 * via chunked transfer-encoding where Content-Length is absent or spoofed.
 */
async function __readBodyWithLimit(request, maxBytes) {
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

/**
 * Read a request body as FormData with a size limit.
 * Consumes the body stream with a byte counter and then parses the
 * collected bytes as multipart form data via the Response constructor.
 */
async function __readFormDataWithLimit(request, maxBytes) {
  if (!request.body) return new FormData();
  var reader = request.body.getReader();
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
    chunks.push(result.value);
  }
  // Reconstruct a Response with the original Content-Type so that
  // the FormData parser can handle multipart boundaries correctly.
  var combined = new Uint8Array(totalSize);
  var offset = 0;
  for (var chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  var contentType = request.headers.get("content-type") || "";
  return new Response(combined, { headers: { "Content-Type": contentType } }).formData();
}

// Map from route pattern to generateStaticParams function.
// Used by the prerender phase to enumerate dynamic route URLs without
// loading route modules via the dev server.
export const generateStaticParamsMap = {
// TODO: layout-level generateStaticParams — this map only includes routes that
// have a pagePath (leaf pages). Layout segments can also export generateStaticParams
// to provide parent params for nested dynamic routes, but they don't have a pagePath
// so they are excluded here. Supporting layout-level generateStaticParams requires
// scanning layout.tsx files separately and including them in this map.
${routes
  .filter((r) => r.isDynamic && r.pagePath)
  .map(
    (r) =>
      `  ${JSON.stringify(r.pattern)}: ${getImportVar(r.pagePath!)}?.generateStaticParams ?? null,`,
  )
  .join("\n")}
};

export default async function handler(request, ctx) {
  ${
    instrumentationPath
      ? `// Ensure instrumentation.register() has run before handling the first request.
  // This is a no-op after the first call (guarded by __instrumentationInitialized).
  await __ensureInstrumentation();
  `
      : ""
  }
  // Wrap the entire request in a single unified ALS scope for per-request
  // isolation. All state modules (headers, navigation, cache, fetch-cache,
  // execution-context) read from this store via isInsideUnifiedScope().
  const headersCtx = headersContextFromRequest(request);
  const __uCtx = _createUnifiedCtx({
    headersContext: headersCtx,
    executionContext: ctx ?? _getRequestExecutionContext() ?? null,
  });
  return _runWithUnifiedCtx(__uCtx, async () => {
    _ensureFetchPatch();
    const __reqCtx = requestContextFromRequest(request);
    // Per-request container for middleware state. Passed into
    // _handleRequest which fills in .headers and .status;
    // avoids module-level variables that race on Workers.
    const _mwCtx = { headers: null, status: null };
    const response = await _handleRequest(request, __reqCtx, _mwCtx);
    // Apply custom headers from next.config.js to non-redirect responses.
    // Skip redirects (3xx) because Response.redirect() creates immutable headers,
    // and Next.js doesn't apply custom headers to redirects anyway.
    if (response && response.headers && !(response.status >= 300 && response.status < 400)) {
      if (__configHeaders.length) {
        const url = new URL(request.url);
        let pathname;
        try { pathname = __normalizePath(__normalizePathnameForRouteMatch(url.pathname)); } catch { pathname = url.pathname; }
        ${bp ? `if (pathname.startsWith(${JSON.stringify(bp)})) pathname = pathname.slice(${JSON.stringify(bp)}.length) || "/";` : ""}
        const extraHeaders = matchHeaders(pathname, __configHeaders, __reqCtx);
        for (const h of extraHeaders) {
          // Use append() for headers where multiple values must coexist
          // (Vary, Set-Cookie). Using set() on these would destroy
          // existing values like "Vary: RSC, Accept" which are critical
          // for correct CDN caching behavior.
          const lk = h.key.toLowerCase();
          if (lk === "vary" || lk === "set-cookie") {
            response.headers.append(h.key, h.value);
          } else if (!response.headers.has(lk)) {
            // Middleware headers take precedence: skip config keys already
            // set by middleware so middleware headers always win.
            response.headers.set(h.key, h.value);
          }
        }
      }
    }
    return response;
  });
}

async function _handleRequest(request, __reqCtx, _mwCtx) {
  const __reqStart = process.env.NODE_ENV !== "production" ? performance.now() : 0;
  let __compileEnd;
  let __renderEnd;
  // __reqStart is included in the timing header so the Node logging middleware
  // can compute true compile time as: handlerStart - middlewareStart.
  // Format: "handlerStart,compileMs,renderMs" - all as integers (ms). Dev-only.
  const url = new URL(request.url);

  // ── Cross-origin request protection (dev only) ─────────────────────
  // Block requests from non-localhost origins to prevent data exfiltration.
  // Skipped in production — Vite replaces NODE_ENV at build time.
  if (process.env.NODE_ENV !== "production") {
    const __originBlock = __validateDevRequestOrigin(request);
    if (__originBlock) return __originBlock;
  }

  // Guard against protocol-relative URL open redirects (see request-pipeline.ts).
  const __protoGuard = guardProtocolRelativeUrl(url.pathname);
  if (__protoGuard) return __protoGuard;

  // Decode percent-encoding segment-wise and normalize pathname to canonical form.
  // This preserves encoded path delimiters like %2F within a single segment.
  // __normalizePath collapses //foo///bar → /foo/bar, resolves . and .. segments.
  let decodedUrlPathname;
  try { decodedUrlPathname = __normalizePathnameForRouteMatchStrict(url.pathname); } catch (e) {
    return new Response("Bad Request", { status: 400 });
  }
  let pathname = __normalizePath(decodedUrlPathname);

  ${
    bp
      ? `
  // Strip basePath prefix
  pathname = stripBasePath(pathname, __basePath);
  `
      : ""
  }

  // ── Prerender: static-params endpoint ────────────────────────────────
  // Internal endpoint used by prerenderApp() during build to fetch
  // generateStaticParams results via wrangler unstable_startWorker.
  // Gated on VINEXT_PRERENDER=1 to prevent exposure in normal deployments.
  // For Node builds, process.env.VINEXT_PRERENDER is set directly by the
  // prerender orchestrator. For CF Workers builds, wrangler unstable_startWorker
  // injects VINEXT_PRERENDER as a binding which Miniflare exposes via process.env
  // in bundled workers. The /__vinext/ prefix ensures no user route ever conflicts.
  if (pathname === "/__vinext/prerender/static-params") {
    if (process.env.VINEXT_PRERENDER !== "1") {
      return new Response("Not Found", { status: 404 });
    }
    const pattern = url.searchParams.get("pattern");
    if (!pattern) return new Response("missing pattern", { status: 400 });
    const fn = generateStaticParamsMap[pattern];
    if (typeof fn !== "function") return new Response("null", { status: 200, headers: { "content-type": "application/json" } });
    try {
      const parentParams = url.searchParams.get("parentParams");
      const raw = parentParams ? JSON.parse(parentParams) : {};
      // Ensure params is a plain object — reject primitives, arrays, and null
      // so user-authored generateStaticParams always receives { params: {} }
      // rather than { params: 5 } or similar if input is malformed.
      const params = (typeof raw === "object" && raw !== null && !Array.isArray(raw)) ? raw : {};
      const result = await fn({ params });
      return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "content-type": "application/json" } });
    }
  }

  ${
    hasPagesDir
      ? `
  // ── Prerender: pages-static-paths endpoint ───────────────────────────
  // Internal endpoint used by prerenderPages() during a CF Workers hybrid
  // build to call getStaticPaths() for dynamic Pages Router routes via
  // wrangler unstable_startWorker. Returns JSON-serialised getStaticPaths result.
  // Gated on VINEXT_PRERENDER=1 to prevent exposure in normal deployments.
  // See static-params endpoint above for process.env vs CF vars notes.
  //
  // pageRoutes lives in the SSR environment (virtual:vinext-server-entry).
  // We load it lazily via import.meta.viteRsc.loadModule — the same pattern
  // used by handleSsr() elsewhere in this template. At build time, Vite's RSC
  // plugin transforms this call into a bundled cross-environment import, so it
  // works correctly in the CF Workers production bundle running in Miniflare.
  if (pathname === "/__vinext/prerender/pages-static-paths") {
    if (process.env.VINEXT_PRERENDER !== "1") {
      return new Response("Not Found", { status: 404 });
    }
    const __gspPattern = url.searchParams.get("pattern");
    if (!__gspPattern) return new Response("missing pattern", { status: 400 });
    try {
      const __gspSsrEntry = await import.meta.viteRsc.loadModule("ssr", "index");
      const __pagesRoutes = __gspSsrEntry.pageRoutes;
      const __gspRoute = Array.isArray(__pagesRoutes)
        ? __pagesRoutes.find((r) => r.pattern === __gspPattern)
        : undefined;
      if (!__gspRoute || typeof __gspRoute.module?.getStaticPaths !== "function") {
        return new Response("null", { status: 200, headers: { "content-type": "application/json" } });
      }
      const __localesParam = url.searchParams.get("locales");
      const __locales = __localesParam ? JSON.parse(__localesParam) : [];
      const __defaultLocale = url.searchParams.get("defaultLocale") ?? "";
      const __gspResult = await __gspRoute.module.getStaticPaths({ locales: __locales, defaultLocale: __defaultLocale });
      return new Response(JSON.stringify(__gspResult), { status: 200, headers: { "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "content-type": "application/json" } });
    }
  }
  `
      : ""
  }

  // Trailing slash normalization (redirect to canonical form)
  const __tsRedirect = normalizeTrailingSlash(pathname, __basePath, __trailingSlash, url.search);
  if (__tsRedirect) return __tsRedirect;

  // ── Apply redirects from next.config.js ───────────────────────────────
  if (__configRedirects.length) {
    // Strip .rsc suffix before matching redirect rules - RSC (client-side nav) requests
    // arrive as /some/path.rsc but redirect patterns are defined without it (e.g.
    // /some/path). Without this, soft-nav fetches bypass all config redirects.
    const __redirPathname = pathname.endsWith(".rsc") ? pathname.slice(0, -4) : pathname;
    const __redir = matchRedirect(__redirPathname, __configRedirects, __reqCtx);
    if (__redir) {
      const __redirDest = sanitizeDestination(
        __basePath &&
          !isExternalUrl(__redir.destination) &&
          !hasBasePath(__redir.destination, __basePath)
          ? __basePath + __redir.destination
          : __redir.destination
      );
      return new Response(null, {
        status: __redir.permanent ? 308 : 307,
        headers: { Location: __redirDest },
      });
    }
  }

  const isRscRequest = pathname.endsWith(".rsc") || request.headers.get("accept")?.includes("text/x-component");
  let cleanPathname = pathname.replace(/\\.rsc$/, "");

  // Middleware response headers and custom rewrite status are stored in
  // _mwCtx (per-request container) so handler() can merge them into
  // every response path without module-level state that races on Workers.

  ${
    middlewarePath
      ? `
  // In hybrid app+pages dev mode the connect handler already ran middleware
  // and forwarded the results via x-vinext-mw-ctx. Reconstruct _mwCtx from
  // the forwarded data instead of re-running the middleware function.
  // Guarded by NODE_ENV because this header only exists in dev (the connect
  // handler sets it). In production there is no connect handler, so an
  // attacker-supplied header must not be trusted.
  let __mwCtxApplied = false;
  if (process.env.NODE_ENV !== "production") {
    const __mwCtxHeader = request.headers.get("x-vinext-mw-ctx");
    if (__mwCtxHeader) {
      try {
        const __mwCtxData = JSON.parse(__mwCtxHeader);
        if (__mwCtxData.h && __mwCtxData.h.length > 0) {
          // Note: h may include x-middleware-request-* internal headers so
          // applyMiddlewareRequestHeaders() can unpack them below.
          // processMiddlewareHeaders() strips them before any response.
          _mwCtx.headers = new Headers();
          for (const [key, value] of __mwCtxData.h) {
            _mwCtx.headers.append(key, value);
          }
        }
        if (__mwCtxData.s != null) {
          _mwCtx.status = __mwCtxData.s;
        }
        // Apply forwarded middleware rewrite so routing uses the rewritten path.
        // The RSC plugin constructs its Request from the original HTTP request,
        // not from req.url, so the connect handler's req.url rewrite is invisible.
        if (__mwCtxData.r) {
          const __rewriteParsed = new URL(__mwCtxData.r, request.url);
          cleanPathname = __rewriteParsed.pathname;
          url.search = __rewriteParsed.search;
        }
        // Flag set after full context application — if any step fails (e.g. malformed
        // rewrite URL), we fall back to re-running middleware as a safety net.
        __mwCtxApplied = true;
      } catch (e) {
        console.error("[vinext] Failed to parse forwarded middleware context:", e);
      }
    }
  }
  if (!__mwCtxApplied) {
   // Run proxy/middleware if present and path matches.
   // Validate exports match the file type (proxy.ts vs middleware.ts), matching Next.js behavior.
   // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/proxy-missing-export/proxy-missing-export.test.ts
  const _isProxy = ${JSON.stringify(isProxyFile(middlewarePath))};
  const middlewareFn = _isProxy
    ? (middlewareModule.proxy ?? middlewareModule.default)
    : (middlewareModule.middleware ?? middlewareModule.default);
  if (typeof middlewareFn !== "function") {
    const _fileType = _isProxy ? "Proxy" : "Middleware";
    const _expectedExport = _isProxy ? "proxy" : "middleware";
    throw new Error("The " + _fileType + " file must export a function named \`" + _expectedExport + "\` or a \`default\` function.");
  }
  const middlewareMatcher = middlewareModule.config?.matcher;
  if (matchesMiddleware(cleanPathname, middlewareMatcher, request, __i18nConfig)) {
    try {
      // Wrap in NextRequest so middleware gets .nextUrl, .cookies, .geo, .ip, etc.
       // Always construct a new Request with the fully decoded + normalized pathname
       // so middleware and the router see the same canonical path.
      const mwUrl = new URL(request.url);
      mwUrl.pathname = cleanPathname;
      const mwRequest = new Request(mwUrl, request);
      const nextRequest = mwRequest instanceof NextRequest ? mwRequest : new NextRequest(mwRequest);
      const mwFetchEvent = new NextFetchEvent({ page: cleanPathname });
      const mwResponse = await middlewareFn(nextRequest, mwFetchEvent);
      const _mwWaitUntil = mwFetchEvent.drainWaitUntil();
      const _mwExecCtx = _getRequestExecutionContext();
      if (_mwExecCtx && typeof _mwExecCtx.waitUntil === "function") { _mwExecCtx.waitUntil(_mwWaitUntil); }
      if (mwResponse) {
        // Check for x-middleware-next (continue)
        if (mwResponse.headers.get("x-middleware-next") === "1") {
          // Middleware wants to continue — collect all headers except the two
          // control headers we've already consumed.  x-middleware-request-*
          // headers are kept so applyMiddlewareRequestHeaders() can unpack them;
          // the blanket strip loop after that call removes every remaining
          // x-middleware-* header before the set is merged into the response.
           _mwCtx.headers = new Headers();
          for (const [key, value] of mwResponse.headers) {
            if (key !== "x-middleware-next" && key !== "x-middleware-rewrite") {
              _mwCtx.headers.append(key, value);
            }
          }
        } else {
          // Check for redirect
          if (mwResponse.status >= 300 && mwResponse.status < 400) {
            return mwResponse;
          }
          // Check for rewrite
          const rewriteUrl = mwResponse.headers.get("x-middleware-rewrite");
          if (rewriteUrl) {
            const rewriteParsed = new URL(rewriteUrl, request.url);
            cleanPathname = rewriteParsed.pathname;
            // Carry over query params from the rewrite URL so that
            // searchParams props, useSearchParams(), and navigation context
            // reflect the rewrite destination, not the original request.
            url.search = rewriteParsed.search;
            // Capture custom status code from rewrite (e.g. NextResponse.rewrite(url, { status: 403 }))
            if (mwResponse.status !== 200) {
              _mwCtx.status = mwResponse.status;
            }
            // Also save any other headers from the rewrite response
            _mwCtx.headers = new Headers();
            for (const [key, value] of mwResponse.headers) {
              if (key !== "x-middleware-next" && key !== "x-middleware-rewrite") {
                _mwCtx.headers.append(key, value);
              }
            }
          } else {
            // Middleware returned a custom response
            return mwResponse;
          }
        }
      }
    } catch (err) {
      console.error("[vinext] Middleware error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  }
  } // end of if (!__mwCtxApplied)

  // Unpack x-middleware-request-* headers into the request context so that
  // headers() returns the middleware-modified headers instead of the original
  // request headers. Strip ALL x-middleware-* headers from the set that will
  // be merged into the outgoing HTTP response — this prefix is reserved for
  // internal routing signals and must never reach clients.
  if (_mwCtx.headers) {
    applyMiddlewareRequestHeaders(_mwCtx.headers);
    processMiddlewareHeaders(_mwCtx.headers);
  }
  `
      : ""
  }

  // Build post-middleware request context for afterFiles/fallback rewrites.
  // These run after middleware in the App Router execution order and should
  // evaluate has/missing conditions against middleware-modified headers.
  // When no middleware is present, this falls back to requestContextFromRequest.
  const __postMwReqCtx = __buildPostMwRequestContext(request);

  // ── Apply beforeFiles rewrites from next.config.js ────────────────────
  // In App Router execution order, beforeFiles runs after middleware so that
  // has/missing conditions can evaluate against middleware-modified headers.
  if (__configRewrites.beforeFiles && __configRewrites.beforeFiles.length) {
    const __rewritten = matchRewrite(cleanPathname, __configRewrites.beforeFiles, __postMwReqCtx);
    if (__rewritten) {
      if (isExternalUrl(__rewritten)) {
        setHeadersContext(null);
        setNavigationContext(null);
        return proxyExternalRequest(request, __rewritten);
      }
      cleanPathname = __rewritten;
    }
  }

  // ── Image optimization passthrough (dev mode — no transformation) ───────
  if (cleanPathname === "/_vinext/image") {
    const __imgResult = validateImageUrl(url.searchParams.get("url"), request.url);
    if (__imgResult instanceof Response) return __imgResult;
    // In dev, redirect to the original asset URL so Vite's static serving handles it.
    return Response.redirect(new URL(__imgResult, url.origin).href, 302);
  }

  // Handle metadata routes (sitemap.xml, robots.txt, manifest.webmanifest, etc.)
  for (const metaRoute of metadataRoutes) {
    // generateSitemaps() support — paginated sitemaps at /{prefix}/sitemap/{id}.xml
    // When a sitemap module exports generateSitemaps, the base URL (e.g. /products/sitemap.xml)
    // is no longer served. Instead, individual sitemaps are served at /products/sitemap/{id}.xml.
    if (
      metaRoute.type === "sitemap" &&
      metaRoute.isDynamic &&
      typeof metaRoute.module.generateSitemaps === "function"
    ) {
      const sitemapPrefix = metaRoute.servedUrl.slice(0, -4); // strip ".xml"
      // Match exactly /{prefix}/{id}.xml — one segment only (no slashes in id)
      if (cleanPathname.startsWith(sitemapPrefix + "/") && cleanPathname.endsWith(".xml")) {
        const rawId = cleanPathname.slice(sitemapPrefix.length + 1, -4);
        if (rawId.includes("/")) continue; // multi-segment — not a paginated sitemap
        const sitemaps = await metaRoute.module.generateSitemaps();
        const matched = sitemaps.find(function(s) { return String(s.id) === rawId; });
        if (!matched) return new Response("Not Found", { status: 404 });
        // Pass the original typed id from generateSitemaps() so numeric IDs stay numeric.
        // TODO: wrap with makeThenableParams-style Promise when upgrading to Next.js 16
        // full-Promise param semantics (id becomes Promise<string> in v16).
        const result = await metaRoute.module.default({ id: matched.id });
        if (result instanceof Response) return result;
        return new Response(sitemapToXml(result), {
          headers: { "Content-Type": metaRoute.contentType },
        });
      }
      // Skip — the base servedUrl is not served when generateSitemaps exists
      continue;
    }
    // Match metadata route — use pattern matching for dynamic segments,
    // strict equality for static paths.
    var _metaParams = null;
    if (metaRoute.patternParts) {
      var _metaUrlParts = cleanPathname.split("/").filter(Boolean);
      _metaParams = matchPattern(_metaUrlParts, metaRoute.patternParts);
      if (!_metaParams) continue;
    } else if (cleanPathname !== metaRoute.servedUrl) {
      continue;
    }
    if (metaRoute.isDynamic) {
      // Dynamic metadata route — call the default export and serialize
      const metaFn = metaRoute.module.default;
      if (typeof metaFn === "function") {
        const result = await metaFn({ params: makeThenableParams(_metaParams || {}) });
        let body;
        // If it's already a Response (e.g., ImageResponse), return directly
        if (result instanceof Response) return result;
        // Serialize based on type
        if (metaRoute.type === "sitemap") body = sitemapToXml(result);
        else if (metaRoute.type === "robots") body = robotsToText(result);
        else if (metaRoute.type === "manifest") body = manifestToJson(result);
        else body = JSON.stringify(result);
        return new Response(body, {
          headers: { "Content-Type": metaRoute.contentType },
        });
      }
    } else {
      // Static metadata file — decode from embedded base64 data
      try {
        const binary = atob(metaRoute.fileDataBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Response(bytes, {
          headers: {
            "Content-Type": metaRoute.contentType,
            "Cache-Control": "public, max-age=0, must-revalidate",
          },
        });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    }
  }

  // Set navigation context for Server Components.
  // Note: Headers context is already set by runWithRequestContext in the handler wrapper.
  setNavigationContext({
    pathname: cleanPathname,
    searchParams: url.searchParams,
    params: {},
  });

  // Handle server action POST requests
  const actionId = request.headers.get("x-rsc-action");
  if (request.method === "POST" && actionId) {
    // ── CSRF protection ─────────────────────────────────────────────────
    // Verify that the Origin header matches the Host header to prevent
    // cross-site request forgery, matching Next.js server action behavior.
    const csrfResponse = validateCsrfOrigin(request, __allowedOrigins);
    if (csrfResponse) return csrfResponse;

    // ── Body size limit ─────────────────────────────────────────────────
    // Reject payloads larger than the configured limit.
    // Check Content-Length as a fast path, then enforce on the actual
    // stream to prevent bypasses via chunked transfer-encoding.
    const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
    if (contentLength > __MAX_ACTION_BODY_SIZE) {
      setHeadersContext(null);
      setNavigationContext(null);
      return new Response("Payload Too Large", { status: 413 });
    }

    try {
      const contentType = request.headers.get("content-type") || "";
      let body;
      try {
        body = contentType.startsWith("multipart/form-data")
          ? await __readFormDataWithLimit(request, __MAX_ACTION_BODY_SIZE)
          : await __readBodyWithLimit(request, __MAX_ACTION_BODY_SIZE);
      } catch (sizeErr) {
        if (sizeErr && sizeErr.message === "Request body too large") {
          setHeadersContext(null);
          setNavigationContext(null);
          return new Response("Payload Too Large", { status: 413 });
        }
        throw sizeErr;
      }
      const temporaryReferences = createTemporaryReferenceSet();
      const args = await decodeReply(body, { temporaryReferences });
      const action = await loadServerAction(actionId);
      let returnValue;
      let actionRedirect = null;
      const previousHeadersPhase = setHeadersAccessPhase("action");
      try {
        try {
          const data = await action.apply(null, args);
          returnValue = { ok: true, data };
        } catch (e) {
          // Detect redirect() / permanentRedirect() called inside the action.
          // These throw errors with digest "NEXT_REDIRECT;replace;url[;status]".
          // The URL is encodeURIComponent-encoded to prevent semicolons in the URL
          // from corrupting the delimiter-based digest format.
          if (e && typeof e === "object" && "digest" in e) {
            const digest = String(e.digest);
            if (digest.startsWith("NEXT_REDIRECT;")) {
              const parts = digest.split(";");
              actionRedirect = {
                url: decodeURIComponent(parts[2]),
                type: parts[1] || "replace",       // "push" or "replace"
                status: parts[3] ? parseInt(parts[3], 10) : 307,
              };
              returnValue = { ok: true, data: undefined };
            } else if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
              // notFound() / forbidden() / unauthorized() in action — package as error
              returnValue = { ok: false, data: e };
            } else {
              // Non-navigation digest error — sanitize in production to avoid
              // leaking internal details (connection strings, paths, etc.)
              console.error("[vinext] Server action error:", e);
              returnValue = { ok: false, data: __sanitizeErrorForClient(e) };
            }
          } else {
            // Unhandled error — sanitize in production to avoid leaking
            // internal details (database errors, file paths, stack traces, etc.)
            console.error("[vinext] Server action error:", e);
            returnValue = { ok: false, data: __sanitizeErrorForClient(e) };
          }
        }
      } finally {
        setHeadersAccessPhase(previousHeadersPhase);
      }

      // If the action called redirect(), signal the client to navigate.
      // We can't use a real HTTP redirect (the fetch would follow it automatically
      // and receive a page HTML instead of RSC stream). Instead, we return a 200
      // with x-action-redirect header that the client entry detects and handles.
      if (actionRedirect) {
        const actionPendingCookies = getAndClearPendingCookies();
        const actionDraftCookie = getDraftModeCookieHeader();
        setHeadersContext(null);
        setNavigationContext(null);
        const redirectHeaders = new Headers({
          "Content-Type": "text/x-component; charset=utf-8",
          "Vary": "RSC, Accept",
          "x-action-redirect": actionRedirect.url,
          "x-action-redirect-type": actionRedirect.type,
          "x-action-redirect-status": String(actionRedirect.status),
        });
        for (const cookie of actionPendingCookies) {
          redirectHeaders.append("Set-Cookie", cookie);
        }
        if (actionDraftCookie) redirectHeaders.append("Set-Cookie", actionDraftCookie);
        // Send an empty RSC-like body (client will navigate instead of parsing)
        return new Response("", { status: 200, headers: redirectHeaders });
      }

      // After the action, re-render the current page so the client
      // gets an updated React tree reflecting any mutations.
      const match = matchRoute(cleanPathname);
      let element;
      if (match) {
        const { route: actionRoute, params: actionParams } = match;
        setNavigationContext({
          pathname: cleanPathname,
          searchParams: url.searchParams,
          params: actionParams,
        });
        element = buildPageElement(actionRoute, actionParams, undefined, url.searchParams);
      } else {
        element = createElement("div", null, "Page not found");
      }

      const onRenderError = createRscOnErrorHandler(
        request,
        cleanPathname,
        match ? match.route.pattern : cleanPathname,
      );
      const rscStream = renderToReadableStream(
        { root: element, returnValue },
        { temporaryReferences, onError: onRenderError },
      );

      // Collect cookies set during the action synchronously (before stream is consumed).
      // Do NOT clear headers/navigation context here — the RSC stream is consumed lazily
      // by the client, and async server components that run during consumption need the
      // context to still be live. The AsyncLocalStorage scope from runWithRequestContext
      // handles cleanup naturally when all async continuations complete.
      const actionPendingCookies = getAndClearPendingCookies();
      const actionDraftCookie = getDraftModeCookieHeader();

      const actionHeaders = { "Content-Type": "text/x-component; charset=utf-8", "Vary": "RSC, Accept" };
      const actionResponse = new Response(rscStream, { headers: actionHeaders });
      if (actionPendingCookies.length > 0 || actionDraftCookie) {
        for (const cookie of actionPendingCookies) {
          actionResponse.headers.append("Set-Cookie", cookie);
        }
        if (actionDraftCookie) actionResponse.headers.append("Set-Cookie", actionDraftCookie);
      }
      return actionResponse;
    } catch (err) {
      getAndClearPendingCookies(); // Clear pending cookies on error
      console.error("[vinext] Server action error:", err);
      _reportRequestError(
        err instanceof Error ? err : new Error(String(err)),
        { path: cleanPathname, method: request.method, headers: Object.fromEntries(request.headers.entries()) },
        { routerKind: "App Router", routePath: cleanPathname, routeType: "action" },
      );
      setHeadersContext(null);
      setNavigationContext(null);
      return new Response(
        process.env.NODE_ENV === "production"
          ? "Internal Server Error"
          : "Server action failed: " + (err && err.message ? err.message : String(err)),
        { status: 500 },
      );
    }
  }

  // ── Apply afterFiles rewrites from next.config.js ──────────────────────
  if (__configRewrites.afterFiles && __configRewrites.afterFiles.length) {
    const __afterRewritten = matchRewrite(cleanPathname, __configRewrites.afterFiles, __postMwReqCtx);
    if (__afterRewritten) {
      if (isExternalUrl(__afterRewritten)) {
        setHeadersContext(null);
        setNavigationContext(null);
        return proxyExternalRequest(request, __afterRewritten);
      }
      cleanPathname = __afterRewritten;
    }
  }

  let match = matchRoute(cleanPathname);

  // ── Fallback rewrites from next.config.js (if no route matched) ───────
  if (!match && __configRewrites.fallback && __configRewrites.fallback.length) {
    const __fallbackRewritten = matchRewrite(cleanPathname, __configRewrites.fallback, __postMwReqCtx);
    if (__fallbackRewritten) {
      if (isExternalUrl(__fallbackRewritten)) {
        setHeadersContext(null);
        setNavigationContext(null);
        return proxyExternalRequest(request, __fallbackRewritten);
      }
      cleanPathname = __fallbackRewritten;
      match = matchRoute(cleanPathname);
    }
  }

  if (!match) {
    ${
      hasPagesDir
        ? `
    // ── Pages Router fallback ────────────────────────────────────────────
    // When a request doesn't match any App Router route, delegate to the
    // Pages Router handler (available in the SSR environment). This covers
    // both production request serving and prerender fetches from wrangler.
    // RSC requests (.rsc suffix or Accept: text/x-component) cannot be
    // handled by the Pages Router, so skip the delegation for those.
    if (!isRscRequest) {
      const __pagesEntry = await import.meta.viteRsc.loadModule("ssr", "index");
      if (typeof __pagesEntry.renderPage === "function") {
        const __pagesRes = await __pagesEntry.renderPage(request, decodeURIComponent(url.pathname) + (url.search || ""), {});
        // Only return the Pages Router response if it matched a route
        // (non-404). A 404 means the path isn't a Pages route either,
        // so fall through to the App Router not-found page below.
        if (__pagesRes.status !== 404) {
          setHeadersContext(null);
          setNavigationContext(null);
          return __pagesRes;
        }
      }
    }
    `
        : ""
    }
    // Render custom not-found page if available, otherwise plain 404
    const notFoundResponse = await renderNotFoundPage(null, isRscRequest, request);
    if (notFoundResponse) return notFoundResponse;
    setHeadersContext(null);
    setNavigationContext(null);
    return new Response("Not Found", { status: 404 });
  }

  const { route, params } = match;

  // Update navigation context with matched params
  setNavigationContext({
    pathname: cleanPathname,
    searchParams: url.searchParams,
    params,
  });

  // Handle route.ts API handlers
  if (route.routeHandler) {
    const handler = route.routeHandler;
    const method = request.method.toUpperCase();
    const revalidateSeconds = typeof handler.revalidate === "number" && handler.revalidate > 0 && handler.revalidate !== Infinity ? handler.revalidate : null;
    if (typeof handler["default"] === "function" && process.env.NODE_ENV === "development") {
      console.error(
        "[vinext] Detected default export in route handler " + route.pattern + ". Export a named export for each HTTP method instead.",
      );
    }

    // Collect exported HTTP methods for OPTIONS auto-response and Allow header
    const exportedMethods = collectRouteHandlerMethods(handler);
    const allowHeaderForOptions = buildRouteHandlerAllowHeader(exportedMethods);

    // Route handlers need the same middleware header/status merge behavior as
    // page responses. This keeps middleware response headers visible on API
    // routes in Workers/dev, and preserves custom rewrite status overrides.
    function attachRouteHandlerMiddlewareContext(response) {
      // _mwCtx.headers is only set (non-null) when middleware actually ran and
      // produced a continue/rewrite response. An empty Headers object (middleware
      // ran but produced no response headers) is a harmless edge case: the early
      // return is skipped, but the copy loop below is a no-op, so no incorrect
      // headers are added. The allocation cost in that case is acceptable.
      if (!_mwCtx.headers && _mwCtx.status == null) return response;
      const responseHeaders = new Headers(response.headers);
      if (_mwCtx.headers) {
        for (const [key, value] of _mwCtx.headers) {
          responseHeaders.append(key, value);
        }
      }
      return new Response(response.body, {
        status: _mwCtx.status ?? response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    // OPTIONS auto-implementation: respond with Allow header and 204
    if (method === "OPTIONS" && typeof handler["OPTIONS"] !== "function") {
      setHeadersContext(null);
      setNavigationContext(null);
      return attachRouteHandlerMiddlewareContext(new Response(null, {
        status: 204,
        headers: { "Allow": allowHeaderForOptions },
      }));
    }

    // HEAD auto-implementation: run GET handler and strip body
    let handlerFn = handler[method];
    let isAutoHead = false;
    if (method === "HEAD" && typeof handler["HEAD"] !== "function" && typeof handler["GET"] === "function") {
      handlerFn = handler["GET"];
      isAutoHead = true;
    }

    // ISR cache read for route handlers (production only).
    // Only GET/HEAD (auto-HEAD) with finite revalidate > 0 are ISR-eligible.
    // This runs before handler execution so a cache HIT skips the handler entirely.
    if (
      process.env.NODE_ENV === "production" &&
      revalidateSeconds !== null &&
      handler.dynamic !== "force-dynamic" &&
      (method === "GET" || isAutoHead) &&
      typeof handlerFn === "function"
    ) {
      const __routeKey = __isrRouteKey(cleanPathname);
      try {
        const __cached = await __isrGet(__routeKey);
        if (__cached && !__cached.isStale && __cached.value.value && __cached.value.value.kind === "APP_ROUTE") {
          // HIT — return cached response immediately
          const __cv = __cached.value.value;
          __isrDebug?.("HIT (route)", cleanPathname);
          setHeadersContext(null);
          setNavigationContext(null);
          const __hitHeaders = Object.assign({}, __cv.headers || {});
          __hitHeaders["X-Vinext-Cache"] = "HIT";
          __hitHeaders["Cache-Control"] = "s-maxage=" + revalidateSeconds + ", stale-while-revalidate";
          if (isAutoHead) {
            return attachRouteHandlerMiddlewareContext(new Response(null, { status: __cv.status, headers: __hitHeaders }));
          }
          return attachRouteHandlerMiddlewareContext(new Response(__cv.body, { status: __cv.status, headers: __hitHeaders }));
        }
        if (__cached && __cached.isStale && __cached.value.value && __cached.value.value.kind === "APP_ROUTE") {
          // STALE — serve stale response, trigger background regeneration
          const __sv = __cached.value.value;
          const __revalSecs = revalidateSeconds;
          const __revalHandlerFn = handlerFn;
          const __revalParams = params;
          const __revalUrl = request.url;
          const __revalSearchParams = new URLSearchParams(url.searchParams);
          __triggerBackgroundRegeneration(__routeKey, async function() {
            const __revalHeadCtx = { headers: new Headers(), cookies: new Map() };
            const __revalUCtx = _createUnifiedCtx({
              headersContext: __revalHeadCtx,
              executionContext: _getRequestExecutionContext(),
            });
            await _runWithUnifiedCtx(__revalUCtx, async () => {
              _ensureFetchPatch();
              setNavigationContext({ pathname: cleanPathname, searchParams: __revalSearchParams, params: __revalParams });
              const __syntheticReq = new Request(__revalUrl, { method: "GET" });
              const __revalResponse = await __revalHandlerFn(__syntheticReq, { params: __revalParams });
              const __regenDynamic = consumeDynamicUsage();
              setNavigationContext(null);
              if (__regenDynamic) {
                __isrDebug?.("route regen skipped (dynamic usage)", cleanPathname);
                return;
              }
              const __freshBody = await __revalResponse.arrayBuffer();
              const __freshHeaders = {};
              __revalResponse.headers.forEach(function(v, k) {
                if (k !== "x-vinext-cache" && k !== "cache-control") __freshHeaders[k] = v;
              });
              const __routeTags = __pageCacheTags(cleanPathname, getCollectedFetchTags());
              await __isrSet(__routeKey, { kind: "APP_ROUTE", body: __freshBody, status: __revalResponse.status, headers: __freshHeaders }, __revalSecs, __routeTags);
              __isrDebug?.("route regen complete", __routeKey);
            });
          });
          __isrDebug?.("STALE (route)", cleanPathname);
          setHeadersContext(null);
          setNavigationContext(null);
          const __staleHeaders = Object.assign({}, __sv.headers || {});
          __staleHeaders["X-Vinext-Cache"] = "STALE";
          __staleHeaders["Cache-Control"] = "s-maxage=0, stale-while-revalidate";
          if (isAutoHead) {
            return attachRouteHandlerMiddlewareContext(new Response(null, { status: __sv.status, headers: __staleHeaders }));
          }
          return attachRouteHandlerMiddlewareContext(new Response(__sv.body, { status: __sv.status, headers: __staleHeaders }));
        }
      } catch (__routeCacheErr) {
        // Cache read failure — fall through to normal handler execution
        console.error("[vinext] ISR route cache read error:", __routeCacheErr);
      }
    }

    if (typeof handlerFn === "function") {
      const previousHeadersPhase = setHeadersAccessPhase("route-handler");
      try {
        const response = await handlerFn(request, { params });
        const dynamicUsedInHandler = consumeDynamicUsage();
        const handlerSetCacheControl = response.headers.has("cache-control");

        // Apply Cache-Control from route segment config (export const revalidate = N).
        // Runtime request APIs like headers() / cookies() make GET handlers dynamic,
        // so only attach ISR headers when the handler stayed static.
        if (
          revalidateSeconds !== null &&
          !dynamicUsedInHandler &&
          (method === "GET" || isAutoHead) &&
          !handlerSetCacheControl
        ) {
          response.headers.set("cache-control", "s-maxage=" + revalidateSeconds + ", stale-while-revalidate");
        }

        // ISR cache write for route handlers (production, MISS).
        // Store the raw handler response before cookie/middleware transforms
        // (those are request-specific and shouldn't be cached).
        if (
          process.env.NODE_ENV === "production" &&
          revalidateSeconds !== null &&
          handler.dynamic !== "force-dynamic" &&
          !dynamicUsedInHandler &&
          (method === "GET" || isAutoHead) &&
          !handlerSetCacheControl
        ) {
          response.headers.set("X-Vinext-Cache", "MISS");
          const __routeClone = response.clone();
          const __routeKey = __isrRouteKey(cleanPathname);
          const __revalSecs = revalidateSeconds;
          const __routeTags = __pageCacheTags(cleanPathname, getCollectedFetchTags());
          const __routeWritePromise = (async () => {
            try {
              const __buf = await __routeClone.arrayBuffer();
              const __hdrs = {};
              __routeClone.headers.forEach(function(v, k) {
                if (k !== "x-vinext-cache" && k !== "cache-control") __hdrs[k] = v;
              });
              await __isrSet(__routeKey, { kind: "APP_ROUTE", body: __buf, status: __routeClone.status, headers: __hdrs }, __revalSecs, __routeTags);
              __isrDebug?.("route cache written", __routeKey);
            } catch (__cacheErr) {
              console.error("[vinext] ISR route cache write error:", __cacheErr);
            }
          })();
          _getRequestExecutionContext()?.waitUntil(__routeWritePromise);
        }

        // Collect any Set-Cookie headers from cookies().set()/delete() calls
        const pendingCookies = getAndClearPendingCookies();
        const draftCookie = getDraftModeCookieHeader();
        setHeadersContext(null);
        setNavigationContext(null);

        // If we have pending cookies, create a new response with them attached
        if (pendingCookies.length > 0 || draftCookie) {
          const newHeaders = new Headers(response.headers);
          for (const cookie of pendingCookies) {
            newHeaders.append("Set-Cookie", cookie);
          }
          if (draftCookie) newHeaders.append("Set-Cookie", draftCookie);

          if (isAutoHead) {
            return attachRouteHandlerMiddlewareContext(new Response(null, {
              status: response.status,
              statusText: response.statusText,
              headers: newHeaders,
            }));
          }
          return attachRouteHandlerMiddlewareContext(new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          }));
        }

        if (isAutoHead) {
          // Strip body for auto-HEAD, preserve headers and status
          return attachRouteHandlerMiddlewareContext(new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          }));
        }
        return attachRouteHandlerMiddlewareContext(response);
      } catch (err) {
        getAndClearPendingCookies(); // Clear any pending cookies on error
        // Catch redirect() / notFound() thrown from route handlers
        if (err && typeof err === "object" && "digest" in err) {
          const digest = String(err.digest);
          if (digest.startsWith("NEXT_REDIRECT;")) {
            const parts = digest.split(";");
            const redirectUrl = decodeURIComponent(parts[2]);
            const statusCode = parts[3] ? parseInt(parts[3], 10) : 307;
            setHeadersContext(null);
            setNavigationContext(null);
            return attachRouteHandlerMiddlewareContext(new Response(null, {
              status: statusCode,
              headers: { Location: new URL(redirectUrl, request.url).toString() },
            }));
          }
          if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
            const statusCode = digest === "NEXT_NOT_FOUND" ? 404 : parseInt(digest.split(";")[1], 10);
            setHeadersContext(null);
            setNavigationContext(null);
            return attachRouteHandlerMiddlewareContext(new Response(null, { status: statusCode }));
          }
        }
        setHeadersContext(null);
        setNavigationContext(null);
        console.error("[vinext] Route handler error:", err);
        _reportRequestError(
          err instanceof Error ? err : new Error(String(err)),
          { path: cleanPathname, method: request.method, headers: Object.fromEntries(request.headers.entries()) },
          { routerKind: "App Router", routePath: route.pattern, routeType: "route" },
        );
        return attachRouteHandlerMiddlewareContext(new Response(null, { status: 500 }));
      } finally {
        setHeadersAccessPhase(previousHeadersPhase);
      }
    }
    setHeadersContext(null);
    setNavigationContext(null);
    return attachRouteHandlerMiddlewareContext(new Response(null, {
      status: 405,
    }));
  }

  // Build the component tree: layouts wrapping the page
  const PageComponent = route.page?.default;
  if (!PageComponent) {
    setHeadersContext(null);
    setNavigationContext(null);
    return new Response("Page has no default export", { status: 500 });
  }

  // Read route segment config from page module exports
  let revalidateSeconds = typeof route.page?.revalidate === "number" ? route.page.revalidate : null;
  const dynamicConfig = route.page?.dynamic; // 'auto' | 'force-dynamic' | 'force-static' | 'error'
  const dynamicParamsConfig = route.page?.dynamicParams; // true (default) | false
  const isForceStatic = dynamicConfig === "force-static";
  const isDynamicError = dynamicConfig === "error";

  // force-static: replace headers/cookies context with empty values and
  // clear searchParams so dynamic APIs return defaults instead of real data
  if (isForceStatic) {
    setHeadersContext({ headers: new Headers(), cookies: new Map() });
    setNavigationContext({
      pathname: cleanPathname,
      searchParams: new URLSearchParams(),
      params,
    });
  }

  // dynamic = 'error': install an access error so request APIs fail with the
  // static-generation message even for legacy sync property access.
  if (isDynamicError) {
    const errorMsg = 'Page with \`dynamic = "error"\` used a dynamic API. ' +
      'This page was expected to be fully static, but headers(), cookies(), ' +
      'or searchParams was accessed. Remove the dynamic API usage or change ' +
      'the dynamic config to "auto" or "force-dynamic".';
    setHeadersContext({
      headers: new Headers(),
      cookies: new Map(),
      accessError: new Error(errorMsg),
    });
    setNavigationContext({
      pathname: cleanPathname,
      searchParams: new URLSearchParams(),
      params,
    });
  }

  // force-dynamic: set no-store Cache-Control
  const isForceDynamic = dynamicConfig === "force-dynamic";

  // ── ISR cache read (production only) ─────────────────────────────────────
  // Read from cache BEFORE generateStaticParams and all rendering work.
  // This is the critical performance optimization: on a cache hit we skip
  // ALL expensive work (generateStaticParams, buildPageElement, layout probe,
  // page probe, renderToReadableStream, SSR). Both HTML and RSC requests
  // (client-side navigation / prefetch) are served from cache.
  //
  // HTML and RSC are stored under separate keys (matching Next.js's .html/.rsc
  // file layout) so each request type reads and writes independently — no races,
  // no partial-entry sentinels, no read-before-write hacks needed.
  //
  // force-static and dynamic='error' are compatible with ISR — they control
  // how dynamic APIs behave during rendering, not whether results are cached.
  // Only force-dynamic truly bypasses the ISR cache.
  if (
    process.env.NODE_ENV === "production" &&
    !isForceDynamic &&
    revalidateSeconds !== null && revalidateSeconds > 0 && revalidateSeconds !== Infinity
  ) {
    const __isrKey = isRscRequest ? __isrRscKey(cleanPathname) : __isrHtmlKey(cleanPathname);
    try {
      const __cached = await __isrGet(__isrKey);
      if (__cached && !__cached.isStale && __cached.value.value && __cached.value.value.kind === "APP_PAGE") {
        const __cachedValue = __cached.value.value;
        const __hasRsc = !!__cachedValue.rscData;
        const __hasHtml = typeof __cachedValue.html === "string" && __cachedValue.html.length > 0;
        if (isRscRequest && __hasRsc) {
          __isrDebug?.("HIT (RSC)", cleanPathname);
          setHeadersContext(null);
          setNavigationContext(null);
          return new Response(__cachedValue.rscData, {
            status: __cachedValue.status || 200,
            headers: {
              "Content-Type": "text/x-component; charset=utf-8",
              "Cache-Control": "s-maxage=" + revalidateSeconds + ", stale-while-revalidate",
              "Vary": "RSC, Accept",
              "X-Vinext-Cache": "HIT",
            },
          });
        }
        if (!isRscRequest && __hasHtml) {
          __isrDebug?.("HIT (HTML)", cleanPathname);
          setHeadersContext(null);
          setNavigationContext(null);
          return new Response(__cachedValue.html, {
            status: __cachedValue.status || 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "s-maxage=" + revalidateSeconds + ", stale-while-revalidate",
              "Vary": "RSC, Accept",
              "X-Vinext-Cache": "HIT",
            },
          });
        }
        __isrDebug?.("MISS (empty cached entry)", cleanPathname);
      }
      if (__cached && __cached.isStale && __cached.value.value && __cached.value.value.kind === "APP_PAGE") {
        // Stale cache hit — serve stale immediately, trigger background regeneration.
        // Regen writes both keys independently so neither path blocks on the other.
        const __staleValue = __cached.value.value;
        const __staleStatus = __staleValue.status || 200;
        const __revalSecs = revalidateSeconds;
        __triggerBackgroundRegeneration(cleanPathname, async function() {
          // Re-render the page to produce fresh HTML + RSC data for the cache
          // Use an empty headers context for background regeneration — not the original
          // user request — to prevent user-specific cookies/auth headers from leaking
          // into content that is cached and served to all subsequent users.
          const __revalHeadCtx = { headers: new Headers(), cookies: new Map() };
          const __revalUCtx = _createUnifiedCtx({
            headersContext: __revalHeadCtx,
            executionContext: _getRequestExecutionContext(),
          });
          const __revalResult = await _runWithUnifiedCtx(__revalUCtx, async () => {
            _ensureFetchPatch();
            setNavigationContext({ pathname: cleanPathname, searchParams: new URLSearchParams(), params });
            const __revalElement = await buildPageElement(route, params, undefined, new URLSearchParams());
            const __revalOnError = createRscOnErrorHandler(request, cleanPathname, route.pattern);
            const __revalRscStream = renderToReadableStream(__revalElement, { onError: __revalOnError });
            // Tee RSC stream: one for SSR, one to capture rscData
            const [__revalRscForSsr, __revalRscForCapture] = __revalRscStream.tee();
            // Capture rscData bytes in parallel with SSR
            const __rscDataPromise = (async () => {
              const __rscReader = __revalRscForCapture.getReader();
              const __rscChunks = [];
              let __rscTotal = 0;
              for (;;) {
                const { done, value } = await __rscReader.read();
                if (done) break;
                __rscChunks.push(value);
                __rscTotal += value.byteLength;
              }
              const __rscBuf = new Uint8Array(__rscTotal);
              let __rscOff = 0;
              for (const c of __rscChunks) { __rscBuf.set(c, __rscOff); __rscOff += c.byteLength; }
              return __rscBuf.buffer;
            })();
            const __revalFontData = { links: _getSSRFontLinks(), styles: _getSSRFontStyles(), preloads: _getSSRFontPreloads() };
            const __revalSsrEntry = await import.meta.viteRsc.loadModule("ssr", "index");
            const __revalHtmlStream = await __revalSsrEntry.handleSsr(__revalRscForSsr, _getNavigationContext(), __revalFontData);
            setHeadersContext(null);
            setNavigationContext(null);
            // Collect the full HTML string from the stream
            const __revalReader = __revalHtmlStream.getReader();
            const __revalDecoder = new TextDecoder();
            const __revalChunks = [];
            for (;;) {
              const { done, value } = await __revalReader.read();
              if (done) break;
              __revalChunks.push(__revalDecoder.decode(value, { stream: true }));
            }
            __revalChunks.push(__revalDecoder.decode());
            const __freshHtml = __revalChunks.join("");
            const __freshRscData = await __rscDataPromise;
            const __pageTags = __pageCacheTags(cleanPathname, getCollectedFetchTags());
            return { html: __freshHtml, rscData: __freshRscData, tags: __pageTags };
          });
          // Write HTML and RSC to their own keys independently — no races
          await Promise.all([
            __isrSet(__isrHtmlKey(cleanPathname), { kind: "APP_PAGE", html: __revalResult.html, rscData: undefined, headers: undefined, postponed: undefined, status: 200 }, __revalSecs, __revalResult.tags),
            __isrSet(__isrRscKey(cleanPathname), { kind: "APP_PAGE", html: "", rscData: __revalResult.rscData, headers: undefined, postponed: undefined, status: 200 }, __revalSecs, __revalResult.tags),
          ]);
          __isrDebug?.("regen complete", cleanPathname);
        });
        if (isRscRequest && __staleValue.rscData) {
          __isrDebug?.("STALE (RSC)", cleanPathname);
          setHeadersContext(null);
          setNavigationContext(null);
          return new Response(__staleValue.rscData, {
            status: __staleStatus,
            headers: {
              "Content-Type": "text/x-component; charset=utf-8",
              "Cache-Control": "s-maxage=0, stale-while-revalidate",
              "Vary": "RSC, Accept",
              "X-Vinext-Cache": "STALE",
            },
          });
        }
        if (!isRscRequest && typeof __staleValue.html === "string" && __staleValue.html.length > 0) {
          __isrDebug?.("STALE (HTML)", cleanPathname);
          setHeadersContext(null);
          setNavigationContext(null);
          return new Response(__staleValue.html, {
            status: __staleStatus,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "s-maxage=0, stale-while-revalidate",
              "Vary": "RSC, Accept",
              "X-Vinext-Cache": "STALE",
            },
          });
        }
        // Stale entry exists but is empty for this request type — fall through to render
        __isrDebug?.("STALE MISS (empty stale entry)", cleanPathname);
      }
      if (!__cached) {
        __isrDebug?.("MISS (no cache entry)", cleanPathname);
      }
    } catch (__isrReadErr) {
      // Cache read failure — fall through to normal rendering
      console.error("[vinext] ISR cache read error:", __isrReadErr);
    }
  }

  // dynamicParams = false: only params from generateStaticParams are allowed.
  // This runs AFTER the ISR cache read so that a cache hit skips this work entirely.
  if (dynamicParamsConfig === false && route.isDynamic && typeof route.page?.generateStaticParams === "function") {
    try {
      // Pass parent params to generateStaticParams (Next.js top-down params passing).
      // Parent params = all matched params that DON'T belong to the leaf page's own dynamic segments.
      // We pass the full matched params; the function uses only what it needs.
      const staticParams = await route.page.generateStaticParams({ params });
      if (Array.isArray(staticParams)) {
        const paramKeys = Object.keys(params);
        const isAllowed = staticParams.some(sp =>
          paramKeys.every(key => {
            const val = params[key];
            const staticVal = sp[key];
            // Allow parent params to not be in the returned set (they're inherited)
            if (staticVal === undefined) return true;
            if (Array.isArray(val)) return JSON.stringify(val) === JSON.stringify(staticVal);
            return String(val) === String(staticVal);
          })
        );
        if (!isAllowed) {
          setHeadersContext(null);
          setNavigationContext(null);
          return new Response("Not Found", { status: 404 });
        }
      }
    } catch (err) {
      console.error("[vinext] generateStaticParams error:", err);
    }
  }

  // Check for intercepting routes on RSC requests (client-side navigation).
  // If the target URL matches an intercepting route in a parallel slot,
  // render the source route with the intercepting page in the slot.
  let interceptOpts = undefined;
  if (isRscRequest) {
    const intercept = findIntercept(cleanPathname);
    if (intercept) {
      const sourceRoute = routes[intercept.sourceRouteIndex];
      if (sourceRoute && sourceRoute !== route) {
        // Render the source route (e.g. /feed) with the intercepting page in the slot
        const sourceMatch = matchRoute(sourceRoute.pattern);
        const sourceParams = sourceMatch ? sourceMatch.params : {};
        setNavigationContext({
          pathname: cleanPathname,
          searchParams: url.searchParams,
          params: intercept.matchedParams,
        });
        const interceptElement = await buildPageElement(sourceRoute, sourceParams, {
          interceptSlot: intercept.slotName,
          interceptPage: intercept.page,
          interceptParams: intercept.matchedParams,
        }, url.searchParams);
        const interceptOnError = createRscOnErrorHandler(
          request,
          cleanPathname,
          sourceRoute.pattern,
        );
        const interceptStream = renderToReadableStream(interceptElement, { onError: interceptOnError });
        // Do NOT clear headers/navigation context here — the RSC stream is consumed lazily
        // by the client, and async server components that run during consumption need the
        // context to still be live. The AsyncLocalStorage scope from runWithRequestContext
        // handles cleanup naturally when all async continuations complete.
        return new Response(interceptStream, {
          headers: { "Content-Type": "text/x-component; charset=utf-8", "Vary": "RSC, Accept" },
        });
      }
      // If sourceRoute === route, apply intercept opts to the normal render
      interceptOpts = {
        interceptSlot: intercept.slotName,
        interceptPage: intercept.page,
        interceptParams: intercept.matchedParams,
      };
    }
  }

  let element;
  try {
    element = await buildPageElement(route, params, interceptOpts, url.searchParams);
  } catch (buildErr) {
    // Check for redirect/notFound/forbidden/unauthorized thrown during metadata resolution or async components
    if (buildErr && typeof buildErr === "object" && "digest" in buildErr) {
      const digest = String(buildErr.digest);
      if (digest.startsWith("NEXT_REDIRECT;")) {
        const parts = digest.split(";");
        const redirectUrl = decodeURIComponent(parts[2]);
        const statusCode = parts[3] ? parseInt(parts[3], 10) : 307;
        setHeadersContext(null);
        setNavigationContext(null);
        return Response.redirect(new URL(redirectUrl, request.url), statusCode);
      }
      if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
        const statusCode = digest === "NEXT_NOT_FOUND" ? 404 : parseInt(digest.split(";")[1], 10);
        const fallbackResp = await renderHTTPAccessFallbackPage(route, statusCode, isRscRequest, request, { matchedParams: params });
        if (fallbackResp) return fallbackResp;
        setHeadersContext(null);
        setNavigationContext(null);
        const statusText = statusCode === 403 ? "Forbidden" : statusCode === 401 ? "Unauthorized" : "Not Found";
        return new Response(statusText, { status: statusCode });
      }
    }
    // Non-special error (e.g. generateMetadata() threw) — render error.tsx if available
    const errorBoundaryResp = await renderErrorBoundaryPage(route, buildErr, isRscRequest, request, params);
    if (errorBoundaryResp) return errorBoundaryResp;
    throw buildErr;
  }

  // Note: CSS is automatically injected by @vitejs/plugin-rsc's
  // rscCssTransform — no manual loadCss() call needed.

  // Helper: check if an error is a redirect/notFound/forbidden/unauthorized thrown by the navigation shim
  async function handleRenderError(err) {
    if (err && typeof err === "object" && "digest" in err) {
      const digest = String(err.digest);
      if (digest.startsWith("NEXT_REDIRECT;")) {
        const parts = digest.split(";");
        const redirectUrl = decodeURIComponent(parts[2]);
        const statusCode = parts[3] ? parseInt(parts[3], 10) : 307;
        setHeadersContext(null);
        setNavigationContext(null);
        return Response.redirect(new URL(redirectUrl, request.url), statusCode);
      }
      if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
        const statusCode = digest === "NEXT_NOT_FOUND" ? 404 : parseInt(digest.split(";")[1], 10);
        const fallbackResp = await renderHTTPAccessFallbackPage(route, statusCode, isRscRequest, request, { matchedParams: params });
        if (fallbackResp) return fallbackResp;
        setHeadersContext(null);
        setNavigationContext(null);
        const statusText = statusCode === 403 ? "Forbidden" : statusCode === 401 ? "Unauthorized" : "Not Found";
        return new Response(statusText, { status: statusCode });
      }
    }
    return null;
  }

  // Pre-render layout components to catch notFound()/redirect() thrown from layouts.
  // In Next.js, each layout level has its own NotFoundBoundary. When a layout throws
  // notFound(), the parent layout's boundary catches it and renders the parent's
  // not-found.tsx. Since React Flight doesn't activate client error boundaries during
  // RSC rendering, we catch layout-level throws here and render the appropriate
  // fallback page with only the layouts above the throwing one.
  //
  // IMPORTANT: Layout pre-render runs BEFORE page pre-render. In Next.js, layouts
  // render before their children — if a layout throws notFound(), the page never
  // executes. By checking layouts first, we avoid a bug where the page's notFound()
  // triggers renderHTTPAccessFallbackPage with ALL route layouts, but one of those
  // layouts itself throws notFound() during the fallback rendering (causing a 500).
  if (route.layouts && route.layouts.length > 0) {
    const asyncParams = makeThenableParams(params);
    // Run inside ALS context so the module-level console.error patch suppresses
    // "Invalid hook call" only for this request's probe — concurrent requests
    // each have their own ALS store and are unaffected.
    const _layoutProbeResult = await _suppressHookWarningAls.run(true, async () => {
      for (let li = route.layouts.length - 1; li >= 0; li--) {
        const LayoutComp = route.layouts[li]?.default;
        if (!LayoutComp) continue;
        try {
          const lr = LayoutComp({ params: asyncParams, children: null });
          if (lr && typeof lr === "object" && typeof lr.then === "function") await lr;
        } catch (layoutErr) {
          if (layoutErr && typeof layoutErr === "object" && "digest" in layoutErr) {
            const digest = String(layoutErr.digest);
             if (digest.startsWith("NEXT_REDIRECT;")) {
               const parts = digest.split(";");
               const redirectUrl = decodeURIComponent(parts[2]);
               const statusCode = parts[3] ? parseInt(parts[3], 10) : 307;
               setHeadersContext(null);
               setNavigationContext(null);
               return Response.redirect(new URL(redirectUrl, request.url), statusCode);
            }
            if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
              const statusCode = digest === "NEXT_NOT_FOUND" ? 404 : parseInt(digest.split(";")[1], 10);
              // Find the not-found component from the parent level (the boundary that
              // would catch this in Next.js). Walk up from the throwing layout to find
              // the nearest not-found at a parent layout's directory.
              let parentNotFound = null;
              if (route.notFounds) {
                for (let pi = li - 1; pi >= 0; pi--) {
                  if (route.notFounds[pi]?.default) {
                    parentNotFound = route.notFounds[pi].default;
                    break;
                  }
                }
              }
              if (!parentNotFound) parentNotFound = ${rootNotFoundVar ? `${rootNotFoundVar}?.default` : "null"};
              // Wrap in only the layouts above the throwing one
              const parentLayouts = route.layouts.slice(0, li);
              const fallbackResp = await renderHTTPAccessFallbackPage(
                route, statusCode, isRscRequest, request,
                { boundaryComponent: parentNotFound, layouts: parentLayouts, matchedParams: params }
              );
              if (fallbackResp) return fallbackResp;
              setHeadersContext(null);
              setNavigationContext(null);
              const statusText = statusCode === 403 ? "Forbidden" : statusCode === 401 ? "Unauthorized" : "Not Found";
              return new Response(statusText, { status: statusCode });
            }
          }
          // Not a special error — let it propagate through normal RSC rendering
        }
      }
      return null;
    });
    if (_layoutProbeResult instanceof Response) return _layoutProbeResult;
  }

  // Pre-render the page component to catch redirect()/notFound() thrown synchronously.
  // Server Components are just functions — we can call PageComponent directly to detect
  // these special throws before starting the RSC stream.
  //
  // For routes with a loading.tsx Suspense boundary, we skip awaiting async components.
  // The Suspense boundary + rscOnError will handle redirect/notFound thrown during
  // streaming, and blocking here would defeat streaming (the slow component's delay
  // would be hit before the RSC stream even starts).
  //
  // Because this calls the component outside React's render cycle, hooks like use()
  // trigger "Invalid hook call" console.error in dev. The module-level ALS patch
  // suppresses the warning only within this request's execution context.
  const _hasLoadingBoundary = !!(route.loading && route.loading.default);
  const _pageProbeResult = await _suppressHookWarningAls.run(true, async () => {
    try {
      const testResult = PageComponent({ params });
      // If it's a promise (async component), only await if there's no loading boundary.
      // With a loading boundary, the Suspense streaming pipeline handles async resolution
      // and any redirect/notFound errors via rscOnError.
      if (testResult && typeof testResult === "object" && typeof testResult.then === "function") {
        if (!_hasLoadingBoundary) {
          await testResult;
        } else {
          // Suppress unhandled promise rejection — with a loading boundary,
          // redirect/notFound errors are handled by rscOnError during streaming.
          testResult.catch(() => {});
        }
      }
    } catch (preRenderErr) {
      const specialResponse = await handleRenderError(preRenderErr);
      if (specialResponse) return specialResponse;
      // Non-special errors from the pre-render test are expected (e.g. use() hook
      // fails outside React's render cycle, client references can't execute on server).
      // Only redirect/notFound/forbidden/unauthorized are actionable here — other
      // errors will be properly caught during actual RSC/SSR rendering below.
    }
    return null;
  });
  if (_pageProbeResult instanceof Response) return _pageProbeResult;

  // Mark end of compile phase: route matching, middleware, tree building are done.
  if (process.env.NODE_ENV !== "production") __compileEnd = performance.now();

  // Render to RSC stream.
  // Track non-navigation RSC errors so we can detect when the in-tree global
  // ErrorBoundary catches during SSR (producing double <html>/<body>) and
  // re-render with renderErrorBoundaryPage (which skips layouts for global-error).
  let _rscErrorForRerender = null;
  const _baseOnError = createRscOnErrorHandler(request, cleanPathname, route.pattern);
  const onRenderError = function(error, requestInfo, errorContext) {
    if (!(error && typeof error === "object" && "digest" in error)) {
      _rscErrorForRerender = error;
    }
    return _baseOnError(error, requestInfo, errorContext);
  };
  const rscStream = renderToReadableStream(element, { onError: onRenderError });

  // For ISR pages in production: tee the RSC stream immediately after creation so we
  // can capture rscData for BOTH RSC requests (client-side nav/prefetch) and HTML
  // requests. The tee must happen here — before the isRscRequest branch — so both
  // paths can use the captured bytes when writing to the ISR cache.
  //   __rscForResponse  → sent to the client (RSC response) or to SSR (HTML response)
  //   __isrRscDataPromise → resolves to ArrayBuffer of captured RSC wire bytes
  let __rscForResponse = rscStream;
  let __isrRscDataPromise = null;
  if (process.env.NODE_ENV === "production" && revalidateSeconds !== null && revalidateSeconds > 0 && revalidateSeconds !== Infinity && !isForceDynamic) {
    const [__rscA, __rscB] = rscStream.tee();
    __rscForResponse = __rscA;
    __isrRscDataPromise = (async () => {
      const __rscReader = __rscB.getReader();
      const __rscChunks = [];
      let __rscTotal = 0;
      for (;;) {
        const { done, value } = await __rscReader.read();
        if (done) break;
        __rscChunks.push(value);
        __rscTotal += value.byteLength;
      }
      const __rscBuf = new Uint8Array(__rscTotal);
      let __rscOff = 0;
      for (const c of __rscChunks) { __rscBuf.set(c, __rscOff); __rscOff += c.byteLength; }
      return __rscBuf.buffer;
    })();
  }

  if (isRscRequest) {
    // Direct RSC stream response (for client-side navigation)
    // NOTE: Do NOT clear headers/navigation context here!
    // The RSC stream is consumed lazily - components render when chunks are read.
    // If we clear context now, headers()/cookies() will fail during rendering.
    // Context will be cleared when the next request starts (via runWithRequestContext).
    const responseHeaders = { "Content-Type": "text/x-component; charset=utf-8", "Vary": "RSC, Accept" };
    // Include matched route params so the client can hydrate useParams()
    if (params && Object.keys(params).length > 0) {
      responseHeaders["X-Vinext-Params"] = JSON.stringify(params);
    }
    if (isForceDynamic) {
      responseHeaders["Cache-Control"] = "no-store, must-revalidate";
    } else if ((isForceStatic || isDynamicError) && !revalidateSeconds) {
      responseHeaders["Cache-Control"] = "s-maxage=31536000, stale-while-revalidate";
      responseHeaders["X-Vinext-Cache"] = "STATIC";
    } else if (revalidateSeconds === Infinity) {
      responseHeaders["Cache-Control"] = "s-maxage=31536000, stale-while-revalidate";
      responseHeaders["X-Vinext-Cache"] = "STATIC";
    } else if (revalidateSeconds) {
      responseHeaders["Cache-Control"] = "s-maxage=" + revalidateSeconds + ", stale-while-revalidate";
    }
    // Merge middleware response headers into the RSC response.
    // set-cookie and vary are accumulated to preserve existing values
    // (e.g. "Vary: RSC, Accept" set above); all other keys use plain
    // assignment so middleware headers win over config headers, which
    // the outer handler applies afterward and skips keys already present.
    if (_mwCtx.headers) {
      for (const [key, value] of _mwCtx.headers) {
        const lk = key.toLowerCase();
        if (lk === "set-cookie") {
          const existing = responseHeaders[lk];
          if (Array.isArray(existing)) {
            existing.push(value);
          } else if (existing) {
            responseHeaders[lk] = [existing, value];
          } else {
            responseHeaders[lk] = [value];
          }
        } else if (lk === "vary") {
          // Accumulate Vary values to preserve the existing "RSC, Accept" entry.
          const existing = responseHeaders["Vary"] ?? responseHeaders["vary"];
          if (existing) {
            responseHeaders["Vary"] = existing + ", " + value;
            if (responseHeaders["vary"] !== undefined) delete responseHeaders["vary"];
          } else {
            responseHeaders[key] = value;
          }
        } else {
          responseHeaders[key] = value;
        }
      }
    }
    // Attach internal timing header so the dev server middleware can log it.
    // Format: "handlerStart,compileMs,renderMs"
    //   handlerStart - absolute performance.now() when _handleRequest began,
    //                  used by the logging middleware to compute true compile
    //                  time as (handlerStart - middlewareReqStart).
    //   compileMs    - time inside the handler before renderToReadableStream.
    //                  -1 sentinel means compile time is not measured.
    //   renderMs     - -1 sentinel for RSC-only (soft-nav) responses, since
    //                  rendering is handled asynchronously by the client. The
    //                  logging middleware computes render time as totalMs - compileMs.
    if (process.env.NODE_ENV !== "production") {
      const handlerStart = Math.round(__reqStart);
      const compileMs = __compileEnd !== undefined ? Math.round(__compileEnd - __reqStart) : -1;
      responseHeaders["x-vinext-timing"] = handlerStart + "," + compileMs + ",-1";
    }
    // For ISR-eligible RSC requests in production: write rscData to its own key.
    // HTML is stored under a separate key (written by the HTML path below) so
    // these writes never race or clobber each other.
    if (process.env.NODE_ENV === "production" && __isrRscDataPromise) {
      responseHeaders["X-Vinext-Cache"] = "MISS";
      const __isrKeyRsc = __isrRscKey(cleanPathname);
      const __revalSecsRsc = revalidateSeconds;
      const __rscWritePromise = (async () => {
        try {
          const __rscDataForCache = await __isrRscDataPromise;
          const __pageTags = __pageCacheTags(cleanPathname, getCollectedFetchTags());
          await __isrSet(__isrKeyRsc, { kind: "APP_PAGE", html: "", rscData: __rscDataForCache, headers: undefined, postponed: undefined, status: 200 }, __revalSecsRsc, __pageTags);
          __isrDebug?.("RSC cache written", __isrKeyRsc);
        } catch (__rscWriteErr) {
          console.error("[vinext] ISR RSC cache write error:", __rscWriteErr);
        }
      })();
      _getRequestExecutionContext()?.waitUntil(__rscWritePromise);
    }
    return new Response(__rscForResponse, { status: _mwCtx.status || 200, headers: responseHeaders });
  }

  // Collect font data from RSC environment before passing to SSR
  // (Fonts are loaded during RSC rendering when layout.tsx calls Geist() etc.)
  const fontData = {
    links: _getSSRFontLinks(),
    styles: _getSSRFontStyles(),
    preloads: _getSSRFontPreloads(),
  };

  // Build HTTP Link header for font preloading.
  // This lets the browser (and CDN) start fetching font files before parsing HTML,
  // eliminating the CSS → woff2 download waterfall.
  const fontPreloads = fontData.preloads || [];
  const fontLinkHeaderParts = [];
  for (const preload of fontPreloads) {
    fontLinkHeaderParts.push("<" + preload.href + ">; rel=preload; as=font; type=" + preload.type + "; crossorigin");
  }
  const fontLinkHeader = fontLinkHeaderParts.length > 0 ? fontLinkHeaderParts.join(", ") : "";

  // __rscForResponse was already teed above (before isRscRequest) for ISR pages in
  // production. For non-ISR or dev, __rscForResponse === rscStream (no tee).
  // __isrRscDataPromise resolves to rscData bytes used by the RSC write path above;
  // the HTML write path below uses its own separate key and does not need rscData.

  // Delegate to SSR environment for HTML rendering
  let htmlStream;
  try {
    const ssrEntry = await import.meta.viteRsc.loadModule("ssr", "index");
    htmlStream = await ssrEntry.handleSsr(__rscForResponse, _getNavigationContext(), fontData);
    // Shell render complete; Suspense boundaries stream asynchronously
    if (process.env.NODE_ENV !== "production") __renderEnd = performance.now();
  } catch (ssrErr) {
    const specialResponse = await handleRenderError(ssrErr);
    if (specialResponse) return specialResponse;
    // Non-special error during SSR — render error.tsx if available
    const errorBoundaryResp = await renderErrorBoundaryPage(route, ssrErr, isRscRequest, request, params);
    if (errorBoundaryResp) return errorBoundaryResp;
    throw ssrErr;
  }

  // If an RSC error was caught by the in-tree global ErrorBoundary during SSR,
  // the HTML output has double <html>/<body> (root layout + global-error.tsx).
  // Discard it and re-render using renderErrorBoundaryPage which skips layouts
  // when the error falls through to global-error.tsx.
  ${
    globalErrorVar
      ? `
  if (_rscErrorForRerender && !isRscRequest) {
    const _hasLocalBoundary = !!(route?.error?.default) || !!(route?.errors && route.errors.some(function(e) { return e?.default; }));
    if (!_hasLocalBoundary) {
      const cleanResp = await renderErrorBoundaryPage(route, _rscErrorForRerender, false, request, params);
      if (cleanResp) return cleanResp;
    }
  }
  `
      : ""
  }

  // Check for draftMode Set-Cookie header (from draftMode().enable()/disable())
  const draftCookie = getDraftModeCookieHeader();

  setHeadersContext(null);
  setNavigationContext(null);

  // Helper to attach draftMode cookie, middleware headers, font Link header, and rewrite status to a response
  function attachMiddlewareContext(response) {
    if (draftCookie) {
      response.headers.append("Set-Cookie", draftCookie);
    }
    // Set HTTP Link header for font preloading
    if (fontLinkHeader) {
      response.headers.set("Link", fontLinkHeader);
    }
    // Merge middleware response headers into the final response.
    // The response is freshly constructed above (new Response(htmlStream, {...})),
    // so set() and append() are equivalent — there are no same-key conflicts yet.
    // Precedence over config headers is handled by the outer handler, which
    // skips config keys that middleware already placed on the response.
    if (_mwCtx.headers) {
      for (const [key, value] of _mwCtx.headers) {
        response.headers.append(key, value);
      }
    }
    // Attach internal timing header so the dev server middleware can log it.
    // Format: "handlerStart,compileMs,renderMs"
    //   handlerStart - absolute performance.now() when _handleRequest began,
    //                  used by the logging middleware to compute true compile
    //                  time as (handlerStart - middlewareReqStart).
    //   compileMs    - time inside the handler before renderToReadableStream.
    //   renderMs     - time from renderToReadableStream to handleSsr completion,
    //                  or -1 sentinel if not measured (falls back to totalMs - compileMs).
    if (process.env.NODE_ENV !== "production") {
      const handlerStart = Math.round(__reqStart);
      const compileMs = __compileEnd !== undefined ? Math.round(__compileEnd - __reqStart) : -1;
      const renderMs = __renderEnd !== undefined && __compileEnd !== undefined
        ? Math.round(__renderEnd - __compileEnd)
        : -1;
      response.headers.set("x-vinext-timing", handlerStart + "," + compileMs + "," + renderMs);
    }
    // Apply custom status code from middleware rewrite
    if (_mwCtx.status) {
      return new Response(response.body, {
        status: _mwCtx.status,
        headers: response.headers,
      });
    }
    return response;
  }

  // Check if any component called connection(), cookies(), headers(), or noStore()
  // during rendering. If so, treat as dynamic (skip ISR, set no-store).
  const dynamicUsedDuringRender = consumeDynamicUsage();

  // Check if cacheLife() was called during rendering (e.g., page with file-level "use cache").
  // If so, use its revalidation period for the Cache-Control header.
  const requestCacheLife = _consumeRequestScopedCacheLife();
  if (requestCacheLife && requestCacheLife.revalidate !== undefined && revalidateSeconds === null) {
    revalidateSeconds = requestCacheLife.revalidate;
  }

  // force-dynamic: always return no-store (highest priority)
  if (isForceDynamic) {
    return attachMiddlewareContext(new Response(htmlStream, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, must-revalidate",
        "Vary": "RSC, Accept",
      },
    }));
  }

  // force-static / error: treat as static regardless of dynamic usage.
  // force-static intentionally provides empty headers/cookies context so
  // dynamic APIs return safe defaults; we ignore the dynamic usage signal.
  // dynamic='error' should have already thrown via the request API accessError
  // trap if user code touched a dynamic API, so reaching here means rendering succeeded.
  if ((isForceStatic || isDynamicError) && (revalidateSeconds === null || revalidateSeconds === 0)) {
    return attachMiddlewareContext(new Response(htmlStream, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "s-maxage=31536000, stale-while-revalidate",
        "X-Vinext-Cache": "STATIC",
        "Vary": "RSC, Accept",
      },
    }));
  }

  // auto mode: dynamic API usage (headers(), cookies(), connection(), noStore(),
  // searchParams access) opts the page into dynamic rendering with no-store.
  if (dynamicUsedDuringRender) {
    return attachMiddlewareContext(new Response(htmlStream, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, must-revalidate",
        "Vary": "RSC, Accept",
      },
    }));
  }

  // Emit Cache-Control for ISR pages and write to ISR cache on MISS (production only).
  // revalidate=Infinity means "cache forever" (no periodic revalidation) — treated as
  // static here so we emit s-maxage=31536000 but skip ISR cache management.
  if (revalidateSeconds !== null && revalidateSeconds > 0 && revalidateSeconds !== Infinity) {
    // In production, tee the HTML response body to simultaneously stream to the
    // client and collect the full HTML string for the ISR cache. rscData was
    // already captured above by teeing the RSC stream before SSR.
    // In dev, skip the tee and the X-Vinext-Cache header — every request renders
    // fresh (no cache reads or writes in dev mode).
    if (process.env.NODE_ENV === "production") {
      const __isrResponseProd = attachMiddlewareContext(new Response(htmlStream, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "s-maxage=" + revalidateSeconds + ", stale-while-revalidate",
          "Vary": "RSC, Accept",
          "X-Vinext-Cache": "MISS",
        },
      }));
      if (__isrResponseProd.body) {
        const [__streamForClient, __streamForCache] = __isrResponseProd.body.tee();
        const __isrKey = __isrHtmlKey(cleanPathname);
        const __isrKeyRscFromHtml = __isrRscKey(cleanPathname);
        const __revalSecs = revalidateSeconds;
        const __capturedRscDataPromise = __isrRscDataPromise;
        const __cachePromise = (async () => {
          try {
            const __reader = __streamForCache.getReader();
            const __decoder = new TextDecoder();
            const __chunks = [];
            for (;;) {
              const { done, value } = await __reader.read();
              if (done) break;
              __chunks.push(__decoder.decode(value, { stream: true }));
            }
            __chunks.push(__decoder.decode());
            const __fullHtml = __chunks.join("");
            const __pageTags = __pageCacheTags(cleanPathname, getCollectedFetchTags());
            // Write HTML and RSC to their own keys independently.
            // RSC data was captured by the tee above (before isRscRequest branch)
            // so an initial browser visit (HTML request) also populates the RSC key,
            // ensuring the first client-side navigation after a direct visit is a
            // cache hit rather than a miss.
            const __writes = [
              __isrSet(__isrKey, { kind: "APP_PAGE", html: __fullHtml, rscData: undefined, headers: undefined, postponed: undefined, status: 200 }, __revalSecs, __pageTags),
            ];
            if (__capturedRscDataPromise) {
              __writes.push(
                __capturedRscDataPromise.then((__rscBuf) =>
                  __isrSet(__isrKeyRscFromHtml, { kind: "APP_PAGE", html: "", rscData: __rscBuf, headers: undefined, postponed: undefined, status: 200 }, __revalSecs, __pageTags)
                )
              );
            }
            await Promise.all(__writes);
            __isrDebug?.("HTML cache written", __isrKey);
          } catch (__cacheErr) {
            console.error("[vinext] ISR cache write error:", __cacheErr);
          }
        })();
        // Register with ExecutionContext (from ALS) so the Workers runtime keeps
        // the isolate alive until the cache write finishes, even after the response is sent.
        _getRequestExecutionContext()?.waitUntil(__cachePromise);
        return new Response(__streamForClient, { status: __isrResponseProd.status, headers: __isrResponseProd.headers });
      }
      return __isrResponseProd;
    }
    // Dev mode: return Cache-Control header but no X-Vinext-Cache (no cache read/write)
    return attachMiddlewareContext(new Response(htmlStream, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "s-maxage=" + revalidateSeconds + ", stale-while-revalidate",
        "Vary": "RSC, Accept",
      },
    }));
  }

  // revalidate=Infinity (or false, which Next.js normalises to false/0): treat as
  // permanent static — emit the longest safe s-maxage but skip ISR cache management.
  if (revalidateSeconds === Infinity) {
    return attachMiddlewareContext(new Response(htmlStream, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "s-maxage=31536000, stale-while-revalidate",
        "X-Vinext-Cache": "STATIC",
        "Vary": "RSC, Accept",
      },
    }));
  }

  return attachMiddlewareContext(new Response(htmlStream, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Vary": "RSC, Accept" },
  }));
}

if (import.meta.hot) {
  import.meta.hot.accept();
}
`;
}
