/**
 * App Router dev server handler.
 *
 * This module generates virtual entry points for the RSC/SSR/browser
 * environments that @vitejs/plugin-rsc manages. The RSC entry does
 * route matching and renders the component tree, then delegates to
 * the SSR entry for HTML generation.
 */
import fs from "node:fs";
import type { AppRoute } from "../routing/app-router.js";
import type { MetadataFileRoute } from "./metadata-routes.js";
import type { NextRedirect, NextRewrite, NextHeader } from "../config/next-config.js";

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
): string {
  const bp = basePath ?? "";
  const ts = trailingSlash ?? false;
  const redirects = config?.redirects ?? [];
  const rewrites = config?.rewrites ?? { beforeFiles: [], afterFiles: [], fallback: [] };
  const headers = config?.headers ?? [];
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
    if (route.notFoundPath) getImportVar(route.notFoundPath);
    for (const nfp of route.notFoundPaths || []) { if (nfp) getImportVar(nfp); }
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
    const notFoundVars = (route.notFoundPaths || []).map((nf) => nf ? getImportVar(nf) : "null");
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
    return `  {
    pattern: ${JSON.stringify(route.pattern)},
    isDynamic: ${route.isDynamic},
    params: ${JSON.stringify(route.params)},
    page: ${route.pagePath ? getImportVar(route.pagePath) : "null"},
    routeHandler: ${route.routePath ? getImportVar(route.routePath) : "null"},
    layouts: [${layoutVars.join(", ")}],
    layoutSegmentDepths: ${JSON.stringify(route.layoutSegmentDepths)},
    templates: [${templateVars.join(", ")}],
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
  const rootNotFoundVar = rootRoute?.notFoundPath
    ? getImportVar(rootRoute.notFoundPath)
    : null;
  const rootForbiddenVar = rootRoute?.forbiddenPath
    ? getImportVar(rootRoute.forbiddenPath)
    : null;
  const rootUnauthorizedVar = rootRoute?.unauthorizedPath
    ? getImportVar(rootRoute.unauthorizedPath)
    : null;
  const rootLayoutVars = rootRoute
    ? rootRoute.layouts.map((l) => getImportVar(l))
    : [];

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
  const metaRouteEntries = effectiveMetaRoutes.map((mr) => {
    if (mr.isDynamic) {
      return `  {
    type: ${JSON.stringify(mr.type)},
    isDynamic: true,
    servedUrl: ${JSON.stringify(mr.servedUrl)},
    contentType: ${JSON.stringify(mr.contentType)},
    module: ${getImportVar(mr.filePath)},
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
import { createElement, Suspense, Fragment } from "react";
import { setNavigationContext as _setNavigationContextOrig, getNavigationContext as _getNavigationContext } from "next/navigation";
import { setHeadersContext, headersContextFromRequest, getDraftModeCookieHeader, getAndClearPendingCookies, consumeDynamicUsage, markDynamicUsage, runWithHeadersContext, applyMiddlewareRequestHeaders } from "next/headers";
import { NextRequest } from "next/server";
import { ErrorBoundary, NotFoundBoundary } from "vinext/error-boundary";
import { LayoutSegmentProvider } from "vinext/layout-segment-context";
import { MetadataHead, mergeMetadata, resolveModuleMetadata, ViewportHead, mergeViewport, resolveModuleViewport } from "vinext/metadata";
${middlewarePath ? `import * as middlewareModule from ${JSON.stringify(middlewarePath.replace(/\\/g, "/"))};` : ""}
${effectiveMetaRoutes.length > 0 ? `import { sitemapToXml, robotsToText, manifestToJson } from ${JSON.stringify(new URL("./metadata-routes.js", import.meta.url).pathname.replace(/\\/g, "/"))};` : ""}
import { getCacheHandler, _consumeRequestScopedCacheLife, _initRequestScopedCacheState } from "next/cache";
import { runWithFetchCache, getCollectedFetchTags } from "vinext/fetch-cache";
import { clearPrivateCache as _clearPrivateCache } from "vinext/cache-runtime";
// Import server-only state module to register ALS-backed accessors.
import "vinext/navigation-state";
import { reportRequestError as _reportRequestError } from "vinext/instrumentation";
import { getSSRFontLinks as _getSSRFontLinks, getSSRFontStyles as _getSSRFontStylesGoogle } from "next/font/google";
import { getSSRFontStyles as _getSSRFontStylesLocal } from "next/font/local";
function _getSSRFontStyles() { return [..._getSSRFontStylesGoogle(), ..._getSSRFontStylesLocal()]; }

// Set navigation context in the ALS-backed store. "use client" components
// rendered during SSR need the pathname/searchParams/params but the SSR
// environment has a separate module instance of next/navigation.
// Use _getNavigationContext() to read the current context — never cache
// it in a module-level variable (that would leak between concurrent requests).
function setNavigationContext(ctx) {
  _setNavigationContextOrig(ctx);
}

// ISR cache helpers
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
const isrPendingRegens = new Map();
// Track routes that have "use cache" with cacheLife() — maps ISR cache key to revalidate seconds.
// Populated on the first render when cacheLife() is called, used on subsequent requests to
// check the ISR cache even when the page doesn't have export const revalidate.
const _cacheLifeRouteMap = new Map();
function isrTriggerRegen(key, renderFn) {
  if (isrPendingRegens.has(key)) return;
  const promise = renderFn()
    .catch((err) => console.error("[vinext] ISR regen failed for " + key + ":", err))
    .finally(() => isrPendingRegens.delete(key));
  isrPendingRegens.set(key, promise);
}

// onError callback for renderToReadableStream — preserves the digest for
// Next.js navigation errors (redirect, notFound, forbidden, unauthorized)
// thrown during RSC streaming (e.g. inside Suspense boundaries).
// Without this, React's default onError returns undefined, the digest is lost,
// and client-side error boundaries can't identify the error type.
function rscOnError(error) {
  if (error && typeof error === "object" && "digest" in error) {
    return String(error.digest);
  }
  return undefined;
}

${imports.join("\n")}

const routes = [
${routeEntries.join(",\n")}
];

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
  const metadataList = [];
  const viewportList = [];
  for (const layoutMod of layouts) {
    if (layoutMod) {
      const meta = await resolveModuleMetadata(layoutMod);
      if (meta) metadataList.push(meta);
      const vp = await resolveModuleViewport(layoutMod);
      if (vp) viewportList.push(vp);
    }
  }
  const resolvedMetadata = metadataList.length > 0 ? mergeMetadata(metadataList) : null;
  const resolvedViewport = viewportList.length > 0 ? mergeViewport(viewportList) : null;

  // Build element: metadata head + noindex meta + boundary component wrapped in layouts
  const noindexMeta = createElement("meta", { name: "robots", content: "noindex" });
  const headElements = [noindexMeta];
  if (resolvedMetadata) headElements.push(createElement(MetadataHead, { metadata: resolvedMetadata }));
  if (resolvedViewport) headElements.push(createElement(ViewportHead, { viewport: resolvedViewport }));
  let element = createElement(Fragment, null, ...headElements, createElement(BoundaryComponent));
  for (let i = layouts.length - 1; i >= 0; i--) {
    const LayoutComponent = layouts[i]?.default;
    if (LayoutComponent) {
      element = createElement(LayoutComponent, { children: element });
    }
  }
  const rscStream = renderToReadableStream(element, { onError: rscOnError });
  if (isRscRequest) {
    setHeadersContext(null);
    setNavigationContext(null);
    return new Response(rscStream, {
      status: statusCode,
      headers: { "Content-Type": "text/x-component; charset=utf-8" },
    });
  }
  // Collect font data from RSC environment
  const fontData = {
    links: _getSSRFontLinks(),
    styles: _getSSRFontStyles(),
  };
  const ssrEntry = await import.meta.viteRsc.loadModule("ssr", "index");
  const htmlStream = await ssrEntry.handleSsr(rscStream, _getNavigationContext(), fontData);
  setHeadersContext(null);
  setNavigationContext(null);
  return new Response(htmlStream, {
    status: statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Convenience: render a not-found page (404) */
async function renderNotFoundPage(route, isRscRequest, request) {
  return renderHTTPAccessFallbackPage(route, 404, isRscRequest, request);
}

/**
 * Render an error.tsx boundary page when a server component or generateMetadata() throws.
 * Returns null if no error boundary component is available for this route.
 *
 * Next.js returns HTTP 200 when error.tsx catches an error (the error is "handled"
 * by the boundary). This matches that behavior intentionally.
 */
async function renderErrorBoundaryPage(route, error, isRscRequest, request) {
  // Resolve the error boundary component: route-level error.tsx first, then global-error.tsx
  const ErrorComponent = route?.error?.default${globalErrorVar ? ` ?? ${globalErrorVar}?.default` : ""};
  if (!ErrorComponent) return null;

  const errorObj = error instanceof Error ? error : new Error(String(error));
  // Only pass error — reset is a client-side concern (re-renders the segment) and
  // can't be serialized through RSC. The error.tsx component will receive reset=undefined
  // during SSR, which is fine — onClick={undefined} is harmless, and the real reset
  // function is only meaningful after hydration.
  let element = createElement(ErrorComponent, {
    error: errorObj,
  });
  const layouts = route?.layouts ?? rootLayouts;
  for (let i = layouts.length - 1; i >= 0; i--) {
    const LayoutComponent = layouts[i]?.default;
    if (LayoutComponent) {
      element = createElement(LayoutComponent, { children: element });
    }
  }
  const rscStream = renderToReadableStream(element, { onError: rscOnError });
  if (isRscRequest) {
    setHeadersContext(null);
    setNavigationContext(null);
    return new Response(rscStream, {
      status: 200,
      headers: { "Content-Type": "text/x-component; charset=utf-8" },
    });
  }
  // Collect font data from RSC environment so error pages include font styles
  const fontData = {
    links: _getSSRFontLinks(),
    styles: _getSSRFontStyles(),
  };
  const ssrEntry = await import.meta.viteRsc.loadModule("ssr", "index");
  const htmlStream = await ssrEntry.handleSsr(rscStream, _getNavigationContext(), fontData);
  setHeadersContext(null);
  setNavigationContext(null);
  return new Response(htmlStream, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function matchRoute(url, routes) {
  const pathname = url.split("?")[0];
  const normalizedUrl = pathname === "/" ? "/" : pathname.replace(/\\/$/, "");
  for (const route of routes) {
    const params = matchPattern(normalizedUrl, route.pattern);
    if (params !== null) return { route, params };
  }
  return null;
}

function matchPattern(url, pattern) {
  const urlParts = url.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  const params = {};
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
  for (const entry of interceptLookup) {
    const params = matchPattern(pathname, entry.targetPattern);
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

  // Resolve metadata and viewport from layouts and page
  const metadataList = [];
  const viewportList = [];
  for (const layoutMod of route.layouts) {
    if (layoutMod) {
      const meta = await resolveModuleMetadata(layoutMod, params);
      if (meta) metadataList.push(meta);
      const vp = await resolveModuleViewport(layoutMod, params);
      if (vp) viewportList.push(vp);
    }
  }
  if (route.page) {
    const pageMeta = await resolveModuleMetadata(route.page, params);
    if (pageMeta) metadataList.push(pageMeta);
    const pageVp = await resolveModuleViewport(route.page, params);
    if (pageVp) viewportList.push(pageVp);
  }
  const resolvedMetadata = metadataList.length > 0 ? mergeMetadata(metadataList) : null;
  const resolvedViewport = viewportList.length > 0 ? mergeViewport(viewportList) : null;

  // Build nested layout tree from outermost to innermost.
  // Next.js 16 passes params/searchParams as Promises (async pattern)
  // but pre-16 code accesses them as plain objects (params.id).
  // We create a "thenable object" that works both ways.
  const asyncParams = Object.assign(Promise.resolve(params), params);
  const pageProps = { params: asyncParams };
  if (searchParams) {
    const spObj = {};
    let hasSearchParams = false;
    if (searchParams.forEach) searchParams.forEach(function(v, k) {
      hasSearchParams = true;
      if (k in spObj) {
        // Multi-value: promote to array (Next.js returns string[] for duplicate keys)
        spObj[k] = Array.isArray(spObj[k]) ? spObj[k].concat(v) : [spObj[k], v];
      } else {
        spObj[k] = v;
      }
    });
    // If the URL has query parameters, mark the page as dynamic.
    // In Next.js, only accessing the searchParams prop signals dynamic usage,
    // but a Proxy-based approach doesn't work here because React's RSC debug
    // serializer accesses properties on all props (e.g. $$typeof check in
    // isClientReference), triggering the Proxy even when user code doesn't
    // read searchParams. Checking for non-empty query params is a safe
    // approximation: pages with query params in the URL are almost always
    // dynamic, and this avoids false positives from React internals.
    if (hasSearchParams) markDynamicUsage();
    pageProps.searchParams = Object.assign(Promise.resolve(spObj), spObj);
  }
  let element = createElement(PageComponent, pageProps);

  // Add metadata + viewport head tags (React 19 hoists title/meta/link to <head>)
  if (resolvedMetadata || resolvedViewport) {
    const headElements = [];
    if (resolvedMetadata) headElements.push(createElement(MetadataHead, { metadata: resolvedMetadata }));
    if (resolvedViewport) headElements.push(createElement(ViewportHead, { viewport: resolvedViewport }));
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

  // Wrap with error.tsx ErrorBoundary if present
  if (route.error?.default) {
    element = createElement(ErrorBoundary, {
      fallback: route.error.default,
      children: element,
    });
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

  // Wrap with layouts (innermost first, then outer)
  // Parallel slots are passed as named props to the innermost layout
  // (the layout at the same directory level as the page/slots)
  for (let i = route.layouts.length - 1; i >= 0; i--) {
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

      const layoutProps = { children: element, params: Object.assign(Promise.resolve(params), params) };

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
            let slotElement = createElement(SlotPage, { params: Object.assign(Promise.resolve(slotParams), slotParams) });
            // Wrap with slot-specific layout if present.
            // In Next.js, @slot/layout.tsx wraps the slot's page content
            // before it is passed as a prop to the parent layout.
            const SlotLayout = slotMod.layout?.default;
            if (SlotLayout) {
              slotElement = createElement(SlotLayout, {
                children: slotElement,
                params: Object.assign(Promise.resolve(slotParams), slotParams),
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
      // called INSIDE this layout knows its URL segment depth. The depth tells the
      // hook how many URL segments are above this layout, so it returns only the
      // segments below. We wrap the layout (not just children) because hooks are
      // called from components rendered inside the layout's own JSX.
      const layoutDepth = route.layoutSegmentDepths ? route.layoutSegmentDepths[i] : 0;
      element = createElement(LayoutSegmentProvider, { depth: layoutDepth }, element);
    }
  }

  // Wrap with global error boundary if app/global-error.tsx exists.
  // This catches errors in the root layout itself.
  ${globalErrorVar ? `
  const GlobalErrorComponent = ${globalErrorVar}.default;
  if (GlobalErrorComponent) {
    element = createElement(ErrorBoundary, {
      fallback: GlobalErrorComponent,
      children: element,
    });
  }
  ` : ""}

  return element;
}

${middlewarePath ? `
function matchMiddlewarePath(pathname, matcher) {
  if (!matcher) return true;
  const patterns = typeof matcher === "string" ? [matcher]
    : Array.isArray(matcher) ? matcher.map(m => typeof m === "string" ? m : m.source)
    : [];
  return patterns.some(pattern => {
    const re = new RegExp("^" + pattern
      .replace(/:(\\w+)\\*/g, "(?:.*)")
      .replace(/:(\\w+)\\+/g, "(?:.+)")
      .replace(/:(\\w+)/g, "([^/]+)")
      .replace(/\\./g, "\\\\.") + "$");
    return re.test(pathname);
  });
}
` : ""}

const __basePath = ${JSON.stringify(bp)};
const __trailingSlash = ${JSON.stringify(ts)};
const __configRedirects = ${JSON.stringify(redirects)};
const __configRewrites = ${JSON.stringify(rewrites)};
const __configHeaders = ${JSON.stringify(headers)};

// ── Config pattern matching (redirects, rewrites, headers) ──────────────
function __matchConfigPattern(pathname, pattern) {
  if (pattern.includes("(") || pattern.includes("\\\\")) {
    try {
      const paramNames = [];
      const regexStr = pattern
        .replace(/\\./g, "\\\\.")
        .replace(/:([a-zA-Z_]\\w*)\\*(?:\\(([^)]+)\\))?/g, (_, name, c) => { paramNames.push(name); return c ? "(" + c + ")" : "(.*)"; })
        .replace(/:([a-zA-Z_]\\w*)\\+(?:\\(([^)]+)\\))?/g, (_, name, c) => { paramNames.push(name); return c ? "(" + c + ")" : "(.+)"; })
        .replace(/:([a-zA-Z_]\\w*)\\(([^)]+)\\)/g, (_, name, c) => { paramNames.push(name); return "(" + c + ")"; })
        .replace(/:([a-zA-Z_]\\w*)/g, (_, name) => { paramNames.push(name); return "([^/]+)"; });
      const re = new RegExp("^" + regexStr + "$");
      const match = re.exec(pathname);
      if (!match) return null;
      const params = {};
      for (let i = 0; i < paramNames.length; i++) params[paramNames[i]] = match[i + 1] || "";
      return params;
    } catch { /* fall through */ }
  }
  const catchAllMatch = pattern.match(/:([a-zA-Z_]\\w*)(\\*|\\+)$/);
  if (catchAllMatch) {
    const prefix = pattern.slice(0, pattern.lastIndexOf(":"));
    const paramName = catchAllMatch[1];
    const isPlus = catchAllMatch[2] === "+";
    if (!pathname.startsWith(prefix.replace(/\\/$/, ""))) return null;
    const rest = pathname.slice(prefix.replace(/\\/$/, "").length);
    if (isPlus && (!rest || rest === "/")) return null;
    return { [paramName]: rest.startsWith("/") ? rest.slice(1) : rest };
  }
  const parts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (parts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(":")) params[parts[i].slice(1)] = pathParts[i];
    else if (parts[i] !== pathParts[i]) return null;
  }
  return params;
}

function __parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  const cookies = {};
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

function __checkSingleCondition(condition, ctx) {
  switch (condition.type) {
    case "header": {
      const v = ctx.headers.get(condition.key);
      if (v === null) return false;
      if (condition.value !== undefined) { try { return new RegExp(condition.value).test(v); } catch { return v === condition.value; } }
      return true;
    }
    case "cookie": {
      const v = ctx.cookies[condition.key];
      if (v === undefined) return false;
      if (condition.value !== undefined) { try { return new RegExp(condition.value).test(v); } catch { return v === condition.value; } }
      return true;
    }
    case "query": {
      const v = ctx.query.get(condition.key);
      if (v === null) return false;
      if (condition.value !== undefined) { try { return new RegExp(condition.value).test(v); } catch { return v === condition.value; } }
      return true;
    }
    case "host": {
      if (condition.value !== undefined) { try { return new RegExp(condition.value).test(ctx.host); } catch { return ctx.host === condition.value; } }
      return ctx.host === condition.key;
    }
    default: return false;
  }
}

function __checkHasConditions(has, missing, ctx) {
  if (has) { for (const c of has) { if (!__checkSingleCondition(c, ctx)) return false; } }
  if (missing) { for (const c of missing) { if (__checkSingleCondition(c, ctx)) return false; } }
  return true;
}

function __buildRequestContext(request) {
  const url = new URL(request.url);
  return {
    headers: request.headers,
    cookies: __parseCookies(request.headers.get("cookie")),
    query: url.searchParams,
    host: request.headers.get("host") || url.host,
  };
}

function __applyConfigRedirects(pathname, ctx) {
  for (const rule of __configRedirects) {
    const params = __matchConfigPattern(pathname, rule.source);
    if (params) {
      if (ctx && (rule.has || rule.missing)) { if (!__checkHasConditions(rule.has, rule.missing, ctx)) continue; }
      let dest = rule.destination;
      for (const [key, value] of Object.entries(params)) dest = dest.replace(":" + key, value);
      return { destination: dest, permanent: rule.permanent };
    }
  }
  return null;
}

function __applyConfigRewrites(pathname, rules, ctx) {
  for (const rule of rules) {
    const params = __matchConfigPattern(pathname, rule.source);
    if (params) {
      if (ctx && (rule.has || rule.missing)) { if (!__checkHasConditions(rule.has, rule.missing, ctx)) continue; }
      let dest = rule.destination;
      for (const [key, value] of Object.entries(params)) dest = dest.replace(":" + key, value);
      return dest;
    }
  }
  return null;
}

function __applyConfigHeaders(pathname) {
  const result = [];
  for (const rule of __configHeaders) {
    const groups = [];
    const withPlaceholders = rule.source.replace(/\\(([^)]+)\\)/g, (_, inner) => {
      groups.push(inner);
      return "___GROUP_" + (groups.length - 1) + "___";
    });
    const escaped = withPlaceholders
      .replace(/\\./g, "\\\\.")
      .replace(/\\+/g, "\\\\+")
      .replace(/\\?/g, "\\\\?")
      .replace(/\\*/g, ".*")
      .replace(/:[a-zA-Z_]\\w*/g, "[^/]+")
      .replace(/___GROUP_(\\d+)___/g, (_, idx) => "(" + groups[Number(idx)] + ")");
    const sourceRegex = new RegExp("^" + escaped + "$");
    if (sourceRegex.test(pathname)) result.push(...rule.headers);
  }
  return result;
}

export default async function handler(request) {
  // Wrap the entire request handling in runWithHeadersContext to ensure
  // headers() and cookies() work throughout the async RSC rendering pipeline.
  // This uses AsyncLocalStorage.run() which properly propagates through awaits.
  const headersCtx = headersContextFromRequest(request);
   return runWithHeadersContext(headersCtx, async () => {
    // Initialize per-request state for cache and private cache isolation.
    _initRequestScopedCacheState();
    _clearPrivateCache();
    // Install patched fetch with Next.js caching semantics for this request.
    // runWithFetchCache uses AsyncLocalStorage.run() for proper per-request
    // isolation of collected fetch tags in concurrent environments.
    return runWithFetchCache(async () => {
      const response = await _handleRequest(request);
      // Apply custom headers from next.config.js to non-redirect responses.
      // Skip redirects (3xx) because Response.redirect() creates immutable headers,
      // and Next.js doesn't apply custom headers to redirects anyway.
      if (__configHeaders.length && response && response.headers && !(response.status >= 300 && response.status < 400)) {
        const url = new URL(request.url);
        let pathname = url.pathname;
        ${bp ? `if (pathname.startsWith(${JSON.stringify(bp)})) pathname = pathname.slice(${JSON.stringify(bp)}.length) || "/";` : ""}
        const extraHeaders = __applyConfigHeaders(pathname);
        for (const h of extraHeaders) {
          response.headers.set(h.key, h.value);
        }
      }
      return response;
    });
  });
}

async function _handleRequest(request) {
  const url = new URL(request.url);
  let pathname = url.pathname;
  ${bp ? `
  // Strip basePath prefix
  if (__basePath && pathname.startsWith(__basePath)) {
    pathname = pathname.slice(__basePath.length) || "/";
  }
  ` : ""}

  // Trailing slash normalization (redirect to canonical form)
  if (pathname !== "/" && !pathname.startsWith("/api")) {
    const hasTrailing = pathname.endsWith("/");
    if (__trailingSlash && !hasTrailing && !pathname.endsWith(".rsc")) {
      return Response.redirect(new URL(__basePath + pathname + "/" + url.search, request.url), 308);
    } else if (!__trailingSlash && hasTrailing) {
      return Response.redirect(new URL(__basePath + pathname.replace(/\\/+$/, "") + url.search, request.url), 308);
    }
  }

  // ── Apply redirects from next.config.js ───────────────────────────────
  const __reqCtx = __buildRequestContext(request);
  if (__configRedirects.length) {
    const __redir = __applyConfigRedirects(pathname, __reqCtx);
    if (__redir) {
      const __redirDest = __basePath && !__redir.destination.startsWith(__basePath)
        ? __basePath + __redir.destination
        : __redir.destination;
      return new Response(null, {
        status: __redir.permanent ? 308 : 307,
        headers: { Location: __redirDest },
      });
    }
  }

  // ── Apply beforeFiles rewrites from next.config.js ────────────────────
  if (__configRewrites.beforeFiles && __configRewrites.beforeFiles.length) {
    const __rewritten = __applyConfigRewrites(pathname, __configRewrites.beforeFiles, __reqCtx);
    if (__rewritten) pathname = __rewritten;
  }

  const isRscRequest = pathname.endsWith(".rsc") || request.headers.get("accept")?.includes("text/x-component");
  let cleanPathname = pathname.replace(/\\.rsc$/, "");

  // Middleware response headers to merge into the final response
  let _middlewareResponseHeaders = null;
  // Custom status code from middleware rewrite (e.g. NextResponse.rewrite(url, { status: 403 }))
  let _middlewareRewriteStatus = null;

  ${middlewarePath ? `
   // Run proxy/middleware if present and path matches
  const middlewareFn = middlewareModule.default || middlewareModule.proxy || middlewareModule.middleware;
  const middlewareMatcher = middlewareModule.config?.matcher;
  if (typeof middlewareFn === "function" && matchMiddlewarePath(cleanPathname, middlewareMatcher)) {
    try {
      // Wrap in NextRequest so middleware gets .nextUrl, .cookies, .geo, .ip, etc.
      const nextRequest = request instanceof NextRequest ? request : new NextRequest(request);
      const mwResponse = await middlewareFn(nextRequest);
      if (mwResponse) {
        // Check for x-middleware-next (continue)
        if (mwResponse.headers.get("x-middleware-next") === "1") {
          // Middleware wants to continue - save headers to merge into final response
          _middlewareResponseHeaders = new Headers();
          for (const [key, value] of mwResponse.headers) {
            if (key !== "x-middleware-next" && key !== "x-middleware-rewrite") {
              _middlewareResponseHeaders.set(key, value);
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
            // Capture custom status code from rewrite (e.g. NextResponse.rewrite(url, { status: 403 }))
            if (mwResponse.status !== 200) {
              _middlewareRewriteStatus = mwResponse.status;
            }
            // Also save any other headers from the rewrite response
            _middlewareResponseHeaders = new Headers();
            for (const [key, value] of mwResponse.headers) {
              if (key !== "x-middleware-next" && key !== "x-middleware-rewrite") {
                _middlewareResponseHeaders.set(key, value);
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
    }
  }

  // Unpack x-middleware-request-* headers into the request context so that
  // headers() returns the middleware-modified headers instead of the original
  // request headers. Also strip those internal headers from the set that will
  // be merged into the outgoing HTTP response.
  if (_middlewareResponseHeaders) {
    applyMiddlewareRequestHeaders(_middlewareResponseHeaders);
    for (const key of [..._middlewareResponseHeaders.keys()]) {
      if (key.startsWith("x-middleware-request-")) {
        _middlewareResponseHeaders.delete(key);
      }
    }
  }
  ` : ""}

  // Handle metadata routes (sitemap.xml, robots.txt, manifest.webmanifest, etc.)
  for (const metaRoute of metadataRoutes) {
    if (cleanPathname === metaRoute.servedUrl) {
      if (metaRoute.isDynamic) {
        // Dynamic metadata route — call the default export and serialize
        const metaFn = metaRoute.module.default;
        if (typeof metaFn === "function") {
          const result = await metaFn();
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
  }

  // Set navigation context for Server Components.
  // Note: Headers context is already set by runWithHeadersContext in the handler wrapper.
  setNavigationContext({
    pathname: cleanPathname,
    searchParams: url.searchParams,
    params: {},
  });

  // Handle server action POST requests
  const actionId = request.headers.get("x-rsc-action");
  if (request.method === "POST" && actionId) {
    try {
      const contentType = request.headers.get("content-type") || "";
      const body = contentType.startsWith("multipart/form-data")
        ? await request.formData()
        : await request.text();
      const temporaryReferences = createTemporaryReferenceSet();
      const args = await decodeReply(body, { temporaryReferences });
      const action = await loadServerAction(actionId);
      let returnValue;
      let actionRedirect = null;
      try {
        const data = await action.apply(null, args);
        returnValue = { ok: true, data };
      } catch (e) {
        // Detect redirect() / permanentRedirect() called inside the action.
        // These throw errors with digest "NEXT_REDIRECT;replace;url[;status]".
        if (e && typeof e === "object" && "digest" in e) {
          const digest = String(e.digest);
          if (digest.startsWith("NEXT_REDIRECT;")) {
            const parts = digest.split(";");
            actionRedirect = {
              url: parts[2],
              type: parts[1] || "replace",       // "push" or "replace"
              status: parts[3] ? parseInt(parts[3], 10) : 307,
            };
            returnValue = { ok: true, data: undefined };
          } else if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
            // notFound() / forbidden() / unauthorized() in action — package as error
            returnValue = { ok: false, data: e };
          } else {
            returnValue = { ok: false, data: e };
          }
        } else {
          returnValue = { ok: false, data: e };
        }
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
      const match = matchRoute(cleanPathname, routes);
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

      const rscStream = renderToReadableStream(
        { root: element, returnValue },
        { temporaryReferences, onError: rscOnError },
      );

      // Collect cookies set during the action
      const actionPendingCookies = getAndClearPendingCookies();
      const actionDraftCookie = getDraftModeCookieHeader();
      setHeadersContext(null);
      setNavigationContext(null);

      const actionHeaders = { "Content-Type": "text/x-component; charset=utf-8" };
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
      ).catch(() => {});
      setHeadersContext(null);
      setNavigationContext(null);
      return new Response("Server action failed: " + (err && err.message ? err.message : String(err)), { status: 500 });
    }
  }

  // ── Apply afterFiles rewrites from next.config.js ──────────────────────
  if (__configRewrites.afterFiles && __configRewrites.afterFiles.length) {
    const __afterRewritten = __applyConfigRewrites(cleanPathname, __configRewrites.afterFiles, __reqCtx);
    if (__afterRewritten) cleanPathname = __afterRewritten;
  }

  let match = matchRoute(cleanPathname, routes);

  // ── Fallback rewrites from next.config.js (if no route matched) ───────
  if (!match && __configRewrites.fallback && __configRewrites.fallback.length) {
    const __fallbackRewritten = __applyConfigRewrites(cleanPathname, __configRewrites.fallback, __reqCtx);
    if (__fallbackRewritten) {
      cleanPathname = __fallbackRewritten;
      match = matchRoute(cleanPathname, routes);
    }
  }

  if (!match) {
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

    // Collect exported HTTP methods for OPTIONS auto-response and Allow header
    const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
    const exportedMethods = HTTP_METHODS.filter((m) => typeof handler[m] === "function");
    // If GET is exported, HEAD is implicitly supported
    if (exportedMethods.includes("GET") && !exportedMethods.includes("HEAD")) {
      exportedMethods.push("HEAD");
    }
    const hasDefault = typeof handler["default"] === "function";

    // OPTIONS auto-implementation: respond with Allow header and 204
    if (method === "OPTIONS" && typeof handler["OPTIONS"] !== "function") {
      const allowMethods = hasDefault ? HTTP_METHODS : exportedMethods;
      if (!allowMethods.includes("OPTIONS")) allowMethods.push("OPTIONS");
      setHeadersContext(null);
      setNavigationContext(null);
      return new Response(null, {
        status: 204,
        headers: { "Allow": allowMethods.join(", ") },
      });
    }

    // HEAD auto-implementation: run GET handler and strip body
    let handlerFn = handler[method] || handler["default"];
    let isAutoHead = false;
    if (method === "HEAD" && typeof handler["HEAD"] !== "function" && typeof handler["GET"] === "function") {
      handlerFn = handler["GET"];
      isAutoHead = true;
    }

    if (typeof handlerFn === "function") {
      try {
        const response = await handlerFn(request, { params });

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
            return new Response(null, {
              status: response.status,
              statusText: response.statusText,
              headers: newHeaders,
            });
          }
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        }

        if (isAutoHead) {
          // Strip body for auto-HEAD, preserve headers and status
          return new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        return response;
      } catch (err) {
        getAndClearPendingCookies(); // Clear any pending cookies on error
        // Catch redirect() / notFound() thrown from route handlers
        if (err && typeof err === "object" && "digest" in err) {
          const digest = String(err.digest);
          if (digest.startsWith("NEXT_REDIRECT;")) {
            const parts = digest.split(";");
            const redirectUrl = parts[2];
            const statusCode = parts[3] ? parseInt(parts[3], 10) : 307;
            setHeadersContext(null);
            setNavigationContext(null);
            return new Response(null, {
              status: statusCode,
              headers: { Location: new URL(redirectUrl, request.url).toString() },
            });
          }
          if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
            const statusCode = digest === "NEXT_NOT_FOUND" ? 404 : parseInt(digest.split(";")[1], 10);
            setHeadersContext(null);
            setNavigationContext(null);
            return new Response(null, { status: statusCode });
          }
        }
        setHeadersContext(null);
        setNavigationContext(null);
        console.error("[vinext] Route handler error:", err);
        _reportRequestError(
          err instanceof Error ? err : new Error(String(err)),
          { path: cleanPathname, method: request.method, headers: Object.fromEntries(request.headers.entries()) },
          { routerKind: "App Router", routePath: route.pattern, routeType: "route" },
        ).catch(() => {});
        return new Response(null, { status: 500 });
      }
    }
    setHeadersContext(null);
    setNavigationContext(null);
    return new Response(null, {
      status: 405,
      headers: { Allow: exportedMethods.join(", ") },
    });
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

  // dynamic = 'error': set a trap context that throws when headers/cookies are accessed
  if (isDynamicError) {
    const errorMsg = 'Page with \`dynamic = "error"\` used a dynamic API. ' +
      'This page was expected to be fully static, but headers(), cookies(), ' +
      'or searchParams was accessed. Remove the dynamic API usage or change ' +
      'the dynamic config to "auto" or "force-dynamic".';
    const throwingHeaders = new Proxy(new Headers(), {
      get(target, prop) {
        if (typeof prop === "string" && prop !== "then") throw new Error(errorMsg);
        return Reflect.get(target, prop);
      },
    });
    const throwingCookies = new Proxy(new Map(), {
      get(target, prop) {
        if (typeof prop === "string" && prop !== "then") throw new Error(errorMsg);
        return Reflect.get(target, prop);
      },
    });
    setHeadersContext({ headers: throwingHeaders, cookies: throwingCookies });
    setNavigationContext({
      pathname: cleanPathname,
      searchParams: new URLSearchParams(),
      params,
    });
  }

  // dynamicParams = false: only params from generateStaticParams are allowed
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

  // force-dynamic: skip ISR cache, set no-store Cache-Control
  const isForceDynamic = dynamicConfig === "force-dynamic";

  // ISR cache check for App Router pages with revalidate or "use cache" (skip if force-dynamic).
  const _isrCacheKey = "app:" + (cleanPathname === "/" ? "/" : cleanPathname.replace(/\\/$/, ""));
  // Check cacheLifeRouteMap for pages that used cacheLife() on a previous render
  const _cacheLifeRevalidate = _cacheLifeRouteMap.get(_isrCacheKey);
  if (revalidateSeconds === null && typeof _cacheLifeRevalidate === "number") {
    revalidateSeconds = _cacheLifeRevalidate;
  }
  if (!isForceDynamic && revalidateSeconds !== null && revalidateSeconds > 0) {
    const cached = await isrGet(_isrCacheKey);

    if (cached && cached.value.value && cached.value.value.kind === "APP_PAGE") {
      const cachedPage = cached.value.value;
      // Use revalidateSeconds from export, or fall back to the duration stored
      // in the ISR cache (set by cacheLife() on the first render), or default 900.
      const effectiveRevalidate = revalidateSeconds ?? 900;
      const cacheHeaders = {
        "X-Vinext-Cache": cached.isStale ? "STALE" : "HIT",
        "Cache-Control": cached.isStale
          ? "s-maxage=0, stale-while-revalidate"
          : "s-maxage=" + effectiveRevalidate + ", stale-while-revalidate",
      };

      if (cached.isStale) {
        // Trigger background regeneration
        isrTriggerRegen(_isrCacheKey, async function() {
          await runWithFetchCache(async () => {
            const freshElement = await buildPageElement(route, params, undefined, url.searchParams);
            const freshRscStream = renderToReadableStream(freshElement, { onError: rscOnError });
            // Collect font data from RSC environment
            const freshFontData = {
              links: _getSSRFontLinks(),
              styles: _getSSRFontStyles(),
            };
            const ssrEntryFresh = await import.meta.viteRsc.loadModule("ssr", "index");
            const freshHtmlStream = await ssrEntryFresh.handleSsr(freshRscStream, _getNavigationContext(), freshFontData);
            // Consume the stream to get HTML string
            const freshHtml = await new Response(freshHtmlStream).text();
            // Collect tags from fetch calls during rendering + add path tag for revalidatePath
            const regenTags = getCollectedFetchTags();
            const pathTag = "_N_T_" + (cleanPathname === "/" ? "/" : cleanPathname.replace(/\\/$/, ""));
            if (!regenTags.includes(pathTag)) regenTags.push(pathTag);
            if (!regenTags.includes(cleanPathname)) regenTags.push(cleanPathname);
            await isrSet(_isrCacheKey, { kind: "APP_PAGE", html: freshHtml, rscData: undefined, headers: undefined, postponed: undefined, status: undefined }, effectiveRevalidate, regenTags);
          });
        });
      }

      if (isRscRequest && cachedPage.rscData) {
        setHeadersContext(null);
        setNavigationContext(null);
        return new Response(cachedPage.rscData, {
          headers: { "Content-Type": "text/x-component; charset=utf-8", ...cacheHeaders },
        });
      }

      setHeadersContext(null);
      setNavigationContext(null);
      return new Response(cachedPage.html, {
        headers: { "Content-Type": "text/html; charset=utf-8", ...cacheHeaders },
      });
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
        const sourceMatch = matchRoute(sourceRoute.pattern, routes);
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
        const interceptStream = renderToReadableStream(interceptElement, { onError: rscOnError });
        setHeadersContext(null);
        setNavigationContext(null);
        return new Response(interceptStream, {
          headers: { "Content-Type": "text/x-component; charset=utf-8" },
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
        const redirectUrl = parts[2];
        const statusCode = parts[3] ? parseInt(parts[3], 10) : 307;
        setHeadersContext(null);
        setNavigationContext(null);
        return Response.redirect(new URL(redirectUrl, request.url), statusCode);
      }
      if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
        const statusCode = digest === "NEXT_NOT_FOUND" ? 404 : parseInt(digest.split(";")[1], 10);
        const fallbackResp = await renderHTTPAccessFallbackPage(route, statusCode, isRscRequest, request);
        if (fallbackResp) return fallbackResp;
        setHeadersContext(null);
        setNavigationContext(null);
        const statusText = statusCode === 403 ? "Forbidden" : statusCode === 401 ? "Unauthorized" : "Not Found";
        return new Response(statusText, { status: statusCode });
      }
    }
    // Non-special error (e.g. generateMetadata() threw) — render error.tsx if available
    const errorBoundaryResp = await renderErrorBoundaryPage(route, buildErr, isRscRequest, request);
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
        const redirectUrl = parts[2];
        const statusCode = parts[3] ? parseInt(parts[3], 10) : 307;
        setHeadersContext(null);
        setNavigationContext(null);
        return Response.redirect(new URL(redirectUrl, request.url), statusCode);
      }
      if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
        const statusCode = digest === "NEXT_NOT_FOUND" ? 404 : parseInt(digest.split(";")[1], 10);
        const fallbackResp = await renderHTTPAccessFallbackPage(route, statusCode, isRscRequest, request);
        if (fallbackResp) return fallbackResp;
        setHeadersContext(null);
        setNavigationContext(null);
        const statusText = statusCode === 403 ? "Forbidden" : statusCode === 401 ? "Unauthorized" : "Not Found";
        return new Response(statusText, { status: statusCode });
      }
    }
    return null;
  }

  // Pre-render the page component to catch redirect()/notFound() thrown synchronously.
  // Server Components are just functions — we can call PageComponent directly to detect
  // these special throws before starting the RSC stream.
  //
  // Because this calls the component outside React's render cycle, hooks like use()
  // trigger "Invalid hook call" console.error in dev. Suppress that expected warning.
  const _origConsoleError = console.error;
  console.error = (...args) => {
    if (typeof args[0] === "string" && args[0].includes("Invalid hook call")) return;
    _origConsoleError.apply(console, args);
  };
  try {
    const testResult = PageComponent({ params });
    // If it's a promise (async component), await it to catch async redirect/notFound
    if (testResult && typeof testResult === "object" && typeof testResult.then === "function") {
      await testResult;
    }
  } catch (preRenderErr) {
    const specialResponse = await handleRenderError(preRenderErr);
    if (specialResponse) return specialResponse;
    // Non-special errors from the pre-render test are expected (e.g. use() hook
    // fails outside React's render cycle, client references can't execute on server).
    // Only redirect/notFound/forbidden/unauthorized are actionable here — other
    // errors will be properly caught during actual RSC/SSR rendering below.
  } finally {
    console.error = _origConsoleError;
  }

  // Pre-render layout components to catch notFound()/redirect() thrown from layouts.
  // In Next.js, each layout level has its own NotFoundBoundary. When a layout throws
  // notFound(), the parent layout's boundary catches it and renders the parent's
  // not-found.tsx. Since React Flight doesn't activate client error boundaries during
  // RSC rendering, we catch layout-level throws here and render the appropriate
  // fallback page with only the layouts above the throwing one.
  if (route.layouts && route.layouts.length > 0) {
    const asyncParams = Object.assign(Promise.resolve(params), params);
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
            const redirectUrl = parts[2];
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
              { boundaryComponent: parentNotFound, layouts: parentLayouts }
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
  }

  // Render to RSC stream
  const rscStream = renderToReadableStream(element, { onError: rscOnError });

  if (isRscRequest) {
    // Direct RSC stream response (for client-side navigation)
    // NOTE: Do NOT clear headers/navigation context here!
    // The RSC stream is consumed lazily - components render when chunks are read.
    // If we clear context now, headers()/cookies() will fail during rendering.
    // Context will be cleared when the next request starts (via runWithHeadersContext).
    const responseHeaders = { "Content-Type": "text/x-component; charset=utf-8" };
    // Include matched route params so the client can hydrate useParams()
    if (params && Object.keys(params).length > 0) {
      responseHeaders["X-Vinext-Params"] = JSON.stringify(params);
    }
    if (isForceDynamic) {
      responseHeaders["Cache-Control"] = "no-store, must-revalidate";
    } else if ((isForceStatic || isDynamicError) && !revalidateSeconds) {
      responseHeaders["Cache-Control"] = "s-maxage=31536000, stale-while-revalidate";
      responseHeaders["X-Vinext-Cache"] = "STATIC";
    } else if (revalidateSeconds) {
      responseHeaders["Cache-Control"] = "s-maxage=" + revalidateSeconds + ", stale-while-revalidate";
      responseHeaders["X-Vinext-Cache"] = "MISS";
    }
    // Merge middleware response headers into the RSC response
    if (_middlewareResponseHeaders) {
      for (const [key, value] of _middlewareResponseHeaders) {
        responseHeaders[key] = value;
      }
    }
    return new Response(rscStream, { status: _middlewareRewriteStatus || 200, headers: responseHeaders });
  }

  // Collect font data from RSC environment before passing to SSR
  // (Fonts are loaded during RSC rendering when layout.tsx calls Geist() etc.)
  const fontData = {
    links: _getSSRFontLinks(),
    styles: _getSSRFontStyles(),
  };

  // Delegate to SSR environment for HTML rendering
  let htmlStream;
  try {
    const ssrEntry = await import.meta.viteRsc.loadModule("ssr", "index");
    htmlStream = await ssrEntry.handleSsr(rscStream, _getNavigationContext(), fontData);
  } catch (ssrErr) {
    const specialResponse = await handleRenderError(ssrErr);
    if (specialResponse) return specialResponse;
    // Non-special error during SSR — render error.tsx if available
    const errorBoundaryResp = await renderErrorBoundaryPage(route, ssrErr, isRscRequest, request);
    if (errorBoundaryResp) return errorBoundaryResp;
    throw ssrErr;
  }

  // Check for draftMode Set-Cookie header (from draftMode().enable()/disable())
  const draftCookie = getDraftModeCookieHeader();

  setHeadersContext(null);
  setNavigationContext(null);

  // Helper to attach draftMode cookie, middleware headers, and rewrite status to a response
  function attachMiddlewareContext(response) {
    if (draftCookie) {
      response.headers.append("Set-Cookie", draftCookie);
    }
    // Merge middleware response headers into the final response
    if (_middlewareResponseHeaders) {
      for (const [key, value] of _middlewareResponseHeaders) {
        response.headers.set(key, value);
      }
    }
    // Apply custom status code from middleware rewrite
    if (_middlewareRewriteStatus) {
      return new Response(response.body, {
        status: _middlewareRewriteStatus,
        headers: response.headers,
      });
    }
    return response;
  }

  // Check if any component called connection(), cookies(), headers(), or noStore()
  // during rendering. If so, treat as dynamic (skip ISR, set no-store).
  const dynamicUsedDuringRender = consumeDynamicUsage();

  // Check if cacheLife() was called during rendering (e.g., page with file-level "use cache").
  // If so, it dynamically sets the ISR revalidation period and records it in the route map
  // so subsequent requests can look up the ISR cache without re-rendering.
  const requestCacheLife = _consumeRequestScopedCacheLife();
  if (requestCacheLife && requestCacheLife.revalidate !== undefined && revalidateSeconds === null) {
    revalidateSeconds = requestCacheLife.revalidate;
    _cacheLifeRouteMap.set(_isrCacheKey, revalidateSeconds);
  }

  // force-dynamic: always return no-store (highest priority)
  if (isForceDynamic) {
    return attachMiddlewareContext(new Response(htmlStream, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, must-revalidate",
      },
    }));
  }

  // force-static / error: treat as static regardless of dynamic usage.
  // force-static intentionally provides empty headers/cookies context so
  // dynamic APIs return safe defaults; we ignore the dynamic usage signal.
  // dynamic='error' should have already thrown (via throwing Proxy) if user
  // code accessed dynamic APIs, so reaching here means rendering succeeded.
  if ((isForceStatic || isDynamicError) && (revalidateSeconds === null || revalidateSeconds === 0)) {
    return attachMiddlewareContext(new Response(htmlStream, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "s-maxage=31536000, stale-while-revalidate",
        "X-Vinext-Cache": "STATIC",
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
      },
    }));
  }

  // If ISR is enabled (via export const revalidate OR cacheLife()), cache the rendered HTML
  if (revalidateSeconds !== null && revalidateSeconds > 0) {
    // Collect tags from fetch calls during rendering + add path tag for revalidatePath
    const _isrTags = getCollectedFetchTags();
    const _pathTag = "_N_T_" + (cleanPathname === "/" ? "/" : cleanPathname.replace(/\\/$/, ""));
    if (!_isrTags.includes(_pathTag)) _isrTags.push(_pathTag);
    if (!_isrTags.includes(cleanPathname)) _isrTags.push(cleanPathname);
    // We need to tee the stream: one for caching, one for the response
    const [cacheStream, responseStream] = htmlStream.tee();
    // Cache in background
    new Response(cacheStream).text().then(function(html) {
      return isrSet(_isrCacheKey, { kind: "APP_PAGE", html: html, rscData: undefined, headers: undefined, postponed: undefined, status: undefined }, revalidateSeconds, _isrTags);
    }).catch(function(err) {
      console.error("[vinext] ISR cache store failed:", err);
    });

    return attachMiddlewareContext(new Response(responseStream, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "s-maxage=" + revalidateSeconds + ", stale-while-revalidate",
        "X-Vinext-Cache": "MISS",
      },
    }));
  }

  return attachMiddlewareContext(new Response(htmlStream, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }));
}

