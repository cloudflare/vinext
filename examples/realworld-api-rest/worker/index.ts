/**
 * Cloudflare Worker entry point for vinext Pages Router.
 *
 * The built server entry (virtual:vinext-server-entry) exports:
 * - renderPage(request, url, manifest) -> Response
 * - handleApiRoute(request, url) -> Response
 * - runMiddleware(request) -> middleware result
 * - vinextConfig -> embedded next.config.js settings
 *
 * Both use Web-standard Request/Response APIs, making them
 * directly usable in a Worker fetch handler.
 */
import {
  matchRedirect,
  matchRewrite,
  matchHeaders,
  requestContextFromRequest,
  isExternalUrl,
  proxyExternalRequest,
} from "vinext/config/config-matchers";

// @ts-expect-error -- virtual module resolved by vinext at build time
import { renderPage, handleApiRoute, runMiddleware, vinextConfig } from "virtual:vinext-server-entry";

// Extract config values (embedded at build time in the server entry)
const basePath: string = vinextConfig?.basePath ?? "";
const trailingSlash: boolean = vinextConfig?.trailingSlash ?? false;
const configRedirects = vinextConfig?.redirects ?? [];
const configRewrites = vinextConfig?.rewrites ?? { beforeFiles: [], afterFiles: [], fallback: [] };
const configHeaders = vinextConfig?.headers ?? [];

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      let pathname = url.pathname;
      let urlWithQuery = pathname + url.search;

      // Block protocol-relative URL open redirects (//evil.com/ or /\evil.com/).
      // Normalize backslashes: browsers treat /\ as // in URL context.
      if (pathname.replaceAll("\\", "/").startsWith("//")) {
        return new Response("404 Not Found", { status: 404 });
      }

      // Strip basePath
      if (basePath && pathname.startsWith(basePath)) {
        const stripped = pathname.slice(basePath.length) || "/";
        urlWithQuery = stripped + url.search;
        pathname = stripped;
      }

      // Trailing slash normalization
      if (pathname !== "/" && !pathname.startsWith("/api")) {
        const hasTrailing = pathname.endsWith("/");
        if (trailingSlash && !hasTrailing) {
          return new Response(null, {
            status: 308,
            headers: { Location: basePath + pathname + "/" + url.search },
          });
        } else if (!trailingSlash && hasTrailing) {
          return new Response(null, {
            status: 308,
            headers: { Location: basePath + pathname.replace(/\/+$/, "") + url.search },
          });
        }
      }

      // Build request with basePath-stripped URL for middleware
      if (basePath) {
        const strippedUrl = new URL(request.url);
        strippedUrl.pathname = pathname;
        request = new Request(strippedUrl, request);
      }

      // Build request context for has/missing condition matching
      const reqCtx = requestContextFromRequest(request);

      // Run middleware
      let resolvedUrl = urlWithQuery;
      const middlewareHeaders: Record<string, string> = {};
      let middlewareRewriteStatus: number | undefined;
      if (typeof runMiddleware === "function") {
        const result = await runMiddleware(request);

        if (!result.continue) {
          if (result.redirectUrl) {
            return new Response(null, {
              status: result.redirectStatus ?? 307,
              headers: { Location: result.redirectUrl },
            });
          }
          if (result.response) {
            return result.response;
          }
        }

        if (result.responseHeaders) {
          for (const [key, value] of result.responseHeaders) {
            middlewareHeaders[key] = value;
          }
        }
        if (result.rewriteUrl) {
          resolvedUrl = result.rewriteUrl;
        }
        middlewareRewriteStatus = result.rewriteStatus;
      }

      // Unpack x-middleware-request-* headers
      const mwReqPrefix = "x-middleware-request-";
      const mwReqHeaders: Record<string, string> = {};
      for (const key of Object.keys(middlewareHeaders)) {
        if (key.startsWith(mwReqPrefix)) {
          mwReqHeaders[key.slice(mwReqPrefix.length)] = middlewareHeaders[key];
          delete middlewareHeaders[key];
        }
      }
      if (Object.keys(mwReqHeaders).length > 0) {
        const newHeaders = new Headers(request.headers);
        for (const [k, v] of Object.entries(mwReqHeaders)) {
          newHeaders.set(k, v);
        }
        request = new Request(request.url, {
          method: request.method,
          headers: newHeaders,
          body: request.body,
          // @ts-expect-error -- duplex needed for streaming request bodies
          duplex: request.body ? "half" : undefined,
        });
      }

      let resolvedPathname = resolvedUrl.split("?")[0];

      // Apply custom headers from next.config.js
      if (configHeaders.length) {
        const matched = matchHeaders(resolvedPathname, configHeaders);
        for (const h of matched) {
          middlewareHeaders[h.key.toLowerCase()] = h.value;
        }
      }

      // Apply redirects from next.config.js
      if (configRedirects.length) {
        const redirect = matchRedirect(resolvedPathname, configRedirects, reqCtx);
        if (redirect) {
          const dest = basePath && !redirect.destination.startsWith(basePath)
            ? basePath + redirect.destination
            : redirect.destination;
          return new Response(null, {
            status: redirect.permanent ? 308 : 307,
            headers: { Location: dest },
          });
        }
      }

      // Apply beforeFiles rewrites from next.config.js
      if (configRewrites.beforeFiles?.length) {
        const rewritten = matchRewrite(resolvedPathname, configRewrites.beforeFiles, reqCtx);
        if (rewritten) {
          if (isExternalUrl(rewritten)) {
            return proxyExternalRequest(request, rewritten);
          }
          resolvedUrl = rewritten;
          resolvedPathname = rewritten.split("?")[0];
        }
      }

      // API routes
      if (resolvedPathname.startsWith("/api/") || resolvedPathname === "/api") {
        const response = typeof handleApiRoute === "function"
          ? await handleApiRoute(request, resolvedUrl)
          : new Response("404 - API route not found", { status: 404 });
        return mergeHeaders(response, middlewareHeaders, middlewareRewriteStatus);
      }

      // Apply afterFiles rewrites
      if (configRewrites.afterFiles?.length) {
        const rewritten = matchRewrite(resolvedPathname, configRewrites.afterFiles, reqCtx);
        if (rewritten) {
          if (isExternalUrl(rewritten)) {
            return proxyExternalRequest(request, rewritten);
          }
          resolvedUrl = rewritten;
          resolvedPathname = rewritten.split("?")[0];
        }
      }

      // Page routes
      let response: Response | undefined;
      if (typeof renderPage === "function") {
        response = await renderPage(request, resolvedUrl, null);

        // Fallback rewrites (if SSR returned 404)
        if (response && response.status === 404 && configRewrites.fallback?.length) {
          const fallbackRewrite = matchRewrite(resolvedPathname, configRewrites.fallback, reqCtx);
          if (fallbackRewrite) {
            if (isExternalUrl(fallbackRewrite)) {
              return proxyExternalRequest(request, fallbackRewrite);
            }
            response = await renderPage(request, fallbackRewrite, null);
          }
        }
      }

      if (!response) {
        return new Response("404 - Not found", { status: 404 });
      }

      return mergeHeaders(response, middlewareHeaders, middlewareRewriteStatus);
    } catch (error) {
      console.error("[vinext] Worker error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};

/**
 * Merge middleware/config headers into a response.
 * Response headers take precedence over middleware headers.
 */
function mergeHeaders(
  response: Response,
  extraHeaders: Record<string, string>,
  statusOverride?: number,
): Response {
  if (!Object.keys(extraHeaders).length && !statusOverride) return response;
  const merged: Record<string, string> = { ...extraHeaders };
  response.headers.forEach((v, k) => { merged[k] = v; });
  return new Response(response.body, {
    status: statusOverride ?? response.status,
    statusText: response.statusText,
    headers: merged,
  });
}
