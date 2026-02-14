/**
 * App Router dev server handler.
 *
 * This module generates virtual entry points for the RSC/SSR/browser
 * environments that @vitejs/plugin-rsc manages. The RSC entry does
 * route matching and renders the component tree, then delegates to
 * the SSR entry for HTML generation.
 */
import type { AppRoute } from "../routing/app-router.js";

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

  return `
import { renderToReadableStream } from "@vitejs/plugin-rsc/rsc";
import { createElement, Suspense, Fragment } from "react";
import { setNavigationContext } from "next/navigation";
import { setHeadersContext, headersContextFromRequest } from "next/headers";
import { ErrorBoundary } from "nextcompat/error-boundary";

${imports.join("\n")}

const routes = [
${routeEntries.join(",\n")}
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

export default async function handler(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const isRscRequest = url.pathname.endsWith(".rsc") || request.headers.get("accept")?.includes("text/x-component");
  const cleanPathname = pathname.replace(/\\.rsc$/, "");

  // Set request contexts for Server Components
  setHeadersContext(headersContextFromRequest(request));
  setNavigationContext({
    pathname: cleanPathname,
    searchParams: url.searchParams,
    params: {},
  });

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

  // Build nested layout tree from outermost to innermost
  let element = createElement(PageComponent, { params });

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

  // Note: CSS is automatically injected by @vitejs/plugin-rsc's
  // rscCssTransform — no manual loadCss() call needed.

  // Render to RSC stream
  const rscStream = renderToReadableStream(element);

  if (isRscRequest) {
    // Direct RSC stream response (for client-side navigation)
    setHeadersContext(null);
    setNavigationContext(null);
    return new Response(rscStream, {
      headers: { "Content-Type": "text/x-component; charset=utf-8" },
    });
  }

  // Delegate to SSR environment for HTML rendering
  const ssrEntry = await import.meta.viteRsc.loadModule("ssr", "index");
  const htmlStream = await ssrEntry.handleSsr(rscStream);

  setHeadersContext(null);
  setNavigationContext(null);

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
import { createFromReadableStream, createFromFetch } from "@vitejs/plugin-rsc/browser";
import { hydrateRoot } from "react-dom/client";

async function main() {
  // Initial hydration: fetch the RSC stream for the current page
  const rscResponse = await fetch(window.location.pathname + ".rsc");
  const root = await createFromReadableStream(rscResponse.body);

  // Hydrate the document
  const reactRoot = hydrateRoot(document, root);

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