if (import.meta.hot) {
  import.meta.hot.accept();
}
`;
}

/**
 * Generate the virtual SSR entry module.
 *
 * This runs in the `ssr` Vite environment. It receives an RSC stream,
 * deserializes it to a React tree, and renders to HTML.
 */
export function generateSsrEntry(): string {
  return `
import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";
import { renderToReadableStream } from "react-dom/server.edge";
import { setNavigationContext } from "next/navigation";
import { safeJsonStringify } from "vinext/html";

/**
 * Collect all chunks from a ReadableStream into an array.
 * Used to capture the RSC payload for embedding in HTML.
 */
async function collectStreamChunks(stream) {
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // Convert Uint8Array to regular array for JSON serialization
    chunks.push(Array.from(value));
  }
  return chunks;
}

/**
 * Render the RSC stream to HTML.
 *
 * @param rscStream - The RSC payload stream from the RSC environment
 * @param navContext - Navigation context for client component SSR hooks.
 *   "use client" components like those using usePathname() need the current
 *   request URL during SSR, and they run in this SSR environment (separate
 *   from the RSC environment where the context was originally set).
 * @param fontData - Font links and styles collected from the RSC environment.
 *   Fonts are loaded during RSC rendering (when layout calls Geist() etc.),
 *   and the data needs to be passed to SSR since they're separate module instances.
 */
