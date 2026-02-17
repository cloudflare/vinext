/**
 * App Router dev server handler.
 *
 * This module generates virtual entry points for the RSC/SSR/browser
 * environments that @vitejs/plugin-rsc manages. The RSC entry does
 * route matching and renders the component tree, then delegates to
 * the SSR entry for HTML generation.
 */
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
    if (route.forbiddenPath) getImportVar(route.forbiddenPath);
    if (route.unauthorizedPath) getImportVar(route.unauthorizedPath);
    // Register parallel slot modules
    for (const slot of route.parallelSlots) {
      if (slot.pagePath) getImportVar(slot.pagePath);
      if (slot.defaultPath) getImportVar(slot.defaultPath);
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
  const metaRouteEntries = effectiveMetaRoutes.map((mr) => {
    return `  {
    type: ${JSON.stringify(mr.type)},
    isDynamic: ${mr.isDynamic},
    servedUrl: ${JSON.stringify(mr.servedUrl)},
    contentType: ${JSON.stringify(mr.contentType)},
    ${mr.isDynamic ? `module: ${getImportVar(mr.filePath)},` : `filePath: ${JSON.stringify(mr.filePath.replace(/\\/g, "/"))},`}
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
import { setNavigationContext as _setNavigationContextOrig } from "next/navigation";
import { setHeadersContext, headersContextFromRequest, getDraftModeCookieHeader, getAndClearPendingCookies, consumeDynamicUsage, markDynamicUsage } from "next/headers";
import { ErrorBoundary, NotFoundBoundary } from "vinext/error-boundary";
import { LayoutSegmentProvider } from "vinext/layout-segment-context";
import { MetadataHead, mergeMetadata, resolveModuleMetadata, ViewportHead, mergeViewport, resolveModuleViewport } from "vinext/metadata";
${middlewarePath ? `import * as middlewareModule from ${JSON.stringify(middlewarePath.replace(/\\/g, "/"))};` : ""}
${effectiveMetaRoutes.length > 0 ? `import { sitemapToXml, robotsToText, manifestToJson } from ${JSON.stringify(new URL("./metadata-routes.js", import.meta.url).pathname.replace(/\\/g, "/"))};` : ""}
import { getCacheHandler, _consumeRequestScopedCacheLife } from "next/cache";
import { withFetchCache } from "vinext/fetch-cache";
import { reportRequestError as _reportRequestError } from "vinext/instrumentation";

// Track current navigation context so we can pass it to the SSR environment.
// "use client" components rendered during SSR need the pathname/searchParams/params
// but the SSR environment has a separate module instance of next/navigation.
let _currentNavContext = null;
function setNavigationContext(ctx) {
  _currentNavContext = ctx;
  _setNavigationContextOrig(ctx);
}

// ISR cache helpers
async function isrGet(key) {
  const handler = getCacheHandler();
  const result = await handler.get(key);
  if (!result || !result.value) return null;
  return { value: result, isStale: result.cacheState === "stale" };
}
async function isrSet(key, data, revalidateSeconds) {
  const handler = getCacheHandler();
  await handler.set(key, data, { revalidate: revalidateSeconds });
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
 */
async function renderHTTPAccessFallbackPage(route, statusCode, isRscRequest, request) {
  // Determine which boundary component to use based on status code
  let boundaryModule;
  if (statusCode === 403) {
    boundaryModule = route?.forbidden ?? rootForbiddenModule;
  } else if (statusCode === 401) {
    boundaryModule = route?.unauthorized ?? rootUnauthorizedModule;
  } else {
    boundaryModule = route?.notFound ?? rootNotFoundModule;
  }
  const layouts = route?.layouts ?? rootLayouts;
  if (!boundaryModule) return null;

  const BoundaryComponent = boundaryModule.default;
  if (!BoundaryComponent) return null;

  // Build element: noindex meta + boundary component wrapped in layouts
  const noindexMeta = createElement("meta", { name: "robots", content: "noindex" });
  let element = createElement(Fragment, null, noindexMeta, createElement(BoundaryComponent));
  for (let i = layouts.length - 1; i >= 0; i--) {
    const LayoutComponent = layouts[i]?.default;
    if (LayoutComponent) {
      element = createElement(LayoutComponent, { children: element });
    }
  }
  const rscStream = renderToReadableStream(element);
  if (isRscRequest) {
    setHeadersContext(null);
    setNavigationContext(null);
    return new Response(rscStream, {
      status: statusCode,
      headers: { "Content-Type": "text/x-component; charset=utf-8" },
    });
  }
  const ssrEntry = await import.meta.viteRsc.loadModule("ssr", "index");
  const htmlStream = await ssrEntry.handleSsr(rscStream, _currentNavContext);
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
    if (searchParams.forEach) searchParams.forEach(function(v, k) { spObj[k] = v; hasSearchParams = true; });
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

function __applyConfigRedirects(pathname) {
  for (const rule of __configRedirects) {
    const params = __matchConfigPattern(pathname, rule.source);
    if (params) {
      let dest = rule.destination;
      for (const [key, value] of Object.entries(params)) dest = dest.replace(":" + key, value);
      return { destination: dest, permanent: rule.permanent };
    }
  }
  return null;
}

function __applyConfigRewrites(pathname, rules) {
  for (const rule of rules) {
    const params = __matchConfigPattern(pathname, rule.source);
    if (params) {
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
  // Install patched fetch with Next.js caching semantics for this request.
  // All fetch() calls during RSC rendering will go through the cache.
  const cleanupFetchCache = withFetchCache();
  try {
    const response = await _handleRequest(request);
    // Apply custom headers from next.config.js to all non-redirect responses
    if (__configHeaders.length && response && response.headers) {
      const url = new URL(request.url);
      let pathname = url.pathname;
      ${bp ? `if (pathname.startsWith(${JSON.stringify(bp)})) pathname = pathname.slice(${JSON.stringify(bp)}.length) || "/";` : ""}
      const extraHeaders = __applyConfigHeaders(pathname);
      for (const h of extraHeaders) {
        response.headers.set(h.key, h.value);
      }
    }
    return response;
  } finally {
    cleanupFetchCache();
  }
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
  if (__configRedirects.length) {
    const __redir = __applyConfigRedirects(pathname);
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
    const __rewritten = __applyConfigRewrites(pathname, __configRewrites.beforeFiles);
    if (__rewritten) pathname = __rewritten;
  }

  const isRscRequest = pathname.endsWith(".rsc") || request.headers.get("accept")?.includes("text/x-component");
  let cleanPathname = pathname.replace(/\\.rsc$/, "");

  ${middlewarePath ? `
   // Run proxy/middleware if present and path matches
  const middlewareFn = middlewareModule.default || middlewareModule.proxy || middlewareModule.middleware;
  const middlewareMatcher = middlewareModule.config?.matcher;
  if (typeof middlewareFn === "function" && matchMiddlewarePath(cleanPathname, middlewareMatcher)) {
    try {
      const mwResponse = await middlewareFn(request);
      if (mwResponse) {
        // Check for x-middleware-next (continue)
        if (mwResponse.headers.get("x-middleware-next") !== "1") {
          // Check for redirect
          if (mwResponse.status >= 300 && mwResponse.status < 400) {
            return mwResponse;
          }
          // Check for rewrite
          const rewriteUrl = mwResponse.headers.get("x-middleware-rewrite");
          if (rewriteUrl) {
            const rewriteParsed = new URL(rewriteUrl, request.url);
            cleanPathname = rewriteParsed.pathname;
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
        // Static metadata file — read and serve
        const fs = await import("node:fs");
        try {
          const data = fs.readFileSync(metaRoute.filePath);
          return new Response(data, {
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

  // Set request contexts for Server Components
  setHeadersContext(headersContextFromRequest(request));
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
        { temporaryReferences },
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
    const __afterRewritten = __applyConfigRewrites(cleanPathname, __configRewrites.afterFiles);
    if (__afterRewritten) cleanPathname = __afterRewritten;
  }

  let match = matchRoute(cleanPathname, routes);

  // ── Fallback rewrites from next.config.js (if no route matched) ───────
  if (!match && __configRewrites.fallback && __configRewrites.fallback.length) {
    const __fallbackRewritten = __applyConfigRewrites(cleanPathname, __configRewrites.fallback);
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
          const freshElement = await buildPageElement(route, params, undefined, url.searchParams);
          const freshRscStream = renderToReadableStream(freshElement);
          const ssrEntryFresh = await import.meta.viteRsc.loadModule("ssr", "index");
          const freshHtmlStream = await ssrEntryFresh.handleSsr(freshRscStream, _currentNavContext);
          // Consume the stream to get HTML string
          const freshHtml = await new Response(freshHtmlStream).text();
          await isrSet(_isrCacheKey, { kind: "APP_PAGE", html: freshHtml, rscData: undefined, headers: undefined, postponed: undefined, status: undefined }, effectiveRevalidate);
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
        const interceptStream = renderToReadableStream(interceptElement);
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
    // Not a special error — let it propagate through normal RSC rendering
    // (React error boundaries, etc.)
  } finally {
    console.error = _origConsoleError;
  }

  // Render to RSC stream
  const rscStream = renderToReadableStream(element);

  if (isRscRequest) {
    // Direct RSC stream response (for client-side navigation)
    setHeadersContext(null);
    setNavigationContext(null);
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
    return new Response(rscStream, { headers: responseHeaders });
  }

  // Delegate to SSR environment for HTML rendering
  let htmlStream;
  try {
    const ssrEntry = await import.meta.viteRsc.loadModule("ssr", "index");
    htmlStream = await ssrEntry.handleSsr(rscStream, _currentNavContext);
  } catch (ssrErr) {
    const specialResponse = await handleRenderError(ssrErr);
    if (specialResponse) return specialResponse;
    throw ssrErr;
  }

  // Check for draftMode Set-Cookie header (from draftMode().enable()/disable())
  const draftCookie = getDraftModeCookieHeader();

  setHeadersContext(null);
  setNavigationContext(null);

  // Helper to attach draftMode cookie to a response if present
  function attachDraftCookie(response) {
    if (draftCookie) {
      response.headers.append("Set-Cookie", draftCookie);
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
    return attachDraftCookie(new Response(htmlStream, {
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
    return attachDraftCookie(new Response(htmlStream, {
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
    return attachDraftCookie(new Response(htmlStream, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, must-revalidate",
      },
    }));
  }

  // If ISR is enabled (via export const revalidate OR cacheLife()), cache the rendered HTML
  if (revalidateSeconds !== null && revalidateSeconds > 0) {
    // We need to tee the stream: one for caching, one for the response
    const [cacheStream, responseStream] = htmlStream.tee();
    // Cache in background
    new Response(cacheStream).text().then(function(html) {
      return isrSet(_isrCacheKey, { kind: "APP_PAGE", html: html, rscData: undefined, headers: undefined, postponed: undefined, status: undefined }, revalidateSeconds);
    }).catch(function(err) {
      console.error("[vinext] ISR cache store failed:", err);
    });

    return attachDraftCookie(new Response(responseStream, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "s-maxage=" + revalidateSeconds + ", stale-while-revalidate",
        "X-Vinext-Cache": "MISS",
      },
    }));
  }

  return attachDraftCookie(new Response(htmlStream, {
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

/**
 * Render the RSC stream to HTML.
 *
 * @param rscStream - The RSC payload stream from the RSC environment
 * @param navContext - Navigation context for client component SSR hooks.
 *   "use client" components like those using usePathname() need the current
 *   request URL during SSR, and they run in this SSR environment (separate
 *   from the RSC environment where the context was originally set).
 */
export async function handleSsr(rscStream, navContext) {
  // Set navigation context so hooks like usePathname() work during SSR
  // of "use client" components
  if (navContext) {
    setNavigationContext(navContext);
  }

  // Clear any stale callbacks from previous requests
  const { clearServerInsertedHTML, flushServerInsertedHTML } = await import("next/navigation");
  clearServerInsertedHTML();

  try {
    // Deserialize RSC stream back to React VDOM
    const root = await createFromReadableStream(rscStream);

    // Get the bootstrap script content for the browser entry
    const bootstrapScriptContent =
      await import.meta.viteRsc.loadBootstrapScriptContent("index");

    // Render HTML (traditional SSR)
    // useServerInsertedHTML callbacks are registered during this render
    const htmlStream = await renderToReadableStream(root, {
      bootstrapScriptContent,
    });

    // Flush useServerInsertedHTML callbacks (CSS-in-JS style injection)
    const insertedElements = flushServerInsertedHTML();
    if (insertedElements.length === 0) {
      return htmlStream;
    }

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

    if (!insertedHTML) {
      return htmlStream;
    }

    // Inject the collected HTML before </head> using a TransformStream
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let injected = false;

    const transform = new TransformStream({
      transform(chunk, controller) {
        if (injected) {
          controller.enqueue(chunk);
          return;
        }
        const text = decoder.decode(chunk, { stream: true });
        const headEnd = text.indexOf("</head>");
        if (headEnd !== -1) {
          // Inject before </head>
          const before = text.slice(0, headEnd);
          const after = text.slice(headEnd);
          controller.enqueue(encoder.encode(before + insertedHTML + after));
          injected = true;
        } else {
          controller.enqueue(chunk);
        }
      },
      flush(controller) {
        // If </head> was never found, append at the end
        if (!injected && insertedHTML) {
          controller.enqueue(encoder.encode(insertedHTML));
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
  // Initial hydration: fetch the RSC stream for the current page
  const rscResponse = await fetch(window.location.pathname + ".rsc" + window.location.search);

  // Hydrate useParams() with route params from the server before React hydration
  const paramsHeader = rscResponse.headers.get("X-Vinext-Params");
  if (paramsHeader) {
    try { setClientParams(JSON.parse(paramsHeader)); } catch (_e) { /* ignore */ }
  }

  const root = await createFromReadableStream(rscResponse.body);

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
