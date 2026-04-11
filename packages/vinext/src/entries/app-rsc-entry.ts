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
import { resolveEntryPath } from "./runtime-entry-module.js";
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
const configMatchersPath = resolveEntryPath("../config/config-matchers.js", import.meta.url);
const requestPipelinePath = resolveEntryPath("../server/request-pipeline.js", import.meta.url);
const middlewareRequestHeadersPath = resolveEntryPath(
  "../server/middleware-request-headers.js",
  import.meta.url,
);
const requestContextShimPath = resolveEntryPath("../shims/request-context.js", import.meta.url);
const normalizePathModulePath = resolveEntryPath("../server/normalize-path.js", import.meta.url);
const appRouteHandlerRuntimePath = resolveEntryPath(
  "../server/app-route-handler-runtime.js",
  import.meta.url,
);
const appRouteHandlerPolicyPath = resolveEntryPath(
  "../server/app-route-handler-policy.js",
  import.meta.url,
);
const appRouteHandlerExecutionPath = resolveEntryPath(
  "../server/app-route-handler-execution.js",
  import.meta.url,
);
const appRouteHandlerCachePath = resolveEntryPath(
  "../server/app-route-handler-cache.js",
  import.meta.url,
);
const appPageCachePath = resolveEntryPath("../server/app-page-cache.js", import.meta.url);
const appPageExecutionPath = resolveEntryPath("../server/app-page-execution.js", import.meta.url);
const appPageBoundaryRenderPath = resolveEntryPath(
  "../server/app-page-boundary-render.js",
  import.meta.url,
);
const appElementsPath = resolveEntryPath("../server/app-elements.js", import.meta.url);
const appPageRouteWiringPath = resolveEntryPath(
  "../server/app-page-route-wiring.js",
  import.meta.url,
);
const appPageRenderPath = resolveEntryPath("../server/app-page-render.js", import.meta.url);
const appPageResponsePath = resolveEntryPath("../server/app-page-response.js", import.meta.url);
const cspPath = resolveEntryPath("../server/csp.js", import.meta.url);
const appPageRequestPath = resolveEntryPath("../server/app-page-request.js", import.meta.url);
const appRouteHandlerResponsePath = resolveEntryPath(
  "../server/app-route-handler-response.js",
  import.meta.url,
);
const routeTriePath = resolveEntryPath("../routing/route-trie.js", import.meta.url);
const metadataRoutesPath = resolveEntryPath("../server/metadata-routes.js", import.meta.url);

/**
 * Resolved config options relevant to App Router request handling.
 * Passed from the Vite plugin where the full next.config.js is loaded.
 */
