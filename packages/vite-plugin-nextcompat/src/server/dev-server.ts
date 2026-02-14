import type { ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route } from "../routing/pages-router.js";
import { matchRoute } from "../routing/pages-router.js";
import type { NextI18nConfig } from "../config/next-config.js";
import {
  isrGet,
  isrSet,
  isrCacheKey,
  buildPagesCacheValue,
  triggerBackgroundRegeneration,
  setRevalidateDuration,
  getRevalidateDuration,
} from "./isr-cache.js";
import type { CachedPagesValue } from "../shims/cache.js";
import { withFetchCache } from "../shims/fetch-cache.js";
import { reportRequestError } from "./instrumentation.js";
import path from "node:path";
import fs from "node:fs";
import { Writable } from "node:stream";
import React from "react";
import ReactDOMServer from "react-dom/server";

const PAGE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

/**
 * Render a React element to a string using renderToPipeableStream.
 *
 * Unlike renderToString, this supports Suspense boundaries — the stream
 * waits for all Suspense fallbacks to resolve before completing. This
 * gives Pages Router components access to React.lazy and Suspense.
 *
 * Returns the rendered HTML string once the full shell + all Suspense
 * boundaries have resolved.
 */
function renderToStringAsync(element: React.ReactElement): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
      final(callback) {
        resolve(Buffer.concat(chunks).toString("utf-8"));
        callback();
      },
    });

    const { pipe } = ReactDOMServer.renderToPipeableStream(element, {
      onAllReady() {
        // All content (including Suspense boundaries) has resolved.
        // Pipe the full output to our writable.
        pipe(writable);
      },
      onError(error: unknown) {
        reject(error);
      },
    });
  });
}

/** Check if a file exists with any page extension (tsx, ts, jsx, js). */
function findFileWithExtensions(basePath: string): boolean {
  return PAGE_EXTENSIONS.some((ext) => fs.existsSync(basePath + ext));
}

/**
 * Extract locale prefix from a URL path.
 * e.g. /fr/about -> { locale: "fr", url: "/about", hadPrefix: true }
 *      /about    -> { locale: "en", url: "/about", hadPrefix: false } (defaultLocale)
 */
function extractLocaleFromUrl(
  url: string,
  i18nConfig: NextI18nConfig,
): { locale: string; url: string; hadPrefix: boolean } {
  const pathname = url.split("?")[0];
  const parts = pathname.split("/").filter(Boolean);
  const query = url.includes("?") ? url.slice(url.indexOf("?")) : "";

  if (parts.length > 0 && i18nConfig.locales.includes(parts[0])) {
    const locale = parts[0];
    const rest = "/" + parts.slice(1).join("/");
    return { locale, url: (rest || "/") + query, hadPrefix: true };
  }

  return { locale: i18nConfig.defaultLocale, url, hadPrefix: false };
}

/**
 * Detect the preferred locale from the Accept-Language header.
 * Returns the best matching locale or null.
 */
