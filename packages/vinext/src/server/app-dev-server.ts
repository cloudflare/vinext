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
import { generateDevOriginCheckCode } from "./dev-origin-check.js";
import { generateSafeRegExpCode, generateMiddlewareMatcherCode, generateNormalizePathCode } from "./middleware-codegen.js";

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
  /** Extra origins allowed for dev server access (from serverActionsAllowedOrigins or custom config). */
  allowedDevOrigins?: string[];
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
  const allowedOrigins = config?.allowedOrigins ?? [];
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
    if (route.layoutErrorPaths) for (const ep of route.layoutErrorPaths) { if (ep) getImportVar(ep); }
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
    const layoutErrorVars = (route.layoutErrorPaths || []).map((ep) => ep ? getImportVar(ep) : "null");
    return `  {
    pattern: ${JSON.stringify(route.pattern)},
    isDynamic: ${route.isDynamic},
    params: ${JSON.stringify(route.params)},
    page: ${route.pagePath ? getImportVar(route.pagePath) : "null"},
    routeHandler: ${route.routePath ? getImportVar(route.routePath) : "null"},
    layouts: [${layoutVars.join(", ")}],
    layoutSegmentDepths: ${JSON.stringify(route.layoutSegmentDepths)},
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
import { _consumeRequestScopedCacheLife, _runWithCacheState } from "next/cache";
import { runWithFetchCache } from "vinext/fetch-cache";
import { runWithPrivateCache as _runWithPrivateCache } from "vinext/cache-runtime";
// Import server-only state module to register ALS-backed accessors.
import { runWithNavigationContext as _runWithNavigationContext } from "vinext/navigation-state";
import { reportRequestError as _reportRequestError } from "vinext/instrumentation";
import { getSSRFontLinks as _getSSRFontLinks, getSSRFontStyles as _getSSRFontStylesGoogle, getSSRFontPreloads as _getSSRFontPreloadsGoogle } from "next/font/google";
import { getSSRFontStyles as _getSSRFontStylesLocal, getSSRFontPreloads as _getSSRFontPreloadsLocal } from "next/font/local";
function _getSSRFontStyles() { return [..._getSSRFontStylesGoogle(), ..._getSSRFontStylesLocal()]; }
function _getSSRFontPreloads() { return [..._getSSRFontPreloadsGoogle(), ..._getSSRFontPreloadsLocal()]; }

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
// Production ISR is handled by prod-server.ts and the Cloudflare worker entry.

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
function rscOnError(error) {
  if (error && typeof error === "object" && "digest" in error) {
    return String(error.digest);
  }
  // In production, generate a digest hash for non-navigation errors
  if (process.env.NODE_ENV === "production" && error) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack || "") : "";
    return __errorDigest(msg + stack);
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
  // Always include charset and default viewport for parity with Next.js.
  const charsetMeta = createElement("meta", { charSet: "utf-8" });
  const noindexMeta = createElement("meta", { name: "robots", content: "noindex" });
  const headElements = [charsetMeta, noindexMeta];
  if (resolvedMetadata) headElements.push(createElement(MetadataHead, { metadata: resolvedMetadata }));
  const effectiveViewport = resolvedViewport ?? { width: "device-width", initialScale: 1 };
  headElements.push(createElement(ViewportHead, { viewport: effectiveViewport }));
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
    const layoutDepths = route?.layoutSegmentDepths;
    for (let i = layouts.length - 1; i >= 0; i--) {
      const LayoutComponent = layouts[i]?.default;
      if (LayoutComponent) {
        element = createElement(LayoutComponent, { children: element });
        const layoutDepth = layoutDepths ? layoutDepths[i] : 0;
        element = createElement(LayoutSegmentProvider, { depth: layoutDepth }, element);
      }
    }
    ${globalErrorVar ? `
    const _GlobalErrorComponent = ${globalErrorVar}.default;
    if (_GlobalErrorComponent) {
      element = createElement(ErrorBoundary, {
        fallback: _GlobalErrorComponent,
        children: element,
      });
    }
    ` : ""}
    const rscStream = renderToReadableStream(element, { onError: rscOnError });
    setHeadersContext(null);
    setNavigationContext(null);
    return new Response(rscStream, {
      status: statusCode,
      headers: { "Content-Type": "text/x-component; charset=utf-8", "Vary": "RSC, Accept" },
    });
  }
  // For HTML (full page load) responses, wrap with layouts only (no client-side
  // wrappers needed since SSR generates the complete HTML document).
  for (let i = layouts.length - 1; i >= 0; i--) {
    const LayoutComponent = layouts[i]?.default;
    if (LayoutComponent) {
      element = createElement(LayoutComponent, { children: element });
    }
  }
  const rscStream = renderToReadableStream(element, { onError: rscOnError });
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
  // Resolve the error boundary component: leaf error.tsx first, then walk per-layout
  // errors from innermost to outermost (matching ancestor inheritance), then global-error.tsx.
  let ErrorComponent = route?.error?.default ?? null;
  if (!ErrorComponent && route?.errors) {
    for (let i = route.errors.length - 1; i >= 0; i--) {
      if (route.errors[i]?.default) {
        ErrorComponent = route.errors[i].default;
        break;
      }
    }
  }
  ErrorComponent = ErrorComponent${globalErrorVar ? ` ?? ${globalErrorVar}?.default` : ""};
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
  const layouts = route?.layouts ?? rootLayouts;
  if (isRscRequest) {
    // For RSC requests (client-side navigation), wrap with the same component
    // wrappers that buildPageElement() uses (LayoutSegmentProvider, GlobalErrorBoundary).
    // This ensures React can reconcile the tree without destroying the DOM.
    // Same rationale as renderHTTPAccessFallbackPage — see comment there.
    const layoutDepths = route?.layoutSegmentDepths;
    for (let i = layouts.length - 1; i >= 0; i--) {
      const LayoutComponent = layouts[i]?.default;
      if (LayoutComponent) {
        element = createElement(LayoutComponent, { children: element });
        const layoutDepth = layoutDepths ? layoutDepths[i] : 0;
        element = createElement(LayoutSegmentProvider, { depth: layoutDepth }, element);
      }
    }
    ${globalErrorVar ? `
    const _ErrGlobalComponent = ${globalErrorVar}.default;
    if (_ErrGlobalComponent) {
      element = createElement(ErrorBoundary, {
        fallback: _ErrGlobalComponent,
        children: element,
      });
    }
    ` : ""}
    const rscStream = renderToReadableStream(element, { onError: rscOnError });
    setHeadersContext(null);
    setNavigationContext(null);
    return new Response(rscStream, {
      status: 200,
      headers: { "Content-Type": "text/x-component; charset=utf-8", "Vary": "RSC, Accept" },
    });
  }
  // For HTML (full page load) responses, wrap with layouts only.
  for (let i = layouts.length - 1; i >= 0; i--) {
    const LayoutComponent = layouts[i]?.default;
    if (LayoutComponent) {
      element = createElement(LayoutComponent, { children: element });
    }
  }
  const rscStream = renderToReadableStream(element, { onError: rscOnError });
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

function matchRoute(url, routes) {
  const pathname = url.split("?")[0];
  let normalizedUrl = pathname === "/" ? "/" : pathname.replace(/\\/$/, "");
  try { normalizedUrl = decodeURIComponent(normalizedUrl); } catch {}
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
  // Next.js always injects charset and default viewport even when no metadata/viewport
  // is exported. We replicate that by always emitting these essential head elements.
  {
    const headElements = [];
    // Always emit <meta charset="utf-8"> — Next.js includes this on every page
    headElements.push(createElement("meta", { charSet: "utf-8" }));
    if (resolvedMetadata) headElements.push(createElement(MetadataHead, { metadata: resolvedMetadata }));
    // Default viewport to standard responsive settings when none is exported
    const effectiveViewport = resolvedViewport ?? { width: "device-width", initialScale: 1 };
    headElements.push(createElement(ViewportHead, { viewport: effectiveViewport }));
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

${middlewarePath ? generateMiddlewareMatcherCode("modern") : ""}

const __basePath = ${JSON.stringify(bp)};
const __trailingSlash = ${JSON.stringify(ts)};
const __configRedirects = ${JSON.stringify(redirects)};
const __configRewrites = ${JSON.stringify(rewrites)};
const __configHeaders = ${JSON.stringify(headers)};
const __allowedOrigins = ${JSON.stringify(allowedOrigins)};

${generateDevOriginCheckCode(config?.allowedDevOrigins)}

// ── CSRF origin validation for server actions ───────────────────────────
// Matches Next.js behavior: compare the Origin header against the Host header.
// If they don't match, the request is rejected with 403 unless the origin is
// in the allowedOrigins list (from experimental.serverActions.allowedOrigins).
function __isOriginAllowed(origin, allowed) {
  for (const pattern of allowed) {
    if (pattern.startsWith("*.")) {
      // Wildcard: *.example.com matches sub.example.com, a.b.example.com
      const suffix = pattern.slice(1); // ".example.com"
      if (origin === pattern.slice(2) || origin.endsWith(suffix)) return true;
    } else if (origin === pattern) {
      return true;
    }
  }
  return false;
}

function __validateCsrfOrigin(request) {
  const originHeader = request.headers.get("origin");
  // If there's no Origin header, allow the request — same-origin requests
  // from non-fetch navigations (e.g. SSR) may lack an Origin header.
  // The x-rsc-action custom header already provides protection against simple
  // form-based CSRF since custom headers can't be set by cross-origin forms.
  if (!originHeader || originHeader === "null") return null;

  let originHost;
  try {
    originHost = new URL(originHeader).host.toLowerCase();
  } catch {
    return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
  }

  // Only use the Host header for origin comparison — never trust
  // X-Forwarded-Host here, since it can be freely set by the client
  // and would allow the check to be bypassed if it matched a spoofed
  // Origin. The prod server's resolveHost() handles trusted proxy
  // scenarios separately.
  const hostHeader = (
    request.headers.get("host") ||
    ""
  ).split(",")[0].trim().toLowerCase();

  if (!hostHeader) return null;

  // Same origin — allow
  if (originHost === hostHeader) return null;

  // Check allowedOrigins from next.config.js
  if (__allowedOrigins.length > 0 && __isOriginAllowed(originHost, __allowedOrigins)) return null;

  console.warn(
    \`[vinext] CSRF origin mismatch: origin "\${originHost}" does not match host "\${hostHeader}". Blocking server action request.\`
  );
  return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
}

// ── ReDoS-safe regex compilation ────────────────────────────────────────
${generateSafeRegExpCode("modern")}

// ── Path normalization ──────────────────────────────────────────────────
${generateNormalizePathCode("modern")}

// ── Config pattern matching (redirects, rewrites, headers) ──────────────
function __matchConfigPattern(pathname, pattern) {
  if (pattern.includes("(") || pattern.includes("\\\\") || /:\\w+[*+][^/]/.test(pattern)) {
    try {
      const paramNames = [];
      const regexStr = pattern
        .replace(/\\./g, "\\\\.")
        .replace(/:([a-zA-Z_]\\w*)\\*(?:\\(([^)]+)\\))?/g, (_, name, c) => { paramNames.push(name); return c ? "(" + c + ")" : "(.*)"; })
        .replace(/:([a-zA-Z_]\\w*)\\+(?:\\(([^)]+)\\))?/g, (_, name, c) => { paramNames.push(name); return c ? "(" + c + ")" : "(.+)"; })
        .replace(/:([a-zA-Z_]\\w*)\\(([^)]+)\\)/g, (_, name, c) => { paramNames.push(name); return "(" + c + ")"; })
        .replace(/:([a-zA-Z_]\\w*)/g, (_, name) => { paramNames.push(name); return "([^/]+)"; });
      const re = __safeRegExp("^" + regexStr + "$");
      if (!re) return null;
      const match = re.exec(pathname);
      if (!match) return null;
      const params = Object.create(null);
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
    let restValue = rest.startsWith("/") ? rest.slice(1) : rest;
    try { restValue = decodeURIComponent(restValue); } catch {}
    return { [paramName]: restValue };
  }
  const parts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (parts.length !== pathParts.length) return null;
  const params = Object.create(null);
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
      if (condition.value !== undefined) { const re = __safeRegExp(condition.value); return re ? re.test(v) : v === condition.value; }
      return true;
    }
    case "cookie": {
      const v = ctx.cookies[condition.key];
      if (v === undefined) return false;
      if (condition.value !== undefined) { const re = __safeRegExp(condition.value); return re ? re.test(v) : v === condition.value; }
      return true;
    }
    case "query": {
      const v = ctx.query.get(condition.key);
      if (v === null) return false;
      if (condition.value !== undefined) { const re = __safeRegExp(condition.value); return re ? re.test(v) : v === condition.value; }
      return true;
    }
    case "host": {
      if (condition.value !== undefined) { const re = __safeRegExp(condition.value); return re ? re.test(ctx.host) : ctx.host === condition.value; }
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

function __sanitizeDestination(dest) {
  if (dest.startsWith("http://") || dest.startsWith("https://")) return dest;
  dest = dest.replace(/^[\\\\/]+/, "/");
  return dest;
}

function __applyConfigRedirects(pathname, ctx) {
  for (const rule of __configRedirects) {
    const params = __matchConfigPattern(pathname, rule.source);
    if (params) {
      if (ctx && (rule.has || rule.missing)) { if (!__checkHasConditions(rule.has, rule.missing, ctx)) continue; }
      let dest = rule.destination;
      for (const [key, value] of Object.entries(params)) { dest = dest.replace(":" + key + "*", value); dest = dest.replace(":" + key + "+", value); dest = dest.replace(":" + key, value); }
      dest = __sanitizeDestination(dest);
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
      for (const [key, value] of Object.entries(params)) { dest = dest.replace(":" + key + "*", value); dest = dest.replace(":" + key + "+", value); dest = dest.replace(":" + key, value); }
      dest = __sanitizeDestination(dest);
      return dest;
    }
  }
  return null;
}

function __isExternalUrl(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}

/**
 * Maximum server-action request body size (1 MB).
 * Matches the Next.js default for serverActions.bodySizeLimit.
 * @see https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions#bodysizelimit
 * Prevents unbounded request body buffering.
 */
var __MAX_ACTION_BODY_SIZE = 1 * 1024 * 1024;

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

const __hopByHopHeaders = new Set(["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailers","transfer-encoding","upgrade"]);

async function __proxyExternalRequest(request, externalUrl) {
  const originalUrl = new URL(request.url);
  const targetUrl = new URL(externalUrl);
  for (const [key, value] of originalUrl.searchParams) {
    if (!targetUrl.searchParams.has(key)) targetUrl.searchParams.set(key, value);
  }
  const headers = new Headers(request.headers);
  headers.set("host", targetUrl.host);
  headers.delete("connection");
  // Strip credentials and internal headers to prevent leaking auth tokens,
  // session cookies, and middleware internals to third-party origins.
  headers.delete("cookie");
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("proxy-authorization");
  for (const key of [...headers.keys()]) {
    if (key.startsWith("x-middleware-")) headers.delete(key);
  }
  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  const init = { method, headers, redirect: "manual", signal: AbortSignal.timeout(30000) };
  if (hasBody && request.body) { init.body = request.body; init.duplex = "half"; }
  let upstream;
  try { upstream = await fetch(targetUrl.href, init); }
  catch (e) {
    if (e && e.name === "TimeoutError") return new Response("Gateway Timeout", { status: 504 });
    console.error("[vinext] External rewrite proxy error:", e); return new Response("Bad Gateway", { status: 502 });
  }
  const respHeaders = new Headers();
  upstream.headers.forEach(function(value, key) { if (!__hopByHopHeaders.has(key.toLowerCase())) respHeaders.append(key, value); });
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
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
    const sourceRegex = __safeRegExp("^" + escaped + "$");
    if (sourceRegex && sourceRegex.test(pathname)) result.push(...rule.headers);
  }
  return result;
}

export default async function handler(request) {
  // Wrap the entire request in nested AsyncLocalStorage.run() scopes to ensure
  // per-request isolation for all state modules. Each runWith*() creates an
  // ALS scope that propagates through all async continuations (including RSC
  // streaming), preventing state leakage between concurrent requests on
  // Cloudflare Workers and other concurrent runtimes.
  const headersCtx = headersContextFromRequest(request);
  return runWithHeadersContext(headersCtx, () =>
    _runWithNavigationContext(() =>
      _runWithCacheState(() =>
        _runWithPrivateCache(() =>
          runWithFetchCache(async () => {
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
          })
        )
      )
    )
  );
}

async function _handleRequest(request) {
  const url = new URL(request.url);

  // ── Cross-origin request protection ─────────────────────────────────
  // Block requests from non-localhost origins to prevent data exfiltration.
  const __originBlock = __validateDevRequestOrigin(request);
  if (__originBlock) return __originBlock;

  // Guard against protocol-relative URL open redirects.
  // Paths like //example.com/ would be redirected to //example.com by the
  // trailing-slash normalizer, which browsers interpret as http://example.com.
  // Backslashes are equivalent to forward slashes in the URL spec
  // (e.g. /\\evil.com is treated as //evil.com by browsers and the URL constructor).
  // Next.js returns 404 for these paths. Check the RAW pathname before
  // normalization so the guard fires before normalizePath collapses //.
  if (url.pathname.replaceAll("\\\\", "/").startsWith("//")) {
    return new Response("404 Not Found", { status: 404 });
  }

  // Decode percent-encoding and normalize pathname to canonical form.
  // decodeURIComponent prevents /%61dmin from bypassing /admin matchers.
  // __normalizePath collapses //foo///bar → /foo/bar, resolves . and .. segments.
  let decodedUrlPathname;
  try { decodedUrlPathname = decodeURIComponent(url.pathname); } catch (e) {
    return new Response("Bad Request", { status: 400 });
  }
  let pathname = __normalizePath(decodedUrlPathname);

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
      const __redirDest = __sanitizeDestination(
        __basePath && !__redir.destination.startsWith(__basePath)
          ? __basePath + __redir.destination
          : __redir.destination
      );
      return new Response(null, {
        status: __redir.permanent ? 308 : 307,
        headers: { Location: __redirDest },
      });
    }
  }

  // ── Apply beforeFiles rewrites from next.config.js ────────────────────
  if (__configRewrites.beforeFiles && __configRewrites.beforeFiles.length) {
    const __rewritten = __applyConfigRewrites(pathname, __configRewrites.beforeFiles, __reqCtx);
    if (__rewritten) {
      if (__isExternalUrl(__rewritten)) {
        setHeadersContext(null);
        setNavigationContext(null);
        return __proxyExternalRequest(request, __rewritten);
      }
      pathname = __rewritten;
    }
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
  if (typeof middlewareFn === "function" && matchesMiddleware(cleanPathname, middlewareMatcher)) {
    try {
      // Wrap in NextRequest so middleware gets .nextUrl, .cookies, .geo, .ip, etc.
      // Strip .rsc suffix from the URL — it's an internal transport detail that
      // middleware should never see (matches Next.js behavior).
      let mwRequest = request;
      if (isRscRequest && pathname.endsWith(".rsc")) {
        const mwUrl = new URL(request.url);
        mwUrl.pathname = cleanPathname;
        mwRequest = new Request(mwUrl, request);
      }
      const nextRequest = mwRequest instanceof NextRequest ? mwRequest : new NextRequest(mwRequest);
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
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // Unpack x-middleware-request-* headers into the request context so that
  // headers() returns the middleware-modified headers instead of the original
  // request headers. Strip ALL x-middleware-* headers from the set that will
  // be merged into the outgoing HTTP response — this prefix is reserved for
  // internal routing signals and must never reach clients.
  if (_middlewareResponseHeaders) {
    applyMiddlewareRequestHeaders(_middlewareResponseHeaders);
    for (const key of [..._middlewareResponseHeaders.keys()]) {
      if (key.startsWith("x-middleware-")) {
        _middlewareResponseHeaders.delete(key);
      }
    }
  }
  ` : ""}

  // ── Image optimization passthrough (dev mode — no transformation) ───────
  if (cleanPathname === "/_vinext/image") {
    const __rawImgUrl = url.searchParams.get("url");
    // Normalize backslashes: browsers and the URL constructor treat
    // /\\evil.com as protocol-relative (//evil.com), bypassing the // check.
    const __imgUrl = __rawImgUrl?.replaceAll("\\\\", "/") ?? null;
    // Allowlist: must start with "/" but not "//" — blocks absolute URLs,
    // protocol-relative, backslash variants, and exotic schemes.
    if (!__imgUrl || !__imgUrl.startsWith("/") || __imgUrl.startsWith("//")) {
      return new Response(!__rawImgUrl ? "Missing url parameter" : "Only relative URLs allowed", { status: 400 });
    }
    // Validate the constructed URL's origin hasn't changed (defense in depth).
    const __resolvedImg = new URL(__imgUrl, request.url);
    if (__resolvedImg.origin !== url.origin) {
      return new Response("Only relative URLs allowed", { status: 400 });
    }
    // In dev, redirect to the original asset URL so Vite's static serving handles it.
    return Response.redirect(__resolvedImg.href, 302);
  }

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
    // ── CSRF protection ─────────────────────────────────────────────────
    // Verify that the Origin header matches the Host header to prevent
    // cross-site request forgery, matching Next.js server action behavior.
    const csrfResponse = __validateCsrfOrigin(request);
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
      ).catch(() => {});
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
    const __afterRewritten = __applyConfigRewrites(cleanPathname, __configRewrites.afterFiles, __reqCtx);
    if (__afterRewritten) {
      if (__isExternalUrl(__afterRewritten)) {
        setHeadersContext(null);
        setNavigationContext(null);
        return __proxyExternalRequest(request, __afterRewritten);
      }
      cleanPathname = __afterRewritten;
    }
  }

  let match = matchRoute(cleanPathname, routes);

  // ── Fallback rewrites from next.config.js (if no route matched) ───────
  if (!match && __configRewrites.fallback && __configRewrites.fallback.length) {
    const __fallbackRewritten = __applyConfigRewrites(cleanPathname, __configRewrites.fallback, __reqCtx);
    if (__fallbackRewritten) {
      if (__isExternalUrl(__fallbackRewritten)) {
        setHeadersContext(null);
        setNavigationContext(null);
        return __proxyExternalRequest(request, __fallbackRewritten);
      }
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
            const redirectUrl = decodeURIComponent(parts[2]);
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

  // force-dynamic: set no-store Cache-Control
  const isForceDynamic = dynamicConfig === "force-dynamic";

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
        const redirectUrl = decodeURIComponent(parts[2]);
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
  // trigger "Invalid hook call" console.error in dev. Suppress that expected warning.
  const _hasLoadingBoundary = !!(route.loading && route.loading.default);
  const _origConsoleError = console.error;
  console.error = (...args) => {
    if (typeof args[0] === "string" && args[0].includes("Invalid hook call")) return;
    _origConsoleError.apply(console, args);
  };
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
  } finally {
    console.error = _origConsoleError;
  }

  // Render to RSC stream
  const rscStream = renderToReadableStream(element, { onError: rscOnError });

  if (isRscRequest) {
    // Direct RSC stream response (for client-side navigation)
    // NOTE: Do NOT clear headers/navigation context here!
    // The RSC stream is consumed lazily - components render when chunks are read.
    // If we clear context now, headers()/cookies() will fail during rendering.
    // Context will be cleared when the next request starts (via runWithHeadersContext).
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
    } else if (revalidateSeconds) {
      responseHeaders["Cache-Control"] = "s-maxage=" + revalidateSeconds + ", stale-while-revalidate";
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

  // Helper to attach draftMode cookie, middleware headers, font Link header, and rewrite status to a response
  function attachMiddlewareContext(response) {
    if (draftCookie) {
      response.headers.append("Set-Cookie", draftCookie);
    }
    // Set HTTP Link header for font preloading
    if (fontLinkHeader) {
      response.headers.set("Link", fontLinkHeader);
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
  // dynamic='error' should have already thrown (via throwing Proxy) if user
  // code accessed dynamic APIs, so reaching here means rendering succeeded.
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

  // Emit Cache-Control for ISR pages so tests can verify revalidate values,
  // but skip actual caching in dev — every request renders fresh.
  if (revalidateSeconds !== null && revalidateSeconds > 0) {
    return attachMiddlewareContext(new Response(htmlStream, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "s-maxage=" + revalidateSeconds + ", stale-while-revalidate",
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
import { runWithNavigationContext as _runWithNavCtx } from "vinext/navigation-state";
import { safeJsonStringify } from "vinext/html";

/**
 * Collect all chunks from a ReadableStream into an array of text strings.
 * Used to capture the RSC payload for embedding in HTML.
 * The RSC flight protocol is text-based (line-delimited key:value pairs),
 * so we decode to text strings instead of byte arrays — this is dramatically
 * more compact when JSON-serialized into inline <script> tags.
 */
async function collectStreamChunks(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // Decode Uint8Array to text string for compact JSON serialization
    chunks.push(decoder.decode(value, { stream: true }));
  }
  return chunks;
}

/**
 * Create a TransformStream that appends RSC chunks as inline <script> tags
 * to the HTML stream. This allows progressive hydration — the browser receives
 * RSC data incrementally as Suspense boundaries resolve, rather than waiting
 * for the entire RSC payload before hydration can begin.
 *
 * Each chunk is written as:
 *   <script>self.__VINEXT_RSC_CHUNKS__=self.__VINEXT_RSC_CHUNKS__||[];self.__VINEXT_RSC_CHUNKS__.push("...")</script>
 *
 * Chunks are embedded as text strings (not byte arrays) since the RSC flight
 * protocol is text-based. The browser entry encodes them back to Uint8Array.
 * This is ~3x more compact than the previous byte-array format.
 */
function createRscEmbedTransform(embedStream) {
  const reader = embedStream.getReader();
  const _decoder = new TextDecoder();
  let done = false;
  let pendingChunks = [];
  let reading = false;

  // Fix invalid preload "as" values in RSC Flight hint lines before
  // they reach the client. React Flight emits HL hints with
  // as="stylesheet" for CSS, but the HTML spec requires as="style"
  // for <link rel="preload">. The fixPreloadAs() below only fixes the
  // server-rendered HTML stream; this fixes the raw Flight data that
  // gets embedded as __VINEXT_RSC_CHUNKS__ and processed client-side.
  function fixFlightHints(text) {
    // Flight hint format: <id>:HL["url","stylesheet"] or with options
    return text.replace(/(\\d+:HL\\[.*?),"stylesheet"(\\]|,)/g, '$1,"style"$2');
  }

  // Start reading RSC chunks in the background, accumulating them as text strings.
  // The RSC flight protocol is text-based, so decoding to strings and embedding
  // as JSON strings is ~3x more compact than the byte-array format.
  async function pumpReader() {
    if (reading) return;
    reading = true;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          done = true;
          break;
        }
        const text = _decoder.decode(result.value, { stream: true });
        pendingChunks.push(fixFlightHints(text));
      }
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[vinext] RSC embed stream read error:", err);
      }
      done = true;
    }
    reading = false;
  }

  // Fire off the background reader immediately
  const pumpPromise = pumpReader();

  return {
    /**
     * Flush any accumulated RSC chunks as <script> tags.
     * Called after each HTML chunk is enqueued.
     */
    flush() {
      if (pendingChunks.length === 0) return "";
      const chunks = pendingChunks;
      pendingChunks = [];
      let scripts = "";
      for (const chunk of chunks) {
        scripts += "<script>self.__VINEXT_RSC_CHUNKS__=self.__VINEXT_RSC_CHUNKS__||[];self.__VINEXT_RSC_CHUNKS__.push(" + safeJsonStringify(chunk) + ")</script>";
      }
      return scripts;
    },

    /**
     * Wait for the RSC stream to fully complete and return any final
     * script tags plus the closing signal.
     */
    async finalize() {
      await pumpPromise;
      let scripts = this.flush();
      // Signal that all RSC chunks have been sent.
      // Params are already embedded in <head> — no need to include here.
      scripts += "<script>self.__VINEXT_RSC_DONE__=true</script>";
      return scripts;
    },
  };
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
  // Wrap in a navigation ALS scope for per-request isolation in the SSR
  // environment. The SSR environment has separate module instances from RSC,
  // so it needs its own ALS scope.
  return _runWithNavCtx(async () => {
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

    // Create the progressive RSC embed helper — it reads the embed stream
    // in the background and provides script tags to inject into the HTML stream.
    const rscEmbed = createRscEmbedTransform(embedStream);

    // Deserialize RSC stream back to React VDOM.
    // IMPORTANT: Do NOT await this — createFromReadableStream returns a thenable
    // that React's renderToReadableStream can consume progressively. By passing
    // the unresolved thenable, React will render Suspense fallbacks (loading.tsx)
    // immediately in the HTML shell, then stream in resolved content as RSC
    // chunks arrive. Awaiting here would block until all async server components
    // complete, collapsing the streaming behavior.
    const root = createFromReadableStream(ssrStream);

    // Get the bootstrap script content for the browser entry
    const bootstrapScriptContent =
      await import.meta.viteRsc.loadBootstrapScriptContent("index");

    // djb2 hash for digest generation in the SSR environment.
    // Matches the RSC environment's __errorDigest function.
    function ssrErrorDigest(str) {
      let hash = 5381;
      for (let i = str.length - 1; i >= 0; i--) {
        hash = (hash * 33) ^ str.charCodeAt(i);
      }
      return (hash >>> 0).toString();
    }

    // Render HTML (streaming SSR)
    // useServerInsertedHTML callbacks are registered during this render.
    // The onError callback preserves the digest for Next.js navigation errors
    // (redirect, notFound, forbidden, unauthorized) thrown inside Suspense
    // boundaries during RSC streaming. Without this, React's default onError
    // returns undefined and the digest is lost in the $RX() call, preventing
    // client-side error boundaries from identifying the error type.
    // In production, non-navigation errors also get a digest hash so they
    // can be correlated with server logs without leaking details to clients.
    const htmlStream = await renderToReadableStream(root, {
      bootstrapScriptContent,
      onError(error) {
        if (error && typeof error === "object" && "digest" in error) {
          return String(error.digest);
        }
        // In production, generate a digest hash for non-navigation errors
        if (process.env.NODE_ENV === "production" && error) {
          const msg = error instanceof Error ? error.message : String(error);
          const stack = error instanceof Error ? (error.stack || "") : "";
          return ssrErrorDigest(msg + stack);
        }
        return undefined;
      },
    });


    // Flush useServerInsertedHTML callbacks (CSS-in-JS style injection)
    const insertedElements = flushServerInsertedHTML();

    // Render the inserted elements to HTML strings
    const { renderToStaticMarkup } = await import("react-dom/server.edge");
    const { createElement, Fragment } = await import("react");
    let insertedHTML = "";
    for (const el of insertedElements) {
      try {
        insertedHTML += renderToStaticMarkup(createElement(Fragment, null, el));
      } catch {
        // Skip elements that can't be rendered
      }
    }

    // Escape HTML attribute values (defense-in-depth for font URLs/types).
    function _escAttr(s) { return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }

    // Build font HTML from data passed from RSC environment
    // (Fonts are loaded during RSC rendering, and RSC/SSR are separate module instances)
    let fontHTML = "";
    if (fontData) {
      if (fontData.links && fontData.links.length > 0) {
        for (const url of fontData.links) {
          fontHTML += '<link rel="stylesheet" href="' + _escAttr(url) + '" />\\n';
        }
      }
      // Emit <link rel="preload"> for local font files
      if (fontData.preloads && fontData.preloads.length > 0) {
        for (const preload of fontData.preloads) {
          fontHTML += '<link rel="preload" href="' + _escAttr(preload.href) + '" as="font" type="' + _escAttr(preload.type) + '" crossorigin />\\n';
        }
      }
      if (fontData.styles && fontData.styles.length > 0) {
        fontHTML += '<style data-vinext-fonts>' + fontData.styles.join("\\n") + '</style>\\n';
      }
    }

    // Extract client entry module URL from bootstrapScriptContent to emit
    // a <link rel="modulepreload"> hint. The RSC plugin formats bootstrap
    // content as: import("URL") — we extract the URL so the browser can
    // speculatively fetch and parse the JS module while still processing
    // the HTML body, instead of waiting until it reaches the inline script.
    let modulePreloadHTML = "";
    if (bootstrapScriptContent) {
      const m = bootstrapScriptContent.match(/import\\("([^"]+)"\\)/);
      if (m && m[1]) {
        modulePreloadHTML = '<link rel="modulepreload" href="' + _escAttr(m[1]) + '" />\\n';
      }
    }

    // Head-injected HTML: server-inserted HTML, font HTML, route params,
    // and modulepreload hints.
    // RSC payload is now embedded progressively via script tags in the body stream.
    // Params are embedded eagerly in <head> so they're available before client
    // hydration starts, avoiding the need for polling on the client.
    const paramsScript = '<script>self.__VINEXT_RSC_PARAMS__=' + safeJsonStringify(navContext?.params || {}) + '</script>';
    const injectHTML = paramsScript + modulePreloadHTML + insertedHTML + fontHTML;

    // Inject the collected HTML before </head> and progressively embed RSC
    // chunks as script tags throughout the HTML body stream.
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let injected = false;

    // Fix invalid preload "as" values in server-rendered HTML.
    // React Fizz emits <link rel="preload" as="stylesheet"> for CSS,
    // but the HTML spec requires as="style" for <link rel="preload">.
    // Note: fixFlightHints() in createRscEmbedTransform handles the
    // complementary case — fixing the raw Flight stream data before
    // it's embedded as __VINEXT_RSC_CHUNKS__ for client-side processing.
    // See: https://html.spec.whatwg.org/multipage/links.html#link-type-preload
    function fixPreloadAs(html) {
      // Match <link ...rel="preload"... as="stylesheet"...> in any attribute order
      return html.replace(/<link(?=[^>]*\\srel="preload")[^>]*>/g, function(tag) {
        return tag.replace(' as="stylesheet"', ' as="style"');
      });
    }

    // Tick-buffered RSC script injection.
    //
    // React's renderToReadableStream (Fizz) flushes chunks synchronously
    // within one microtask — all chunks from a single flushCompletedQueues
    // call arrive in the same macrotask. We buffer HTML chunks as they
    // arrive, then use setTimeout(0) to defer emitting them plus any
    // accumulated RSC scripts to the next macrotask. This guarantees we
    // never inject <script> tags between partial HTML chunks (which would
    // corrupt split elements like "<linearGradi" + "ent>"), while still
    // delivering RSC data progressively as Suspense boundaries resolve.
    //
    // Reference: rsc-html-stream by Devon Govett (credited by Next.js)
    // https://github.com/devongovett/rsc-html-stream
    let buffered = [];
    let timeoutId = null;

    const transform = new TransformStream({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });
        const fixed = fixPreloadAs(text);
        buffered.push(fixed);

        if (timeoutId !== null) return;

        timeoutId = setTimeout(() => {
          // Flush all buffered HTML chunks from this React flush cycle
          for (const buf of buffered) {
            if (!injected) {
              const headEnd = buf.indexOf("</head>");
              if (headEnd !== -1) {
                const before = buf.slice(0, headEnd);
                const after = buf.slice(headEnd);
                controller.enqueue(encoder.encode(before + injectHTML + after));
                injected = true;
                continue;
              }
            }
            controller.enqueue(encoder.encode(buf));
          }
          buffered = [];

          // Now safe to inject any accumulated RSC scripts — we're between
          // React flush cycles, so no partial HTML chunks can follow until
          // the next macrotask.
          const rscScripts = rscEmbed.flush();
          if (rscScripts) {
            controller.enqueue(encoder.encode(rscScripts));
          }

          timeoutId = null;
        }, 0);
      },
      async flush(controller) {
        // Cancel any pending setTimeout callback — flush() drains
        // everything itself, so the callback would be a no-op but
        // cancelling makes the code obviously correct.
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        // Flush any remaining buffered HTML chunks
        for (const buf of buffered) {
          if (!injected) {
            const headEnd = buf.indexOf("</head>");
            if (headEnd !== -1) {
              const before = buf.slice(0, headEnd);
              const after = buf.slice(headEnd);
              controller.enqueue(encoder.encode(before + injectHTML + after));
              injected = true;
              continue;
            }
          }
          controller.enqueue(encoder.encode(buf));
        }
        buffered = [];

        if (!injected && injectHTML) {
          controller.enqueue(encoder.encode(injectHTML));
        }
        // Finalize: wait for the RSC stream to complete and emit remaining
        // chunks plus the __VINEXT_RSC_DONE__ signal.
        const finalScripts = await rscEmbed.finalize();
        if (finalScripts) {
          controller.enqueue(encoder.encode(finalScripts));
        }
      },
    });

    return htmlStream.pipeThrough(transform);
  } finally {
    // Clean up so we don't leak context between requests
    setNavigationContext(null);
    clearServerInsertedHTML();
  }
  }); // end _runWithNavCtx
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
import { flushSync } from "react-dom";
import { setClientParams, toRscUrl, getPrefetchCache, getPrefetchedUrls, PREFETCH_CACHE_TTL } from "next/navigation";

