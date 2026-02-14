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
): string {
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
    if (route.loadingPath) getImportVar(route.loadingPath);
    if (route.errorPath) getImportVar(route.errorPath);
    if (route.notFoundPath) getImportVar(route.notFoundPath);
  }

  // Build route table as serialized JS
  const routeEntries = routes.map((route) => {
    const layoutVars = route.layouts.map((l) => getImportVar(l));
    return `  {
    pattern: ${JSON.stringify(route.pattern)},
    isDynamic: ${route.isDynamic},
    params: ${JSON.stringify(route.params)},
    page: ${route.pagePath ? getImportVar(route.pagePath) : "null"},
    routeHandler: ${route.routePath ? getImportVar(route.routePath) : "null"},
    layouts: [${layoutVars.join(", ")}],
    loading: ${route.loadingPath ? getImportVar(route.loadingPath) : "null"},
    error: ${route.errorPath ? getImportVar(route.errorPath) : "null"},
    notFound: ${route.notFoundPath ? getImportVar(route.notFoundPath) : "null"},
  }`;
  });

  // Find root not-found page and root layouts for global 404 handling
  const rootRoute = routes.find((r) => r.pattern === "/");
  const rootNotFoundVar = rootRoute?.notFoundPath
    ? getImportVar(rootRoute.notFoundPath)
    : null;
  const rootLayoutVars = rootRoute
    ? rootRoute.layouts.map((l) => getImportVar(l))
    : [];

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
import { setNavigationContext } from "next/navigation";
import { setHeadersContext, headersContextFromRequest } from "next/headers";
import { ErrorBoundary } from "nextcompat/error-boundary";
import { MetadataHead, mergeMetadata, resolveModuleMetadata } from "nextcompat/metadata";
${middlewarePath ? `import * as middlewareModule from ${JSON.stringify(middlewarePath.replace(/\\/g, "/"))};` : ""}
${effectiveMetaRoutes.length > 0 ? `import { sitemapToXml, robotsToText, manifestToJson } from ${JSON.stringify(new URL("./metadata-routes.js", import.meta.url).pathname.replace(/\\/g, "/"))};` : ""}
import { getCacheHandler } from "next/cache";

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
function isrTriggerRegen(key, renderFn) {
  if (isrPendingRegens.has(key)) return;
  const promise = renderFn()
    .catch((err) => console.error("[nextcompat] ISR regen failed for " + key + ":", err))
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
const rootLayouts = [${rootLayoutVars.join(", ")}];

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

async function buildPageElement(route, params) {
  const PageComponent = route.page?.default;
  if (!PageComponent) {
    return createElement("div", null, "Page has no default export");
  }

  // Resolve metadata from layouts and page
  const metadataList = [];
  for (const layoutMod of route.layouts) {
    if (layoutMod) {
      const meta = await resolveModuleMetadata(layoutMod, params);
      if (meta) metadataList.push(meta);
    }
  }
  if (route.page) {
    const pageMeta = await resolveModuleMetadata(route.page, params);
    if (pageMeta) metadataList.push(pageMeta);
  }
  const resolvedMetadata = metadataList.length > 0 ? mergeMetadata(metadataList) : null;

  // Build nested layout tree from outermost to innermost
  let element = createElement(PageComponent, { params });

  // Add metadata head tags (React 19 hoists title/meta/link to <head>)
  if (resolvedMetadata) {
    element = createElement(Fragment, null,
      createElement(MetadataHead, { metadata: resolvedMetadata }),
      element,
    );
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

  // Wrap with layouts (innermost first, then outer)
  for (let i = route.layouts.length - 1; i >= 0; i--) {
    const LayoutComponent = route.layouts[i]?.default;
    if (LayoutComponent) {
      element = createElement(LayoutComponent, { children: element, params });
    }
  }

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

export default async function handler(request) {
  const url = new URL(request.url);
  let pathname = url.pathname;
  const isRscRequest = pathname.endsWith(".rsc") || request.headers.get("accept")?.includes("text/x-component");
  let cleanPathname = pathname.replace(/\\.rsc$/, "");

  ${middlewarePath ? `
  // Run middleware if present and path matches
  const middlewareFn = middlewareModule.default || middlewareModule.middleware;
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
      console.error("[nextcompat] Middleware error:", err);
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
            headers: { "Content-Type": metaRoute.contentType },
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
      try {
        const data = await action.apply(null, args);
        returnValue = { ok: true, data };
      } catch (e) {
        returnValue = { ok: false, data: e };
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
        element = buildPageElement(actionRoute, actionParams);
      } else {
        element = createElement("div", null, "Page not found");
      }

      const rscStream = renderToReadableStream(
        { root: element, returnValue },
        { temporaryReferences },
      );
      setHeadersContext(null);
      setNavigationContext(null);
      return new Response(rscStream, {
        headers: { "Content-Type": "text/x-component; charset=utf-8" },
      });
    } catch (err) {
      console.error("[nextcompat] Server action error:", err);
      setHeadersContext(null);
      setNavigationContext(null);
      return new Response("Server action failed: " + (err && err.message ? err.message : String(err)), { status: 500 });
    }
  }

  const match = matchRoute(cleanPathname, routes);

  if (!match) {
    // Render custom not-found page if available, otherwise plain 404
    if (rootNotFoundModule) {
      const NotFoundComponent = rootNotFoundModule.default;
      let element = createElement(NotFoundComponent);
      // Wrap in root layouts
      for (let i = rootLayouts.length - 1; i >= 0; i--) {
        const LayoutComponent = rootLayouts[i]?.default;
        if (LayoutComponent) {
          element = createElement(LayoutComponent, { children: element });
        }
      }
      const rscStream = renderToReadableStream(element);
      if (isRscRequest) {
        setHeadersContext(null);
        setNavigationContext(null);
        return new Response(rscStream, {
          status: 404,
          headers: { "Content-Type": "text/x-component; charset=utf-8" },
        });
      }
      const ssrEntry = await import.meta.viteRsc.loadModule("ssr", "index");
      const htmlStream = await ssrEntry.handleSsr(rscStream);
      setHeadersContext(null);
      setNavigationContext(null);
      return new Response(htmlStream, {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
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
    const handlerFn = handler[method] || handler["default"];
    if (typeof handlerFn === "function") {
      try {
        const response = await handlerFn(request);
        setHeadersContext(null);
        setNavigationContext(null);
        return response;
      } catch (err) {
        setHeadersContext(null);
        setNavigationContext(null);
        return new Response("Internal Server Error", { status: 500 });
      }
    }
    setHeadersContext(null);
    setNavigationContext(null);
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Build the component tree: layouts wrapping the page
  const PageComponent = route.page?.default;
  if (!PageComponent) {
    setHeadersContext(null);
    setNavigationContext(null);
    return new Response("Page has no default export", { status: 500 });
  }

  // Read ISR revalidate from route segment config (export const revalidate = N)
  const revalidateSeconds = typeof route.page?.revalidate === "number" ? route.page.revalidate : null;

  // ISR cache check for App Router pages with revalidate
  if (revalidateSeconds !== null && revalidateSeconds > 0) {
    const cacheKey = "app:" + (cleanPathname === "/" ? "/" : cleanPathname.replace(/\\/$/, ""));
    const cached = await isrGet(cacheKey);

    if (cached && cached.value.value && cached.value.value.kind === "APP_PAGE") {
      const cachedPage = cached.value.value;
      const cacheHeaders = {
        "X-Nextcompat-Cache": cached.isStale ? "STALE" : "HIT",
        "Cache-Control": cached.isStale
          ? "s-maxage=0, stale-while-revalidate"
          : "s-maxage=" + revalidateSeconds + ", stale-while-revalidate",
      };

      if (cached.isStale) {
        // Trigger background regeneration
        isrTriggerRegen(cacheKey, async function() {
          const freshElement = await buildPageElement(route, params);
          const freshRscStream = renderToReadableStream(freshElement);
          const ssrEntryFresh = await import.meta.viteRsc.loadModule("ssr", "index");
          const freshHtmlStream = await ssrEntryFresh.handleSsr(freshRscStream);
          // Consume the stream to get HTML string
          const freshHtml = await new Response(freshHtmlStream).text();
          await isrSet(cacheKey, { kind: "APP_PAGE", html: freshHtml, rscData: undefined, headers: undefined, postponed: undefined, status: undefined }, revalidateSeconds);
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

  const element = await buildPageElement(route, params);

  // Note: CSS is automatically injected by @vitejs/plugin-rsc's
  // rscCssTransform — no manual loadCss() call needed.

  // Render to RSC stream
  const rscStream = renderToReadableStream(element);

  if (isRscRequest) {
    // Direct RSC stream response (for client-side navigation)
    setHeadersContext(null);
    setNavigationContext(null);
    const responseHeaders = { "Content-Type": "text/x-component; charset=utf-8" };
    if (revalidateSeconds) {
      responseHeaders["Cache-Control"] = "s-maxage=" + revalidateSeconds + ", stale-while-revalidate";
      responseHeaders["X-Nextcompat-Cache"] = "MISS";
    }
    return new Response(rscStream, { headers: responseHeaders });
  }

  // Delegate to SSR environment for HTML rendering
  const ssrEntry = await import.meta.viteRsc.loadModule("ssr", "index");
  const htmlStream = await ssrEntry.handleSsr(rscStream);

  setHeadersContext(null);
  setNavigationContext(null);

  // If ISR is enabled, cache the rendered HTML
  if (revalidateSeconds !== null && revalidateSeconds > 0) {
    // We need to tee the stream: one for caching, one for the response
    const [cacheStream, responseStream] = htmlStream.tee();
    const cacheKey = "app:" + (cleanPathname === "/" ? "/" : cleanPathname.replace(/\\/$/, ""));
    // Cache in background
    new Response(cacheStream).text().then(function(html) {
      return isrSet(cacheKey, { kind: "APP_PAGE", html: html, rscData: undefined, headers: undefined, postponed: undefined, status: undefined }, revalidateSeconds);
    }).catch(function(err) {
      console.error("[nextcompat] ISR cache store failed:", err);
    });

    return new Response(responseStream, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "s-maxage=" + revalidateSeconds + ", stale-while-revalidate",
        "X-Nextcompat-Cache": "MISS",
      },
    });
  }

  return new Response(htmlStream, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
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

export async function handleSsr(rscStream) {
  // Deserialize RSC stream back to React VDOM
  const root = await createFromReadableStream(rscStream);

  // Get the bootstrap script content for the browser entry
  const bootstrapScriptContent =
    await import.meta.viteRsc.loadBootstrapScriptContent("index");

  // Render HTML (traditional SSR)
  const htmlStream = await renderToReadableStream(root, {
    bootstrapScriptContent,
  });

  return htmlStream;
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

let reactRoot;

// Register the server action callback — React calls this internally
// when a "use server" function is invoked from client code.
setServerCallback(async (id, args) => {
  const temporaryReferences = createTemporaryReferenceSet();
  const body = await encodeReply(args, { temporaryReferences });

  const response = fetch(window.location.pathname + ".rsc", {
    method: "POST",
    headers: { "x-rsc-action": id },
    body,
  });

  const result = await createFromFetch(response, { temporaryReferences });

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
  const rscResponse = await fetch(window.location.pathname + ".rsc");
  const root = await createFromReadableStream(rscResponse.body);

  // Hydrate the document
  reactRoot = hydrateRoot(document, root);

  // Store for client-side navigation
  window.__NEXTCOMPAT_RSC_ROOT__ = reactRoot;

  // Client-side navigation handler
  window.__NEXTCOMPAT_RSC_NAVIGATE__ = async function navigateRsc(href) {
    try {
      const url = new URL(href, window.location.origin);
      const rscPayload = await createFromFetch(
        fetch(url.pathname + ".rsc", {
          headers: { Accept: "text/x-component" },
        })
      );
      reactRoot.render(rscPayload);
    } catch (err) {
      console.error("[nextcompat] RSC navigation error:", err);
      // Fallback to full page load
      window.location.href = href;
    }
  };

  // Handle popstate (browser back/forward)
  window.addEventListener("popstate", () => {
    window.__NEXTCOMPAT_RSC_NAVIGATE__(window.location.href);
  });

  // HMR: re-render on server module updates
  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", async () => {
      try {
        const rscPayload = await createFromFetch(
          fetch(window.location.pathname + ".rsc")
        );
        reactRoot.render(rscPayload);
      } catch (err) {
        console.error("[nextcompat] RSC HMR error:", err);
      }
    });
  }
}

main();
`;
}