function detectLocaleFromHeaders(
  req: IncomingMessage,
  i18nConfig: NextI18nConfig,
): string | null {
  const acceptLang = req.headers["accept-language"];
  if (!acceptLang) return null;

  // Parse Accept-Language: en-US,en;q=0.9,fr;q=0.8
  const langs = acceptLang
    .split(",")
    .map((part) => {
      const [lang, qPart] = part.trim().split(";");
      const q = qPart ? parseFloat(qPart.replace("q=", "")) : 1;
      return { lang: lang.trim().toLowerCase(), q };
    })
    .sort((a, b) => b.q - a.q);

  for (const { lang } of langs) {
    // Exact match
    const exactMatch = i18nConfig.locales.find((l) => l.toLowerCase() === lang);
    if (exactMatch) return exactMatch;

    // Prefix match (e.g. "en-US" matches "en")
    const prefix = lang.split("-")[0];
    const prefixMatch = i18nConfig.locales.find(
      (l) => l.toLowerCase() === prefix || l.toLowerCase().startsWith(prefix + "-"),
    );
    if (prefixMatch) return prefixMatch;
  }

  return null;
}

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
  i18nConfig?: NextI18nConfig | null,
) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<void> => {
    // --- i18n: extract locale from URL prefix ---
    let locale: string | undefined;
    let localeStrippedUrl = url;

    if (i18nConfig) {
      const parsed = extractLocaleFromUrl(url, i18nConfig);
      locale = parsed.locale;
      localeStrippedUrl = parsed.url;

      // If no locale prefix and localeDetection is enabled, detect from Accept-Language
      if (!parsed.hadPrefix && i18nConfig.localeDetection !== false) {
        const detectedLocale = detectLocaleFromHeaders(req, i18nConfig);
        if (detectedLocale && detectedLocale !== i18nConfig.defaultLocale) {
          // Redirect to the detected locale
          const redirectUrl = `/${detectedLocale}${url === "/" ? "" : url}`;
          res.writeHead(307, { Location: redirectUrl });
          res.end();
          return;
        }
      }
    }

    const match = matchRoute(localeStrippedUrl, routes);

    if (!match) {
      // No route matched — try to render custom 404 page
      await renderErrorPage(server, req, res, url, pagesDir, 404);
      return;
    }

    const { route, params } = match;

    // Install patched fetch with Next.js caching semantics for this request
    const cleanupFetchCache = withFetchCache();

    try {
      // Set SSR context for the router shim so useRouter() returns
      // the correct URL and params during server-side rendering.
      const routerShim = await server.ssrLoadModule("next/router");
      if (typeof routerShim.setSSRContext === "function") {
        routerShim.setSSRContext({
          pathname: localeStrippedUrl.split("?")[0],
          query: { ...params, ...parseQuery(url) },
          asPath: url,
          locale: locale ?? i18nConfig?.defaultLocale,
          locales: i18nConfig?.locales,
          defaultLocale: i18nConfig?.defaultLocale,
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
        const pathsResult = await pageModule.getStaticPaths({
          locales: i18nConfig?.locales ?? [],
          defaultLocale: i18nConfig?.defaultLocale ?? "",
        });
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
          resolvedUrl: localeStrippedUrl,
          locale: locale ?? i18nConfig?.defaultLocale,
          locales: i18nConfig?.locales,
          defaultLocale: i18nConfig?.defaultLocale,
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
          await renderErrorPage(server, req, res, url, pagesDir, 404);
          return;
        }
      }

      let isrRevalidateSeconds: number | null = null;

      if (typeof pageModule.getStaticProps === "function") {
        // Check ISR cache before calling getStaticProps
        const cacheKey = isrCacheKey("pages", url.split("?")[0]);
        const cached = await isrGet(cacheKey);

        if (cached && !cached.isStale && cached.value.value?.kind === "PAGES") {
          // Fresh cache hit — serve directly
          const cachedPage = cached.value.value as CachedPagesValue;
          const cachedHtml = cachedPage.html;
          const transformedHtml = await server.transformIndexHtml(url, cachedHtml);
          const revalidateSecs = getRevalidateDuration(cacheKey) ?? 60;
          res.writeHead(200, {
            "Content-Type": "text/html",
            "X-Nextcompat-Cache": "HIT",
            "Cache-Control": `s-maxage=${revalidateSecs}, stale-while-revalidate`,
          });
          res.end(transformedHtml);
          return;
        }

        if (cached && cached.isStale && cached.value.value?.kind === "PAGES") {
          // Stale hit — serve stale immediately, trigger background regen
          const cachedPage = cached.value.value as CachedPagesValue;
          const cachedHtml = cachedPage.html;
          const transformedHtml = await server.transformIndexHtml(url, cachedHtml);

          // Trigger background regeneration
          triggerBackgroundRegeneration(cacheKey, async () => {
            const freshResult = await pageModule.getStaticProps({ params });
            if (freshResult && "props" in freshResult) {
              const revalidate = typeof freshResult.revalidate === "number" ? freshResult.revalidate : 0;
              if (revalidate > 0) {
                // Re-render with fresh props (simplified — just update cache)
                await isrSet(cacheKey, buildPagesCacheValue(cachedHtml, freshResult.props), revalidate);
              }
            }
          });

          const revalidateSecs = getRevalidateDuration(cacheKey) ?? 60;
          res.writeHead(200, {
            "Content-Type": "text/html",
            "X-Nextcompat-Cache": "STALE",
            "Cache-Control": `s-maxage=${revalidateSecs}, stale-while-revalidate`,
          });
          res.end(transformedHtml);
          return;
        }

        // Cache miss — call getStaticProps normally
        const context = {
          params,
          locale: locale ?? i18nConfig?.defaultLocale,
          locales: i18nConfig?.locales,
          defaultLocale: i18nConfig?.defaultLocale,
        };
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
          await renderErrorPage(server, req, res, url, pagesDir, 404);
          return;
        }

        // Extract revalidate period for ISR caching after render
        if (typeof result?.revalidate === "number" && result.revalidate > 0) {
          isrRevalidateSeconds = result.revalidate;
        }
      }

      // Try to load _app.tsx if it exists
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let AppComponent: any = null;
      const appPath = path.join(pagesDir, "_app");
      if (findFileWithExtensions(appPath)) {
        try {
          const appModule = await server.ssrLoadModule(appPath);
          AppComponent = appModule.default ?? null;
        } catch {
          // _app exists but failed to load
        }
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
      const dynamicShim = await server.ssrLoadModule("next/dynamic");
      if (typeof dynamicShim.flushPreloads === "function") {
        await dynamicShim.flushPreloads();
      }

      // Render page to HTML string using streaming renderer.
      // renderToPipeableStream supports Suspense boundaries — it waits for
      // all Suspense fallbacks to resolve before we collect the output.
      const bodyHtml = await renderToStringAsync(element);

      // Collect any <Head> tags that were rendered
      const ssrHeadHTML = typeof headShim.getSSRHeadHTML === "function"
        ? headShim.getSSRHeadHTML()
        : "";

      // Collect SSR font links (Google Fonts <link> tags) and font class styles
      let fontHeadHTML = "";
      try {
        const fontGoogle = await server.ssrLoadModule("next/font/google");
        if (typeof fontGoogle.getSSRFontLinks === "function") {
          const fontUrls = fontGoogle.getSSRFontLinks();
          for (const url of fontUrls) {
            fontHeadHTML += `<link rel="stylesheet" href="${url}" />\n  `;
          }
        }
        if (typeof fontGoogle.getSSRFontStyles === "function") {
          const fontStyles = fontGoogle.getSSRFontStyles();
          if (fontStyles.length > 0) {
            fontHeadHTML += `<style data-nextcompat-fonts>${fontStyles.join("\n")}</style>\n  `;
          }
        }
      } catch {
        // next/font/google not used — skip
      }

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
        locale: locale ?? i18nConfig?.defaultLocale,
        locales: i18nConfig?.locales,
        defaultLocale: i18nConfig?.defaultLocale,
        // Include module URLs so client navigation can import pages directly
        __nextcompat: {
          pageModuleUrl,
          appModuleUrl,
        },
      })}${i18nConfig ? `;window.__NEXTCOMPAT_LOCALE__=${JSON.stringify(locale ?? i18nConfig.defaultLocale)};window.__NEXTCOMPAT_LOCALES__=${JSON.stringify(i18nConfig.locales)};window.__NEXTCOMPAT_DEFAULT_LOCALE__=${JSON.stringify(i18nConfig.defaultLocale)}` : ""}</script>`;

      // Try to load custom _document.tsx
      let html: string;
      const docPath = path.join(pagesDir, "_document");
      let DocumentComponent: any = null;
      if (findFileWithExtensions(docPath)) {
        try {
          const docModule = await server.ssrLoadModule(docPath);
          DocumentComponent = docModule.default ?? null;
        } catch {
          // _document exists but failed to load
        }
      }

      const scripts = `${nextDataScript}\n  ${hydrationScript}`;

      if (DocumentComponent) {
        // Render the custom Document component
        // renderToPipeableStream auto-prepends <!DOCTYPE html> when root is <html>
        const docElement = createElement(DocumentComponent);
        let docHtml = await renderToStringAsync(docElement);
        // Replace the __NEXT_MAIN__ placeholder with actual page content
        docHtml = docHtml.replace("__NEXT_MAIN__", bodyHtml);
        // Inject SSR head tags and font styles into </head>
        if (ssrHeadHTML || fontHeadHTML) {
          docHtml = docHtml.replace("</head>", `  ${fontHeadHTML}${ssrHeadHTML}\n</head>`);
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
  ${fontHeadHTML}${ssrHeadHTML}
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

      // If ISR is enabled, cache the rendered HTML for future requests
      if (isrRevalidateSeconds !== null && isrRevalidateSeconds > 0) {
        const cacheKey = isrCacheKey("pages", url.split("?")[0]);
        await isrSet(
          cacheKey,
          buildPagesCacheValue(html, pageProps),
          isrRevalidateSeconds,
        );
        setRevalidateDuration(cacheKey, isrRevalidateSeconds);
      }

      const cacheHeader = isrRevalidateSeconds
        ? `s-maxage=${isrRevalidateSeconds}, stale-while-revalidate`
        : undefined;
      const headers: Record<string, string> = { "Content-Type": "text/html" };
      if (cacheHeader) headers["Cache-Control"] = cacheHeader;
      if (isrRevalidateSeconds) headers["X-Nextcompat-Cache"] = "MISS";
      res.writeHead(200, headers);
      res.end(transformedHtml);
    } catch (e) {
      // Let Vite fix the stack trace for better dev experience
      server.ssrFixStacktrace(e as Error);
      console.error(e);
      // Report error via instrumentation hook if registered
      reportRequestError(
        e instanceof Error ? e : new Error(String(e)),
        {
          path: url,
          method: req.method ?? "GET",
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]),
          ),
        },
        { routerKind: "Pages Router", routePath: route.pattern, routeType: "render" },
      ).catch(() => { /* ignore reporting errors */ });
      // Try to render custom 500 error page
      try {
        await renderErrorPage(server, req, res, url, pagesDir, 500);
      } catch {
        // If error page itself fails, fall back to plain text
        res.statusCode = 500;
        res.end(`Internal Server Error: ${(e as Error).message}`);
      }
    } finally {
      cleanupFetchCache();
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
      const candidatePath = path.join(pagesDir, candidate);
      if (!findFileWithExtensions(candidatePath)) continue;

      const errorModule = await server.ssrLoadModule(candidatePath);
      const ErrorComponent = errorModule.default;
      if (!ErrorComponent) continue;

      // Try to load _app.tsx to wrap the error page
      let AppComponent: any = null;
      const appPathErr = path.join(pagesDir, "_app");
      if (findFileWithExtensions(appPathErr)) {
        try {
          const appModule = await server.ssrLoadModule(appPathErr);
          AppComponent = appModule.default ?? null;
        } catch {
          // _app exists but failed to load
        }
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

      const bodyHtml = await renderToStringAsync(element);

      // Try custom _document
      let html: string;
      let DocumentComponent: any = null;
      const docPathErr = path.join(pagesDir, "_document");
      if (findFileWithExtensions(docPathErr)) {
        try {
          const docModule = await server.ssrLoadModule(docPathErr);
          DocumentComponent = docModule.default ?? null;
        } catch {
          // _document exists but failed to load
        }
      }

      if (DocumentComponent) {
        const docElement = createElement(DocumentComponent);
        let docHtml = await renderToStringAsync(docElement);
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
