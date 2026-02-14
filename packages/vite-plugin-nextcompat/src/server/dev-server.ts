import type { ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route } from "../routing/pages-router.js";
import { matchRoute } from "../routing/pages-router.js";
import path from "node:path";
import React from "react";
import ReactDOMServer from "react-dom/server";

/**
 * Create an SSR request handler for the Pages Router.
 *
 * For each request:
 * 1. Match the URL against discovered routes
 * 2. Load the page module via Vite's SSR module loader
 * 3. Call getServerSideProps/getStaticProps if present
 * 4. Render the component to HTML
 * 5. Wrap in _document shell and send response
 */
export function createSSRHandler(
  server: ViteDevServer,
  routes: Route[],
  pagesDir: string,
) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<void> => {
    const match = matchRoute(url, routes);

    if (!match) {
      // No route matched — try to render custom 404 page
      await renderErrorPage(server, req, res, url, pagesDir, 404);
      return;
    }

    const { route, params } = match;

    try {
      // Set SSR context for the router shim so useRouter() returns
      // the correct URL and params during server-side rendering.
      const routerShim = await server.ssrLoadModule("next/router");
      if (typeof routerShim.setSSRContext === "function") {
        routerShim.setSSRContext({
          pathname: url.split("?")[0],
          query: { ...params, ...parseQuery(url) },
          asPath: url,
        });
      }

      // Load the page module through Vite's SSR pipeline
      // This gives us HMR and transform support for free
      const pageModule = await server.ssrLoadModule(route.filePath);

      // Get the page component (default export)
      const PageComponent = pageModule.default;
      if (!PageComponent) {
        res.statusCode = 500;
        res.end(`Page ${route.filePath} has no default export`);
        return;
      }

      // Collect page props via data fetching methods
      let pageProps: Record<string, unknown> = {};

      // Handle getStaticPaths for dynamic routes: validate the path
      // and respect fallback: false (return 404 for unlisted paths).
      if (typeof pageModule.getStaticPaths === "function" && route.isDynamic) {
        const pathsResult = await pageModule.getStaticPaths({ locales: [], defaultLocale: "" });
        const fallback = pathsResult?.fallback ?? false;

        if (fallback === false) {
          // Only allow paths explicitly listed in getStaticPaths
          const paths: Array<{ params: Record<string, string | string[]> }> =
            pathsResult?.paths ?? [];
          const isValidPath = paths.some((p: { params: Record<string, string | string[]> }) => {
            return Object.entries(p.params).every(([key, val]) => {
              const actual = params[key];
              if (Array.isArray(val)) {
                return Array.isArray(actual) && val.join("/") === actual.join("/");
              }
              return String(val) === String(actual);
            });
          });

          if (!isValidPath) {
            await renderErrorPage(server, req, res, url, pagesDir, 404);
            return;
          }
        }
        // fallback: true or "blocking" — in dev mode, always render
        // (Next.js dev mode does the same)
      }

      if (typeof pageModule.getServerSideProps === "function") {
        const context = {
          params,
          req,
          res,
          query: parseQuery(url),
          resolvedUrl: url,
        };
        const result = await pageModule.getServerSideProps(context);
        if (result && "props" in result) {
          pageProps = result.props;
        }
        if (result && "redirect" in result) {
          const { redirect } = result;
          res.writeHead(redirect.permanent ? 308 : 307, {
            Location: redirect.destination,
          });
          res.end();
          return;
        }
        if (result && "notFound" in result && result.notFound) {
          res.statusCode = 404;
          res.end("404 - Not Found");
          return;
        }
      }

      if (typeof pageModule.getStaticProps === "function") {
        const context = { params };
        const result = await pageModule.getStaticProps(context);
        if (result && "props" in result) {
          pageProps = result.props;
        }
        if (result && "redirect" in result) {
          const { redirect } = result;
          res.writeHead(redirect.permanent ? 308 : 307, {
            Location: redirect.destination,
          });
          res.end();
          return;
        }
        if (result && "notFound" in result && result.notFound) {
          res.statusCode = 404;
          res.end("404 - Not Found");
          return;
        }
      }

      // Try to load _app.tsx if it exists
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let AppComponent: any = null;
      const appPath = path.join(pagesDir, "_app");
      try {
        const appModule = await server.ssrLoadModule(appPath);
        AppComponent = appModule.default ?? null;
      } catch {
        // No _app.tsx, that's fine
      }

      // React and ReactDOMServer are imported at the top level as native Node
      // modules. They must NOT go through Vite's SSR module runner because
      // React is CJS and the ESModulesEvaluator doesn't define `module`.
      const createElement = React.createElement;
      let element: React.ReactElement;

      if (AppComponent) {
        element = createElement(AppComponent, {
          Component: PageComponent,
          pageProps,
        });
      } else {
        element = createElement(PageComponent, pageProps);
      }

      // Reset SSR head collector before rendering so <Head> tags are captured
      const headShim = await server.ssrLoadModule("next/head");
      if (typeof headShim.resetSSRHead === "function") {
        headShim.resetSSRHead();
      }

      // Flush any pending dynamic() preloads so components are ready
      // for synchronous renderToString
      const dynamicShim = await server.ssrLoadModule("next/dynamic");
      if (typeof dynamicShim.flushPreloads === "function") {
        await dynamicShim.flushPreloads();
      }

      // Render page to HTML string
      const bodyHtml = ReactDOMServer.renderToString(element);

      // Collect any <Head> tags that were rendered
      const ssrHeadHTML = typeof headShim.getSSRHeadHTML === "function"
        ? headShim.getSSRHeadHTML()
        : "";

      // Convert absolute file paths to Vite-servable URLs (relative to root)
      const viteRoot = server.config.root;
      const pageModuleUrl = "/" + path.relative(viteRoot, route.filePath);
      const appModuleUrl = AppComponent
        ? "/" + path.relative(viteRoot, path.join(pagesDir, "_app"))
        : null;

      // Hydration entry: inline script that imports the page and hydrates.
      // Stores the React root and page loader for client-side navigation.
      const hydrationScript = `
<script type="module">
import React from "react";
import { hydrateRoot } from "react-dom/client";

const nextData = window.__NEXT_DATA__;
const { pageProps } = nextData.props;

async function hydrate() {
  const pageModule = await import("${pageModuleUrl}");
  const PageComponent = pageModule.default;
  let element;
  ${
    appModuleUrl
      ? `
  const appModule = await import("${appModuleUrl}");
  const AppComponent = appModule.default;
  window.__NEXTCOMPAT_APP__ = AppComponent;
  element = React.createElement(AppComponent, { Component: PageComponent, pageProps });
  `
      : `
  element = React.createElement(PageComponent, pageProps);
  `
  }
  const root = hydrateRoot(document.getElementById("__next"), element);
  window.__NEXTCOMPAT_ROOT__ = root;
}
hydrate();
</script>`;

      const nextDataScript = `<script>window.__NEXT_DATA__ = ${JSON.stringify({
        props: { pageProps },
        page: route.pattern,
        query: params,
        // Include module URLs so client navigation can import pages directly
        __nextcompat: {
          pageModuleUrl,
          appModuleUrl,
        },
      })}</script>`;

      // Try to load custom _document.tsx
      let html: string;
      const docPath = path.join(pagesDir, "_document");
      let DocumentComponent: any = null;
      try {
        const docModule = await server.ssrLoadModule(docPath);
        DocumentComponent = docModule.default ?? null;
      } catch {
        // No custom _document, use default shell
      }

      const scripts = `${nextDataScript}\n  ${hydrationScript}`;

      if (DocumentComponent) {
        // Render the custom Document component
        const docElement = createElement(DocumentComponent);
        let docHtml = "<!DOCTYPE html>" + ReactDOMServer.renderToString(docElement);
        // Replace the __NEXT_MAIN__ placeholder with actual page content
        docHtml = docHtml.replace("__NEXT_MAIN__", bodyHtml);
        // Inject SSR head tags into </head>
        if (ssrHeadHTML) {
          docHtml = docHtml.replace("</head>", `  ${ssrHeadHTML}\n</head>`);
        }
        // Replace the NextScript placeholder with actual scripts
        docHtml = docHtml.replace(
          "<!-- __NEXT_SCRIPTS__ -->",
          scripts,
        );
        // If no placeholder found, inject scripts before </body>
        if (!docHtml.includes(nextDataScript)) {
          docHtml = docHtml.replace(
            "</body>",
            `  ${scripts}\n</body>`,
          );
        }
        html = docHtml;
      } else {
        // Default document shell
        html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${ssrHeadHTML}
</head>
<body>
  <div id="__next">${bodyHtml}</div>
  ${scripts}
</body>
</html>`;
      }

      // Apply Vite's HTML transforms (injects HMR client, etc.)
      const transformedHtml = await server.transformIndexHtml(url, html);

      // Clear SSR context after rendering
      if (typeof routerShim.setSSRContext === "function") {
        routerShim.setSSRContext(null);
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(transformedHtml);
    } catch (e) {
      // Let Vite fix the stack trace for better dev experience
      server.ssrFixStacktrace(e as Error);
      console.error(e);
      // Try to render custom 500 error page
      try {
        await renderErrorPage(server, req, res, url, pagesDir, 500);
      } catch {
        // If error page itself fails, fall back to plain text
        res.statusCode = 500;
        res.end(`Internal Server Error: ${(e as Error).message}`);
      }
    }
  };
}

/**
 * Render a custom error page (404.tsx, 500.tsx, or _error.tsx).
 *
 * Next.js resolution order:
 * - 404: pages/404.tsx -> pages/_error.tsx -> default
 * - 500: pages/500.tsx -> pages/_error.tsx -> default
 * - other: pages/_error.tsx -> default
 */
async function renderErrorPage(
  server: ViteDevServer,
  _req: IncomingMessage,
  res: ServerResponse,
  url: string,
  pagesDir: string,
  statusCode: number,
): Promise<void> {
  // Try specific status page first, then _error, then fallback
  const candidates =
    statusCode === 404
      ? ["404", "_error"]
      : statusCode === 500
        ? ["500", "_error"]
        : ["_error"];

  for (const candidate of candidates) {
    try {
      const errorModule = await server.ssrLoadModule(
        path.join(pagesDir, candidate),
      );
      const ErrorComponent = errorModule.default;
      if (!ErrorComponent) continue;

      // Try to load _app.tsx to wrap the error page
      let AppComponent: any = null;
      try {
        const appModule = await server.ssrLoadModule(
          path.join(pagesDir, "_app"),
        );
        AppComponent = appModule.default ?? null;
      } catch {
        // No _app, that's fine
      }

      const createElement = React.createElement;
      const errorProps = { statusCode };

      let element: React.ReactElement;
      if (AppComponent) {
        element = createElement(AppComponent, {
          Component: ErrorComponent,
          pageProps: errorProps,
        });
      } else {
        element = createElement(ErrorComponent, errorProps);
      }

      const bodyHtml = ReactDOMServer.renderToString(element);

      // Try custom _document
      let html: string;
      let DocumentComponent: any = null;
      try {
        const docModule = await server.ssrLoadModule(
          path.join(pagesDir, "_document"),
        );
        DocumentComponent = docModule.default ?? null;
      } catch {
        // No custom _document
      }

      if (DocumentComponent) {
        const docElement = createElement(DocumentComponent);
        let docHtml =
          "<!DOCTYPE html>" + ReactDOMServer.renderToString(docElement);
        docHtml = docHtml.replace("__NEXT_MAIN__", bodyHtml);
        docHtml = docHtml.replace("<!-- __NEXT_SCRIPTS__ -->", "");
        html = docHtml;
      } else {
        html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <div id="__next">${bodyHtml}</div>
</body>
</html>`;
      }

      const transformedHtml = await server.transformIndexHtml(url, html);
      res.writeHead(statusCode, { "Content-Type": "text/html" });
      res.end(transformedHtml);
      return;
    } catch {
      // This candidate doesn't exist, try next
      continue;
    }
  }

  // No custom error page found — use plain text fallback
  res.writeHead(statusCode, { "Content-Type": "text/plain" });
  res.end(`${statusCode} - ${statusCode === 404 ? "Page not found" : "Internal Server Error"}`);
}

function parseQuery(url: string): Record<string, string> {
  const queryString = url.split("?")[1];
  if (!queryString) return {};
  const params = new URLSearchParams(queryString);
  const query: Record<string, string> = {};
  for (const [key, value] of params) {
    query[key] = value;
  }
  return query;
}