let reactRoot;

/**
 * Convert the embedded RSC chunks back to a ReadableStream.
 * Each chunk is a text string that needs to be encoded back to Uint8Array.
 */
function chunksToReadableStream(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
}

/**
 * Create a ReadableStream from progressively-embedded RSC chunks.
 * The server injects RSC data as <script> tags that push to
 * self.__VINEXT_RSC_CHUNKS__ throughout the HTML stream, and sets
 * self.__VINEXT_RSC_DONE__ = true when complete.
 *
 * Instead of polling with setTimeout, we monkey-patch the array's
 * push() method so new chunks are delivered immediately when the
 * server's <script> tags execute. This eliminates unnecessary
 * wakeups and reduces latency — same pattern Next.js uses with
 * __next_f. The stream closes on DOMContentLoaded (when all
 * server-injected scripts have executed) or when __VINEXT_RSC_DONE__
 * is set, whichever comes first.
 */
function createProgressiveRscStream() {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const chunks = self.__VINEXT_RSC_CHUNKS__ || [];

      // Deliver any chunks that arrived before this code ran
      // (from <script> tags that executed before the browser entry loaded)
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }

      // If the stream is already complete, close immediately
      if (self.__VINEXT_RSC_DONE__) {
        controller.close();
        return;
      }

      // Monkey-patch push() so future chunks stream in immediately
      // when the server's <script> tags execute
      let closed = false;
      function closeOnce() {
        if (!closed) {
          closed = true;
          controller.close();
        }
      }

      const arr = self.__VINEXT_RSC_CHUNKS__ = self.__VINEXT_RSC_CHUNKS__ || [];
      arr.push = function(chunk) {
        Array.prototype.push.call(this, chunk);
        if (!closed) {
          controller.enqueue(encoder.encode(chunk));
          if (self.__VINEXT_RSC_DONE__) {
            closeOnce();
          }
        }
        return this.length;
      };

      // Safety net: if the server crashes mid-stream and __VINEXT_RSC_DONE__
      // never arrives, close the stream when all server-injected scripts
      // have executed (DOMContentLoaded). Without this, a truncated response
      // leaves the ReadableStream open forever, hanging hydration.
      if (typeof document !== "undefined") {
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", closeOnce);
        } else {
          // Document already loaded — close immediately if not already done
          closeOnce();
        }
      }
    }
  });
}

