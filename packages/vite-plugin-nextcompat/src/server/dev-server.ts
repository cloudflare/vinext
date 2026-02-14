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
      // No route matched - let Vite handle it (404, static files, etc.)
      res.statusCode = 404;
      res.end("404 - Page not found");
      return;
    }

    const { route, params } = match;

    try {
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

      // Render page to HTML string
      const bodyHtml = ReactDOMServer.renderToString(element);

      const nextDataScript = `<script>window.__NEXT_DATA__ = ${JSON.stringify({
        props: { pageProps },
        page: route.pattern,
        query: params,
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

      if (DocumentComponent) {
        // Render the custom Document component
        const docElement = createElement(DocumentComponent);
        let docHtml = "<!DOCTYPE html>" + ReactDOMServer.renderToString(docElement);
        // Replace the __NEXT_MAIN__ placeholder with actual page content
        docHtml = docHtml.replace("__NEXT_MAIN__", bodyHtml);
        // Replace the NextScript placeholder comment with actual scripts
        docHtml = docHtml.replace(
          "<!-- __NEXT_SCRIPTS__ -->",
          `${nextDataScript}\n  <script type="module" src="/@vite/client"></script>`,
        );
        // If no placeholder comment found, inject scripts before </body>
        if (!docHtml.includes(nextDataScript)) {
          docHtml = docHtml.replace(
            "</body>",
            `  ${nextDataScript}\n  <script type="module" src="/@vite/client"></script>\n</body>`,
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
</head>
<body>
  <div id="__next">${bodyHtml}</div>
  ${nextDataScript}
  <script type="module" src="/@vite/client"></script>
</body>
</html>`;
      }

      // Apply Vite's HTML transforms (injects HMR client, etc.)
      const transformedHtml = await server.transformIndexHtml(url, html);

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(transformedHtml);
    } catch (e) {
      // Let Vite handle the error (nice overlay in dev)
      server.ssrFixStacktrace(e as Error);
      console.error(e);
      res.statusCode = 500;
      res.end(`Internal Server Error: ${(e as Error).message}`);
    }
  };
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