export async function handleSsr(rscStream, navContext, fontData) {
  // Set navigation context so hooks like usePathname() work during SSR
  // of "use client" components
  if (navContext) {
    setNavigationContext(navContext);
  }

  // Clear any stale callbacks from previous requests
  const { clearServerInsertedHTML, flushServerInsertedHTML } = await import("next/navigation");
  clearServerInsertedHTML();

  try {
    // Tee the RSC stream - one for SSR rendering, one for embedding in HTML.
    // This ensures the browser uses the SAME RSC payload for hydration that
    // was used to generate the HTML, avoiding hydration mismatches (React #418).
    const [ssrStream, embedStream] = rscStream.tee();

    // Collect RSC chunks for embedding (runs in parallel with SSR)
    const rscChunksPromise = collectStreamChunks(embedStream);

    // Deserialize RSC stream back to React VDOM
    const root = await createFromReadableStream(ssrStream);

    // Get the bootstrap script content for the browser entry
    const bootstrapScriptContent =
      await import.meta.viteRsc.loadBootstrapScriptContent("index");

    // Render HTML (traditional SSR)
    // useServerInsertedHTML callbacks are registered during this render.
    // The onError callback preserves the digest for Next.js navigation errors
    // (redirect, notFound, forbidden, unauthorized) thrown inside Suspense
    // boundaries during RSC streaming. Without this, React's default onError
    // returns undefined and the digest is lost in the $RX() call, preventing
    // client-side error boundaries from identifying the error type.
    const htmlStream = await renderToReadableStream(root, {
      bootstrapScriptContent,
      onError(error) {
        if (error && typeof error === "object" && "digest" in error) {
          return String(error.digest);
        }
        return undefined;
      },
    });

    // Wait for RSC chunks to be collected
    const rscChunks = await rscChunksPromise;

    // Create the script that embeds the RSC payload and route params for hydration.
    // The browser entry will read this instead of fetching a new RSC stream.
    // We also embed the route params so useParams() works on hydration.
    const embedData = {
      rsc: rscChunks,
      params: navContext?.params || {},
    };
    const rscEmbedScript = '<script>self.__VINEXT_RSC__=' + safeJsonStringify(embedData) + '</script>';

    // Flush useServerInsertedHTML callbacks (CSS-in-JS style injection)
    const insertedElements = flushServerInsertedHTML();

    // Render the inserted elements to HTML strings
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement, Fragment } = await import("react");
    let insertedHTML = "";
    for (const el of insertedElements) {
      try {
        insertedHTML += renderToStaticMarkup(createElement(Fragment, null, el));
      } catch {
        // Skip elements that can't be rendered
      }
    }

    // Build font HTML from data passed from RSC environment
    // (Fonts are loaded during RSC rendering, and RSC/SSR are separate module instances)
    let fontHTML = "";
    if (fontData) {
      if (fontData.links && fontData.links.length > 0) {
        for (const url of fontData.links) {
          fontHTML += '<link rel="stylesheet" href="' + url + '" />\\n';
        }
      }
      if (fontData.styles && fontData.styles.length > 0) {
        fontHTML += '<style data-vinext-fonts>' + fontData.styles.join("\\n") + '</style>\\n';
      }
    }

    // Combine RSC embed script, server-inserted HTML, and font HTML
    const injectHTML = rscEmbedScript + insertedHTML + fontHTML;

    // Inject the collected HTML before </head> using a TransformStream
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let injected = false;

    // Fix invalid preload "as" values emitted by React's Flight protocol.
    // React Flight's server emits HL hints with as="stylesheet" for CSS,
    // but the HTML spec requires as="style" for <link rel="preload"> of CSS.
    // See: https://html.spec.whatwg.org/multipage/links.html#link-type-preload
    function fixPreloadAs(html) {
      // Match <link ...rel="preload"... as="stylesheet"...> in any attribute order
      return html.replace(/<link(?=[^>]*\\srel="preload")[^>]*>/g, function(tag) {
        return tag.replace(' as="stylesheet"', ' as="style"');
      });
    }

    const transform = new TransformStream({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });
        const fixed = fixPreloadAs(text);
        if (injected) {
          controller.enqueue(encoder.encode(fixed));
          return;
        }
        const headEnd = fixed.indexOf("</head>");
        if (headEnd !== -1) {
          // Inject before </head>
          const before = fixed.slice(0, headEnd);
          const after = fixed.slice(headEnd);
          controller.enqueue(encoder.encode(before + injectHTML + after));
          injected = true;
        } else {
          controller.enqueue(encoder.encode(fixed));
        }
      },
      flush(controller) {
        // If </head> was never found, append at the end
        if (!injected && injectHTML) {
          controller.enqueue(encoder.encode(injectHTML));
        }
      },
    });

    return htmlStream.pipeThrough(transform);
  } finally {
    // Clean up so we don't leak context between requests
    setNavigationContext(null);
    clearServerInsertedHTML();
  }
}
`;
}

/**
 * Generate the virtual browser entry module.
 *
 * This runs in the client (browser). It hydrates the page from the
 * embedded RSC payload and handles client-side navigation by re-fetching
 * RSC streams.
 */
export function generateBrowserEntry(): string {
  return `