export type AppRouterConfig = {
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
  /** Exact public/ file routes, using normalized leading-slash pathnames. */
  publicFiles?: string[];
};

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
  const publicFiles = config?.publicFiles ?? [];
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
      const interceptEntries = slot.interceptingRoutes.map(
        (ir) => `        {
          convention: ${JSON.stringify(ir.convention)},
          targetPattern: ${JSON.stringify(ir.targetPattern)},
          page: ${getImportVar(ir.pagePath)},
          params: ${JSON.stringify(ir.params)},
        }`,
      );
      return `      ${JSON.stringify(slot.key)}: {
        name: ${JSON.stringify(slot.name)},
        page: ${slot.pagePath ? getImportVar(slot.pagePath) : "null"},
        default: ${slot.defaultPath ? getImportVar(slot.defaultPath) : "null"},
        layout: ${slot.layoutPath ? getImportVar(slot.layoutPath) : "null"},
        loading: ${slot.loadingPath ? getImportVar(slot.loadingPath) : "null"},
        error: ${slot.errorPath ? getImportVar(slot.errorPath) : "null"},
        layoutIndex: ${slot.layoutIndex},
        routeSegments: ${JSON.stringify(slot.routeSegments)},
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
    templateTreePositions: ${JSON.stringify(route.templateTreePositions)},
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
  renderToReadableStream as _renderToReadableStream,
  decodeReply,
  loadServerAction,
  createTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/rsc";
import { AsyncLocalStorage } from "node:async_hooks";

// React Flight emits HL hints with "stylesheet" for CSS, but the HTML spec
// requires "style" for <link rel="preload">. Fix at the source so every
// consumer (SSR embed, client-side navigation, server actions) gets clean data.
//
// Flight lines are newline-delimited, so we buffer partial lines across chunks
// to guarantee the regex never sees a split hint.
function renderToReadableStream(model, options) {
  const _hlFixRe = /(\\d*:HL\\[.*?),"stylesheet"(\\]|,)/g;
  const stream = _renderToReadableStream(model, options);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = "";
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      const text = carry + decoder.decode(chunk, { stream: true });
      const lastNl = text.lastIndexOf("\\n");
      if (lastNl === -1) {
        carry = text;
        return;
      }
      carry = text.slice(lastNl + 1);
      controller.enqueue(encoder.encode(text.slice(0, lastNl + 1).replace(_hlFixRe, '$1,"style"$2')));
    },
    flush(controller) {
      const text = carry + decoder.decode();
      if (text) controller.enqueue(encoder.encode(text.replace(_hlFixRe, '$1,"style"$2')));
    }
  }));
}
import { createElement } from "react";
import { setNavigationContext as _setNavigationContextOrig, getNavigationContext as _getNavigationContext } from "next/navigation";
import { setHeadersContext, headersContextFromRequest, getDraftModeCookieHeader, getAndClearPendingCookies, consumeDynamicUsage, markDynamicUsage, applyMiddlewareRequestHeaders, getHeadersContext, setHeadersAccessPhase } from "next/headers";
import { NextRequest, NextFetchEvent } from "next/server";
import { mergeMetadata, resolveModuleMetadata, mergeViewport, resolveModuleViewport } from "vinext/metadata";
${middlewarePath ? `import * as middlewareModule from ${JSON.stringify(middlewarePath.replace(/\\/g, "/"))};` : ""}
${instrumentationPath ? `import * as _instrumentation from ${JSON.stringify(instrumentationPath.replace(/\\/g, "/"))};` : ""}
${effectiveMetaRoutes.length > 0 ? `import { sitemapToXml, robotsToText, manifestToJson } from ${JSON.stringify(metadataRoutesPath)};` : ""}
import { requestContextFromRequest, normalizeHost, matchRedirect, matchRewrite, matchHeaders, isExternalUrl, proxyExternalRequest, sanitizeDestination } from ${JSON.stringify(configMatchersPath)};
import { decodePathParams as __decodePathParams } from ${JSON.stringify(normalizePathModulePath)};
import { buildRequestHeadersFromMiddlewareResponse as __buildRequestHeadersFromMiddlewareResponse } from ${JSON.stringify(middlewareRequestHeadersPath)};
import { validateCsrfOrigin, validateServerActionPayload, validateImageUrl, guardProtocolRelativeUrl, hasBasePath, stripBasePath, normalizeTrailingSlash, processMiddlewareHeaders } from ${JSON.stringify(requestPipelinePath)};
import {
  isKnownDynamicAppRoute as __isKnownDynamicAppRoute,
} from ${JSON.stringify(appRouteHandlerRuntimePath)};
import {
  getAppRouteHandlerRevalidateSeconds as __getAppRouteHandlerRevalidateSeconds,
  hasAppRouteHandlerDefaultExport as __hasAppRouteHandlerDefaultExport,
  resolveAppRouteHandlerMethod as __resolveAppRouteHandlerMethod,
  shouldReadAppRouteHandlerCache as __shouldReadAppRouteHandlerCache,
} from ${JSON.stringify(appRouteHandlerPolicyPath)};
import {
  executeAppRouteHandler as __executeAppRouteHandler,
} from ${JSON.stringify(appRouteHandlerExecutionPath)};
import { readAppRouteHandlerCacheResponse as __readAppRouteHandlerCacheResponse } from ${JSON.stringify(appRouteHandlerCachePath)};
import { readAppPageCacheResponse as __readAppPageCacheResponse } from ${JSON.stringify(appPageCachePath)};
import {
  buildAppPageFontLinkHeader as __buildAppPageFontLinkHeader,
  buildAppPageSpecialErrorResponse as __buildAppPageSpecialErrorResponse,
  readAppPageTextStream as __readAppPageTextStream,
  resolveAppPageSpecialError as __resolveAppPageSpecialError,
  teeAppPageRscStreamForCapture as __teeAppPageRscStreamForCapture,
} from ${JSON.stringify(appPageExecutionPath)};
import {
  renderAppPageErrorBoundary as __renderAppPageErrorBoundary,
  renderAppPageHttpAccessFallback as __renderAppPageHttpAccessFallback,
} from ${JSON.stringify(appPageBoundaryRenderPath)};
import {
  APP_INTERCEPTION_CONTEXT_KEY as __APP_INTERCEPTION_CONTEXT_KEY,
  createAppPayloadRouteId as __createAppPayloadRouteId,
} from ${JSON.stringify(appElementsPath)};
import {
  buildAppPageElements as __buildAppPageElements,
  createAppPageTreePath as __createAppPageTreePath,
  resolveAppPageChildSegments as __resolveAppPageChildSegments,
} from ${JSON.stringify(appPageRouteWiringPath)};
import {
  renderAppPageLifecycle as __renderAppPageLifecycle,
} from ${JSON.stringify(appPageRenderPath)};
import {
  mergeMiddlewareResponseHeaders as __mergeMiddlewareResponseHeaders,
} from ${JSON.stringify(appPageResponsePath)};
import { getScriptNonceFromHeaderSources as __getScriptNonceFromHeaderSources } from ${JSON.stringify(cspPath)};
import {
  buildAppPageElement as __buildAppPageElement,
  resolveAppPageIntercept as __resolveAppPageIntercept,
  validateAppPageDynamicParams as __validateAppPageDynamicParams,
} from ${JSON.stringify(appPageRequestPath)};
import {
  applyRouteHandlerMiddlewareContext as __applyRouteHandlerMiddlewareContext,
} from ${JSON.stringify(appRouteHandlerResponsePath)};
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
function __isrRscKey(pathname, mountedSlotsHeader) {
  if (!mountedSlotsHeader) return __isrCacheKey(pathname, "rsc");
  return __isrCacheKey(pathname, "rsc:" + __isrFnv1a64(mountedSlotsHeader));
}
function __normalizeMountedSlotsHeader(raw) {
  if (!raw) return null;
  const normalized = Array.from(
    new Set(
      raw
        .split(/\\s+/)
        .filter(Boolean),
    ),
  ).sort().join(" ");
  return normalized || null;
}
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
  if (__resolveAppPageSpecialError(error)) {
    return error;
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
async function renderHTTPAccessFallbackPage(route, statusCode, isRscRequest, request, opts, scriptNonce) {
  return __renderAppPageHttpAccessFallback({
    boundaryComponent: opts?.boundaryComponent ?? null,
    buildFontLinkHeader: __buildAppPageFontLinkHeader,
    clearRequestContext() {
      setHeadersContext(null);
      setNavigationContext(null);
    },
    createRscOnErrorHandler(pathname, routePath) {
      return createRscOnErrorHandler(request, pathname, routePath);
    },
    getFontLinks: _getSSRFontLinks,
    getFontPreloads: _getSSRFontPreloads,
    getFontStyles: _getSSRFontStyles,
    getNavigationContext: _getNavigationContext,
    globalErrorModule: ${globalErrorVar ? globalErrorVar : "null"},
    isRscRequest,
    layoutModules: opts?.layouts ?? null,
    loadSsrHandler() {
      return import.meta.viteRsc.loadModule("ssr", "index");
    },
    makeThenableParams,
    matchedParams: opts?.matchedParams ?? route?.params ?? {},
    requestUrl: request.url,
    resolveChildSegments: __resolveAppPageChildSegments,
    rootForbiddenModule: rootForbiddenModule,
    rootLayouts: rootLayouts,
    rootNotFoundModule: rootNotFoundModule,
    rootUnauthorizedModule: rootUnauthorizedModule,
    route,
    renderToReadableStream,
    scriptNonce,
    statusCode,
  });
}

/** Convenience: render a not-found page (404) */
async function renderNotFoundPage(route, isRscRequest, request, matchedParams, scriptNonce) {
  return renderHTTPAccessFallbackPage(route, 404, isRscRequest, request, { matchedParams }, scriptNonce);
}

/**
 * Render an error.tsx boundary page when a server component or generateMetadata() throws.
 * Returns null if no error boundary component is available for this route.
 *
 * Next.js returns HTTP 200 when error.tsx catches an error (the error is "handled"
 * by the boundary). This matches that behavior intentionally.
 */
async function renderErrorBoundaryPage(route, error, isRscRequest, request, matchedParams, scriptNonce) {
  return __renderAppPageErrorBoundary({
    buildFontLinkHeader: __buildAppPageFontLinkHeader,
    clearRequestContext() {
      setHeadersContext(null);
      setNavigationContext(null);
    },
    createRscOnErrorHandler(pathname, routePath) {
      return createRscOnErrorHandler(request, pathname, routePath);
    },
    error,
    getFontLinks: _getSSRFontLinks,
    getFontPreloads: _getSSRFontPreloads,
    getFontStyles: _getSSRFontStyles,
    getNavigationContext: _getNavigationContext,
    globalErrorModule: ${globalErrorVar ? globalErrorVar : "null"},
    isRscRequest,
    loadSsrHandler() {
      return import.meta.viteRsc.loadModule("ssr", "index");
    },
    makeThenableParams,
    matchedParams: matchedParams ?? route?.params ?? {},
    requestUrl: request.url,
    resolveChildSegments: __resolveAppPageChildSegments,
    rootLayouts: rootLayouts,
    route,
    renderToReadableStream,
    sanitizeErrorForClient: __sanitizeErrorForClient,
    scriptNonce,
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

function __createStaticFileSignal(pathname, _mwCtx) {
  const headers = new Headers({
    "x-vinext-static-file": encodeURIComponent(pathname),
  });
  if (_mwCtx.headers) {
    for (const [key, value] of _mwCtx.headers) {
      headers.append(key, value);
    }
  }
  return new Response(null, {
    status: _mwCtx.status ?? 200,
    headers,
  });
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
// Maps target URL patterns to { sourceRouteIndex, slotKey, interceptPage, params }.
const interceptLookup = [];
for (let ri = 0; ri < routes.length; ri++) {
  const r = routes[ri];
  if (!r.slots) continue;
  for (const [slotKey, slotMod] of Object.entries(r.slots)) {
    if (!slotMod.intercepts) continue;
    for (const intercept of slotMod.intercepts) {
      interceptLookup.push({
        sourceRouteIndex: ri,
        slotKey,
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

async function buildPageElements(route, params, routePath, opts, searchParams, isRscRequest, request) {
  const PageComponent = route.page?.default;
  if (!PageComponent) {
    const _interceptionContext = opts?.interceptionContext ?? null;
    const _noExportRouteId = __createAppPayloadRouteId(routePath, _interceptionContext);
    let _noExportRootLayout = null;
    if (route.layouts?.length > 0) {
      // Compute the root layout tree path for this error payload using the
      // canonical helper so it stays aligned with buildAppPageElements().
      const _tp = route.layoutTreePositions?.[0] ?? 0;
      _noExportRootLayout = __createAppPageTreePath(route.routeSegments, _tp);
    }
    return {
      [__APP_INTERCEPTION_CONTEXT_KEY]: _interceptionContext,
      __route: _noExportRouteId,
      __rootLayout: _noExportRootLayout,
      [_noExportRouteId]: createElement("div", null, "Page has no default export"),
    };
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

  // Convert URLSearchParams → plain object for page generateMetadata() and
  // pageProps.searchParams. Built before the layout loop so the page metadata
  // call (below) and pageProps can reference the same object.
  // NOTE: Layouts do NOT receive searchParams in generateMetadata() — only
  // pages do. This matches Next.js behavior (resolve-metadata.ts:777).
  const spObj = Object.create(null);
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

  // Build the route tree from the leaf page, then delegate the boundary/layout/
  // template/segment wiring to a typed runtime helper so the generated entry
  // stays thin and the wiring logic can be unit tested directly.
  const pageProps = { params: makeThenableParams(params) };
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
  const __mountedSlotsHeader = __normalizeMountedSlotsHeader(
    request?.headers?.get("x-vinext-mounted-slots"),
  );
  const mountedSlotIds = __mountedSlotsHeader
    ? new Set(__mountedSlotsHeader.split(" "))
    : null;

  return __buildAppPageElements({
    element: createElement(PageComponent, pageProps),
    globalErrorModule: ${globalErrorVar ? globalErrorVar : "null"},
    isRscRequest,
    mountedSlotIds,
    makeThenableParams,
    matchedParams: params,
    resolvedMetadata,
    resolvedViewport,
    interceptionContext: opts?.interceptionContext ?? null,
    routePath,
    rootNotFoundModule: ${rootNotFoundVar ? rootNotFoundVar : "null"},
    route,
    slotOverrides:
      opts && opts.interceptSlotKey && opts.interceptPage
        ? {
            [opts.interceptSlotKey]: {
              pageModule: opts.interceptPage,
              params: opts.interceptParams || params,
            },
          }
        : null,
  });
}

${middlewarePath ? generateMiddlewareMatcherCode("modern") : ""}

const __basePath = ${JSON.stringify(bp)};
const __trailingSlash = ${JSON.stringify(ts)};
const __i18nConfig = ${JSON.stringify(i18nConfig)};
const __configRedirects = ${JSON.stringify(redirects)};
const __configRewrites = ${JSON.stringify(rewrites)};
const __configHeaders = ${JSON.stringify(headers)};
const __publicFiles = new Set(${JSON.stringify(publicFiles)});
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
    const _mwCtx = { headers: null, requestHeaders: null, status: null };
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
  if (!hasBasePath(pathname, __basePath) && !pathname.startsWith("/__vinext/")) {
    return new Response("Not Found", { status: 404 });
  }
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
  const interceptionContextHeader = request.headers.get("X-Vinext-Interception-Context")?.replaceAll("\0", "") || null;
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
      const __mwNextConfig = (__basePath || __i18nConfig) ? { basePath: __basePath, i18n: __i18nConfig ?? undefined } : undefined;
      const nextRequest = mwRequest instanceof NextRequest ? mwRequest : new NextRequest(mwRequest, __mwNextConfig ? { nextConfig: __mwNextConfig } : undefined);
      const mwFetchEvent = new NextFetchEvent({ page: cleanPathname });
      let mwResponse;
      try {
        mwResponse = await middlewareFn(nextRequest, mwFetchEvent);
      } finally {
        const _mwWaitUntil = mwFetchEvent.drainWaitUntil();
        const _mwExecCtx = _getRequestExecutionContext();
        if (_mwExecCtx && typeof _mwExecCtx.waitUntil === "function") { _mwExecCtx.waitUntil(_mwWaitUntil); }
      }
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
    // Preserve the pre-strip header set so route handlers can reconstruct
    // a request object with middleware header overrides applied.
    _mwCtx.requestHeaders = new Headers(_mwCtx.headers);
    applyMiddlewareRequestHeaders(_mwCtx.headers);
    processMiddlewareHeaders(_mwCtx.headers);
  }
  `
      : ""
  }

  const _scriptNonce = __getScriptNonceFromHeaderSources(request.headers, _mwCtx.headers);

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

  // Serve public/ files as filesystem routes after middleware and before
  // afterFiles/fallback rewrites, matching Next.js routing semantics.
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    !pathname.endsWith(".rsc") &&
    __publicFiles.has(cleanPathname)
  ) {
    setHeadersContext(null);
    setNavigationContext(null);
    return __createStaticFileSignal(cleanPathname, _mwCtx);
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
      const payloadResponse = await validateServerActionPayload(body);
      if (payloadResponse) {
        setHeadersContext(null);
        setNavigationContext(null);
        return payloadResponse;
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
                type: parts[1] || "push",          // "push" or "replace"
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
        });
        __mergeMiddlewareResponseHeaders(redirectHeaders, _mwCtx.headers);
        redirectHeaders.set("x-action-redirect", actionRedirect.url);
        redirectHeaders.set("x-action-redirect-type", actionRedirect.type);
        redirectHeaders.set("x-action-redirect-status", String(actionRedirect.status));
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
        element = buildPageElements(
          actionRoute,
          actionParams,
          cleanPathname,
          undefined,
          url.searchParams,
          isRscRequest,
          request,
        );
      } else {
        const _actionRouteId = __createAppPayloadRouteId(cleanPathname, null);
        element = {
          [__APP_INTERCEPTION_CONTEXT_KEY]: null,
          __route: _actionRouteId,
          __rootLayout: null,
          [_actionRouteId]: createElement("div", null, "Page not found"),
        };
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

      const actionHeaders = new Headers({
        "Content-Type": "text/x-component; charset=utf-8",
        "Vary": "RSC, Accept",
      });
      __mergeMiddlewareResponseHeaders(actionHeaders, _mwCtx.headers);
      const actionResponse = new Response(rscStream, {
        status: _mwCtx.status ?? 200,
        headers: actionHeaders,
      });
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
        const __pagesRequestHeaders = _mwCtx.requestHeaders
          ? __buildRequestHeadersFromMiddlewareResponse(request.headers, _mwCtx.requestHeaders)
          : null;
        const __pagesRequest = __pagesRequestHeaders
          ? new Request(request.url, { method: request.method, headers: __pagesRequestHeaders })
          : request;
        // Use segment-wise decoding to preserve encoded path delimiters (%2F).
        // decodeURIComponent would turn /admin%2Fpanel into /admin/panel,
        // changing the path structure and bypassing middleware matchers.
        // Ported from Next.js: packages/next/src/server/lib/router-utils/decode-path-params.ts
        // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/router-utils/decode-path-params.ts
        const __pagesRes = await __pagesEntry.renderPage(
          __pagesRequest,
          __decodePathParams(url.pathname) + (url.search || ""),
          {},
          undefined,
          _mwCtx.requestHeaders,
        );
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
    const notFoundResponse = await renderNotFoundPage(null, isRscRequest, request, undefined, _scriptNonce);
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
    const revalidateSeconds = __getAppRouteHandlerRevalidateSeconds(handler);
    if (__hasAppRouteHandlerDefaultExport(handler) && process.env.NODE_ENV === "development") {
      console.error(
        "[vinext] Detected default export in route handler " + route.pattern + ". Export a named export for each HTTP method instead.",
      );
    }

    const {
      allowHeaderForOptions,
      handlerFn,
      isAutoHead,
      shouldAutoRespondToOptions,
    } = __resolveAppRouteHandlerMethod(handler, method);

    if (shouldAutoRespondToOptions) {
      setHeadersContext(null);
      setNavigationContext(null);
      return __applyRouteHandlerMiddlewareContext(
        new Response(null, {
          status: 204,
          headers: { "Allow": allowHeaderForOptions },
        }),
        _mwCtx,
      );
    }

    // ISR cache read for route handlers (production only).
    // Only GET/HEAD (auto-HEAD) with finite revalidate > 0 are ISR-eligible.
    // Known-dynamic handlers skip the read entirely so stale cache entries
    // from earlier requests do not replay once the process has learned they
    // access request-specific data.
    if (
      __shouldReadAppRouteHandlerCache({
        dynamicConfig: handler.dynamic,
        handlerFn,
        isAutoHead,
        isKnownDynamic: __isKnownDynamicAppRoute(route.pattern),
        isProduction: process.env.NODE_ENV === "production",
        method,
        revalidateSeconds,
      })
    ) {
      const __cachedRouteResponse = await __readAppRouteHandlerCacheResponse({
        basePath: __basePath,
        buildPageCacheTags: __pageCacheTags,
        cleanPathname,
        clearRequestContext: function() {
          setHeadersContext(null);
          setNavigationContext(null);
        },
        consumeDynamicUsage,
        getCollectedFetchTags,
        handlerFn,
        i18n: __i18nConfig,
        isAutoHead,
        isrDebug: __isrDebug,
        isrGet: __isrGet,
        isrRouteKey: __isrRouteKey,
        isrSet: __isrSet,
        markDynamicUsage,
        middlewareContext: _mwCtx,
        params,
        requestUrl: request.url,
        revalidateSearchParams: url.searchParams,
        revalidateSeconds,
        routePattern: route.pattern,
        runInRevalidationContext: async function(renderFn) {
          const __revalHeadCtx = { headers: new Headers(), cookies: new Map() };
          const __revalUCtx = _createUnifiedCtx({
            headersContext: __revalHeadCtx,
            executionContext: _getRequestExecutionContext(),
          });
          await _runWithUnifiedCtx(__revalUCtx, async () => {
            _ensureFetchPatch();
            await renderFn();
          });
        },
        scheduleBackgroundRegeneration: __triggerBackgroundRegeneration,
        setNavigationContext,
      });
      if (__cachedRouteResponse) {
        return __cachedRouteResponse;
      }
    }

    if (typeof handlerFn === "function") {
      return __executeAppRouteHandler({
        basePath: __basePath,
        buildPageCacheTags: __pageCacheTags,
        cleanPathname,
        clearRequestContext: function() {
          setHeadersContext(null);
          setNavigationContext(null);
        },
        consumeDynamicUsage,
        executionContext: _getRequestExecutionContext(),
        getAndClearPendingCookies,
        getCollectedFetchTags,
        getDraftModeCookieHeader,
        handler,
        handlerFn,
        i18n: __i18nConfig,
        isAutoHead,
        isProduction: process.env.NODE_ENV === "production",
        isrDebug: __isrDebug,
        isrRouteKey: __isrRouteKey,
        isrSet: __isrSet,
        markDynamicUsage,
        method,
        middlewareContext: _mwCtx,
        middlewareRequestHeaders: _mwCtx.requestHeaders,
        params: makeThenableParams(params),
        reportRequestError: _reportRequestError,
        request,
        revalidateSeconds,
        routePattern: route.pattern,
        setHeadersAccessPhase,
      });
    }
    setHeadersContext(null);
    setNavigationContext(null);
    return __applyRouteHandlerMiddlewareContext(
      new Response(null, {
        status: 405,
      }),
      _mwCtx,
    );
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
  const __mountedSlotsHeader = __normalizeMountedSlotsHeader(
    request.headers.get("x-vinext-mounted-slots"),
  );

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
    (isRscRequest || !_scriptNonce) &&
    revalidateSeconds !== null && revalidateSeconds > 0 && revalidateSeconds !== Infinity
  ) {
    const __cachedPageResponse = await __readAppPageCacheResponse({
      cleanPathname,
      clearRequestContext: function() {
        setHeadersContext(null);
        setNavigationContext(null);
      },
      isRscRequest,
      isrDebug: __isrDebug,
      isrGet: __isrGet,
      isrHtmlKey: __isrHtmlKey,
      isrRscKey: __isrRscKey,
      isrSet: __isrSet,
      mountedSlotsHeader: __mountedSlotsHeader,
      revalidateSeconds,
      renderFreshPageForCache: async function() {
        // Re-render the page to produce fresh HTML + RSC data for the cache
        // Use an empty headers context for background regeneration — not the original
        // user request — to prevent user-specific cookies/auth headers from leaking
        // into content that is cached and served to all subsequent users.
        const __revalHeadCtx = { headers: new Headers(), cookies: new Map() };
        const __revalUCtx = _createUnifiedCtx({
          headersContext: __revalHeadCtx,
          executionContext: _getRequestExecutionContext(),
        });
        return _runWithUnifiedCtx(__revalUCtx, async () => {
          _ensureFetchPatch();
          setNavigationContext({ pathname: cleanPathname, searchParams: new URLSearchParams(), params });
          // Slot context (X-Vinext-Mounted-Slots) is inherited from the
          // triggering request so the regen result is cached under the
          // correct slot-variant key.
          const __revalElement = await buildPageElements(
            route,
            params,
            cleanPathname,
            undefined,
            new URLSearchParams(),
            isRscRequest,
            request,
          );
          const __revalOnError = createRscOnErrorHandler(request, cleanPathname, route.pattern);
          const __revalRscStream = renderToReadableStream(__revalElement, { onError: __revalOnError });
          const __revalRscCapture = __teeAppPageRscStreamForCapture(__revalRscStream, true);
          const __revalFontData = { links: _getSSRFontLinks(), styles: _getSSRFontStyles(), preloads: _getSSRFontPreloads() };
          const __revalSsrEntry = await import.meta.viteRsc.loadModule("ssr", "index");
          const __revalHtmlStream = await __revalSsrEntry.handleSsr(
            __revalRscCapture.responseStream,
            _getNavigationContext(),
            __revalFontData,
          );
          setHeadersContext(null);
          setNavigationContext(null);
          const __freshHtml = await __readAppPageTextStream(__revalHtmlStream);
          const __freshRscData = await __revalRscCapture.capturedRscDataPromise;
          const __pageTags = __pageCacheTags(cleanPathname, getCollectedFetchTags());
          return { html: __freshHtml, rscData: __freshRscData, tags: __pageTags };
        });
      },
      scheduleBackgroundRegeneration: __triggerBackgroundRegeneration,
    });
    if (__cachedPageResponse) {
      return __cachedPageResponse;
    }
  }

  // dynamicParams = false: only params from generateStaticParams are allowed.
  // This runs AFTER the ISR cache read so that a cache hit skips this work entirely.
  const __dynamicParamsResponse = await __validateAppPageDynamicParams({
    clearRequestContext() {
      setHeadersContext(null);
      setNavigationContext(null);
    },
    enforceStaticParamsOnly: dynamicParamsConfig === false,
    generateStaticParams: route.page?.generateStaticParams,
    isDynamicRoute: route.isDynamic,
    logGenerateStaticParamsError(err) {
      console.error("[vinext] generateStaticParams error:", err);
    },
    params,
  });
  if (__dynamicParamsResponse) {
    return __dynamicParamsResponse;
  }

  // Check for intercepting routes on RSC requests (client-side navigation).
  // If the target URL matches an intercepting route in a parallel slot,
  // render the source route with the intercepting page in the slot.
  const __interceptResult = await __resolveAppPageIntercept({
    buildPageElement(interceptRoute, interceptParams, interceptOpts, interceptSearchParams) {
      return buildPageElements(
        interceptRoute,
        interceptParams,
        cleanPathname,
        interceptOpts,
        interceptSearchParams,
        isRscRequest,
        request,
      );
    },
    cleanPathname,
    currentRoute: route,
    findIntercept,
    getRouteParamNames(sourceRoute) {
      return sourceRoute.params;
    },
    getSourceRoute(sourceRouteIndex) {
      return routes[sourceRouteIndex];
    },
    isRscRequest,
    renderInterceptResponse(sourceRoute, interceptElement) {
      const interceptOnError = createRscOnErrorHandler(
        request,
        cleanPathname,
        sourceRoute.pattern,
      );
      const interceptStream = renderToReadableStream(interceptElement, {
        onError: interceptOnError,
      });
      // Do NOT clear headers/navigation context here — the RSC stream is consumed lazily
      // by the client, and async server components that run during consumption need the
      // context to still be live. The AsyncLocalStorage scope from runWithRequestContext
      // handles cleanup naturally when all async continuations complete.
      const interceptHeaders = new Headers({
        "Content-Type": "text/x-component; charset=utf-8",
        "Vary": "RSC, Accept",
      });
      __mergeMiddlewareResponseHeaders(interceptHeaders, _mwCtx.headers);
      return new Response(interceptStream, {
        status: _mwCtx.status ?? 200,
        headers: interceptHeaders,
      });
    },
    searchParams: url.searchParams,
    setNavigationContext,
    toInterceptOpts(intercept) {
      return {
        interceptionContext: interceptionContextHeader,
        interceptSlotKey: intercept.slotKey,
        interceptPage: intercept.page,
        interceptParams: intercept.matchedParams,
      };
    },
  });
  if (__interceptResult.response) {
    return __interceptResult.response;
  }
  const interceptOpts = __interceptResult.interceptOpts;

  const __pageBuildResult = await __buildAppPageElement({
    buildPageElement() {
      return buildPageElements(route, params, cleanPathname, interceptOpts, url.searchParams, isRscRequest, request);
    },
    renderErrorBoundaryPage(buildErr) {
      return renderErrorBoundaryPage(route, buildErr, isRscRequest, request, params, _scriptNonce);
    },
    renderSpecialError(__buildSpecialError) {
      return __buildAppPageSpecialErrorResponse({
        clearRequestContext() {
          setHeadersContext(null);
          setNavigationContext(null);
        },
        renderFallbackPage(statusCode) {
          return renderHTTPAccessFallbackPage(
            route,
            statusCode,
            isRscRequest,
            request,
            {
              matchedParams: params,
            },
            _scriptNonce,
          );
        },
        requestUrl: request.url,
        specialError: __buildSpecialError,
      });
    },
    resolveSpecialError: __resolveAppPageSpecialError,
  });
  if (__pageBuildResult.response) {
    return __pageBuildResult.response;
  }
  const element = __pageBuildResult.element;

  // Note: CSS is automatically injected by @vitejs/plugin-rsc's
  // rscCssTransform — no manual loadCss() call needed.
  const _hasLoadingBoundary = !!(route.loading && route.loading.default);
  const _asyncLayoutParams = makeThenableParams(params);
  return __renderAppPageLifecycle({
    cleanPathname,
    clearRequestContext() {
      setHeadersContext(null);
      setNavigationContext(null);
    },
    consumeDynamicUsage,
    createRscOnErrorHandler(pathname, routePath) {
      return createRscOnErrorHandler(request, pathname, routePath);
    },
    element,
    getDraftModeCookieHeader,
    getFontLinks: _getSSRFontLinks,
    getFontPreloads: _getSSRFontPreloads,
    getFontStyles: _getSSRFontStyles,
    getNavigationContext: _getNavigationContext,
    getPageTags() {
      return __pageCacheTags(cleanPathname, getCollectedFetchTags());
    },
    getRequestCacheLife() {
      return _consumeRequestScopedCacheLife();
    },
    handlerStart: __reqStart,
    hasLoadingBoundary: _hasLoadingBoundary,
    isDynamicError,
    isForceDynamic,
    isForceStatic,
    isProduction: process.env.NODE_ENV === "production",
    isRscRequest,
    isrDebug: __isrDebug,
    isrHtmlKey: __isrHtmlKey,
    isrRscKey: __isrRscKey,
    isrSet: __isrSet,
    layoutCount: route.layouts?.length ?? 0,
    loadSsrHandler() {
      return import.meta.viteRsc.loadModule("ssr", "index");
    },
    middlewareContext: _mwCtx,
    params,
    probeLayoutAt(li) {
      const LayoutComp = route.layouts[li]?.default;
      if (!LayoutComp) return null;
      return LayoutComp({ params: _asyncLayoutParams, children: null });
    },
    probePage() {
      const _probeSearchObj = {};
      url.searchParams.forEach(function(v, k) {
        if (k in _probeSearchObj) {
          _probeSearchObj[k] = Array.isArray(_probeSearchObj[k])
            ? _probeSearchObj[k].concat(v)
            : [_probeSearchObj[k], v];
        } else {
          _probeSearchObj[k] = v;
        }
      });
      const _asyncSearchParams = makeThenableParams(_probeSearchObj);
      return PageComponent({ params: _asyncLayoutParams, searchParams: _asyncSearchParams });
    },
    revalidateSeconds,
    mountedSlotsHeader: __mountedSlotsHeader,
    renderErrorBoundaryResponse(renderErr) {
      return renderErrorBoundaryPage(route, renderErr, isRscRequest, request, params, _scriptNonce);
    },
    async renderLayoutSpecialError(__layoutSpecialError, li) {
      return __buildAppPageSpecialErrorResponse({
        clearRequestContext() {
          setHeadersContext(null);
          setNavigationContext(null);
        },
        renderFallbackPage(statusCode) {
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
          const parentLayouts = route.layouts.slice(0, li);
          return renderHTTPAccessFallbackPage(
            route,
            statusCode,
            isRscRequest,
            request,
            {
              boundaryComponent: parentNotFound,
              layouts: parentLayouts,
              matchedParams: params,
            },
            _scriptNonce,
          );
        },
        requestUrl: request.url,
        specialError: __layoutSpecialError,
      });
    },
    async renderPageSpecialError(specialError) {
      return __buildAppPageSpecialErrorResponse({
        clearRequestContext() {
          setHeadersContext(null);
          setNavigationContext(null);
        },
        renderFallbackPage(statusCode) {
          return renderHTTPAccessFallbackPage(
            route,
            statusCode,
            isRscRequest,
            request,
            {
              matchedParams: params,
            },
            _scriptNonce,
          );
        },
        requestUrl: request.url,
        specialError,
      });
    },
    renderToReadableStream,
    routeHasLocalBoundary: !!(route?.error?.default) || !!(route?.errors && route.errors.some(function(e) { return e?.default; })),
    routePattern: route.pattern,
    runWithSuppressedHookWarning(probe) {
      // Run inside ALS context so the module-level console.error patch suppresses
      // "Invalid hook call" only for this request's probe — concurrent requests
      // each have their own ALS store and are unaffected.
      return _suppressHookWarningAls.run(true, probe);
    },
    scriptNonce: _scriptNonce,
    waitUntil(__cachePromise) {
      _getRequestExecutionContext()?.waitUntil(__cachePromise);
    },
  });
}

if (import.meta.hot) {
  import.meta.hot.accept();
}
`;
}