// Register the server action callback — React calls this internally
// when a "use server" function is invoked from client code.
setServerCallback(async (id, args) => {
  const temporaryReferences = createTemporaryReferenceSet();
  const body = await encodeReply(args, { temporaryReferences });

  const fetchResponse = await fetch(toRscUrl(window.location.pathname + window.location.search), {
    method: "POST",
    headers: { "x-rsc-action": id },
    body,
  });

  // Check for redirect signal from server action that called redirect()
  const actionRedirect = fetchResponse.headers.get("x-action-redirect");
  if (actionRedirect) {
    // External URLs (different origin) need a hard redirect — client-side
    // RSC navigation only works for same-origin paths.
    try {
      const redirectUrl = new URL(actionRedirect, window.location.origin);
      if (redirectUrl.origin !== window.location.origin) {
        window.location.href = actionRedirect;
        return undefined;
      }
    } catch {
      // If URL parsing fails, fall through to client-side navigation
    }

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
  //
  // The server embeds RSC chunks progressively as <script> tags that push
  // to self.__VINEXT_RSC_CHUNKS__. When complete, self.__VINEXT_RSC_DONE__
  // is set and self.__VINEXT_RSC_PARAMS__ contains route params.
  // For backwards compat, also check the legacy self.__VINEXT_RSC__ format.
  if (self.__VINEXT_RSC_CHUNKS__ || self.__VINEXT_RSC_DONE__ || self.__VINEXT_RSC__) {
    if (self.__VINEXT_RSC__) {
      // Legacy format: single object with all chunks
      const embedData = self.__VINEXT_RSC__;
      delete self.__VINEXT_RSC__;
      if (embedData.params) {
        setClientParams(embedData.params);
      }
      rscStream = chunksToReadableStream(embedData.rsc);
    } else {
      // Progressive format: chunks arrive incrementally via script tags.
      // Params are embedded in <head> so they're always available by this point.
      if (self.__VINEXT_RSC_PARAMS__) {
        setClientParams(self.__VINEXT_RSC_PARAMS__);
      }
      rscStream = createProgressiveRscStream();
    }
  } else {
    // Fallback: fetch fresh RSC (shouldn't happen on initial page load)
    const rscResponse = await fetch(toRscUrl(window.location.pathname + window.location.search));

    // Hydrate useParams() with route params from the server before React hydration
    const paramsHeader = rscResponse.headers.get("X-Vinext-Params");
    if (paramsHeader) {
      try { setClientParams(JSON.parse(paramsHeader)); } catch (_e) { /* ignore */ }
    }

    rscStream = rscResponse.body;
  }

  const root = await createFromReadableStream(rscStream);

  // Hydrate the document
  // In development, suppress Vite's error overlay for errors caught by React error
  // boundaries. Without this, React re-throws caught errors to the global handler,
  // which triggers Vite's overlay even though the error was handled by an error.tsx.
  // In production, preserve React's default onCaughtError (console.error) so
  // boundary-caught errors remain visible to error monitoring.
  reactRoot = hydrateRoot(document, root, import.meta.env.DEV ? {
    onCaughtError: function() {},
  } : undefined);

  // Store for client-side navigation
  window.__VINEXT_RSC_ROOT__ = reactRoot;

  // Client-side navigation handler
  // Checks the prefetch cache (populated by <Link> IntersectionObserver and
  // router.prefetch()) before making a network request. This makes navigation
  // near-instant for prefetched routes.
  window.__VINEXT_RSC_NAVIGATE__ = async function navigateRsc(href) {
    try {
      const url = new URL(href, window.location.origin);
      const rscUrl = toRscUrl(url.pathname + url.search);

      // Check the in-memory prefetch cache first
      let navResponse;
      const prefetchCache = getPrefetchCache();
      const cached = prefetchCache.get(rscUrl);
      if (cached && (Date.now() - cached.timestamp) < PREFETCH_CACHE_TTL) {
        navResponse = cached.response;
        prefetchCache.delete(rscUrl); // Consume the cached entry (one-time use)
        getPrefetchedUrls().delete(rscUrl); // Allow re-prefetch when link is visible again
      } else if (cached) {
        prefetchCache.delete(rscUrl); // Expired, clean up
        getPrefetchedUrls().delete(rscUrl);
      }

      // Fallback to network fetch if not in cache
      if (!navResponse) {
        navResponse = await fetch(rscUrl, {
          headers: { Accept: "text/x-component" },
        });
      }

      // Update useParams() with route params from the server before re-rendering
      const navParamsHeader = navResponse.headers.get("X-Vinext-Params");
      if (navParamsHeader) {
        try { setClientParams(JSON.parse(navParamsHeader)); } catch (_e) { /* ignore */ }
      } else {
        setClientParams({});
      }

      const rscPayload = await createFromFetch(Promise.resolve(navResponse));
      // Use flushSync to guarantee React commits the new tree to the DOM
      // synchronously before this function returns. Callers scroll to top
      // after awaiting, so the new content must be painted first.
      flushSync(function () { reactRoot.render(rscPayload); });
    } catch (err) {
      console.error("[vinext] RSC navigation error:", err);
      // Fallback to full page load
      window.location.href = href;
    }
  };

  // Handle popstate (browser back/forward)
  // Store the navigation promise on a well-known property so that
  // restoreScrollPosition (in navigation.ts) can await it before scrolling.
  // This prevents a flash where the old content is visible at the restored
  // scroll position before the new RSC payload has rendered.
  window.addEventListener("popstate", () => {
    const p = window.__VINEXT_RSC_NAVIGATE__(window.location.href);
    window.__VINEXT_RSC_PENDING__ = p;
    p.finally(() => {
      // Clear once settled so stale promises aren't awaited later
      if (window.__VINEXT_RSC_PENDING__ === p) {
        window.__VINEXT_RSC_PENDING__ = null;
      }
    });
  });

  // HMR: re-render on server module updates
  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", async () => {
      try {
        const rscPayload = await createFromFetch(
          fetch(toRscUrl(window.location.pathname + window.location.search))
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