import {
  createFromReadableStream,
  createFromFetch,
  setServerCallback,
  encodeReply,
  createTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/browser";
import { hydrateRoot } from "react-dom/client";
import { setClientParams } from "next/navigation";

let reactRoot;

/**
 * Convert the embedded RSC chunks back to a ReadableStream.
 * Each chunk is an array of numbers (from Uint8Array).
 */
function chunksToReadableStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new Uint8Array(chunk));
      }
      controller.close();
    }
  });
}

// Register the server action callback — React calls this internally
// when a "use server" function is invoked from client code.
setServerCallback(async (id, args) => {
  const temporaryReferences = createTemporaryReferenceSet();
  const body = await encodeReply(args, { temporaryReferences });

  const fetchResponse = await fetch(window.location.pathname + ".rsc" + window.location.search, {
    method: "POST",
    headers: { "x-rsc-action": id },
    body,
  });

  // Check for redirect signal from server action that called redirect()
  const actionRedirect = fetchResponse.headers.get("x-action-redirect");
  if (actionRedirect) {
    // Navigate to the redirect target using client-side navigation
    const redirectType = fetchResponse.headers.get("x-action-redirect-type") || "replace";
    if (redirectType === "push") {
      window.history.pushState(null, "", actionRedirect);
    } else {
      window.history.replaceState(null, "", actionRedirect);
    }
    // Trigger RSC navigation to the redirect target
    if (typeof window.__VINEXT_RSC_NAVIGATE__ === "function") {
      window.__VINEXT_RSC_NAVIGATE__(actionRedirect);
    }
    return undefined;
  }

  const result = await createFromFetch(Promise.resolve(fetchResponse), { temporaryReferences });

  // The RSC response for actions contains { root, returnValue }.
  // Re-render the page with the updated tree.
  if (result && typeof result === "object" && "root" in result) {
    reactRoot.render(result.root);
    // Return the action's return value to the caller
    if (result.returnValue) {
      if (!result.returnValue.ok) throw result.returnValue.data;
      return result.returnValue.data;
    }
    return undefined;
  }

  // Fallback: render the entire result as the tree
  reactRoot.render(result);
  return result;
});

async function main() {
  let rscStream;

  // Use embedded RSC data for initial hydration if available.
  // This ensures we use the SAME RSC payload that generated the HTML,
  // avoiding hydration mismatches (React error #418).
  if (self.__VINEXT_RSC__) {
    const embedData = self.__VINEXT_RSC__;
    delete self.__VINEXT_RSC__; // Clean up to free memory

    // Hydrate useParams() with route params from the embedded data
    if (embedData.params) {
      setClientParams(embedData.params);
    }

    rscStream = chunksToReadableStream(embedData.rsc);
  } else {
    // Fallback: fetch fresh RSC (shouldn't happen on initial page load)
    const rscResponse = await fetch(window.location.pathname + ".rsc" + window.location.search);

    // Hydrate useParams() with route params from the server before React hydration
    const paramsHeader = rscResponse.headers.get("X-Vinext-Params");
    if (paramsHeader) {
      try { setClientParams(JSON.parse(paramsHeader)); } catch (_e) { /* ignore */ }
    }

    rscStream = rscResponse.body;
  }

  const root = await createFromReadableStream(rscStream);

  // Hydrate the document
  reactRoot = hydrateRoot(document, root);

  // Store for client-side navigation
  window.__VINEXT_RSC_ROOT__ = reactRoot;

  // Client-side navigation handler
  window.__VINEXT_RSC_NAVIGATE__ = async function navigateRsc(href) {
    try {
      const url = new URL(href, window.location.origin);
      const navResponse = await fetch(url.pathname + ".rsc" + url.search, {
        headers: { Accept: "text/x-component" },
      });

      // Update useParams() with route params from the server before re-rendering
      const navParamsHeader = navResponse.headers.get("X-Vinext-Params");
      if (navParamsHeader) {
        try { setClientParams(JSON.parse(navParamsHeader)); } catch (_e) { /* ignore */ }
      } else {
        setClientParams({});
      }

      const rscPayload = await createFromFetch(Promise.resolve(navResponse));
      reactRoot.render(rscPayload);
    } catch (err) {
      console.error("[vinext] RSC navigation error:", err);
      // Fallback to full page load
      window.location.href = href;
    }
  };

  // Handle popstate (browser back/forward)
  window.addEventListener("popstate", () => {
    window.__VINEXT_RSC_NAVIGATE__(window.location.href);
  });

  // HMR: re-render on server module updates
  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", async () => {
      try {
        const rscPayload = await createFromFetch(
          fetch(window.location.pathname + ".rsc" + window.location.search)
        );
        reactRoot.render(rscPayload);
      } catch (err) {
        console.error("[vinext] RSC HMR error:", err);
      }
    });
  }
}

main();
`;
}
