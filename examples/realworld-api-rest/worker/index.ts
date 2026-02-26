/**
 * Cloudflare Worker entry point for vinext Pages Router.
 *
 * The built server entry (virtual:vinext-server-entry) exports:
 * - renderPage(request, url, manifest) → Response
 * - handleApiRoute(request, url) → Response
 *
 * Both use Web-standard Request/Response APIs, making them
 * directly usable in a Worker fetch handler.
 */

// @ts-expect-error — virtual module resolved by vinext at build time
import { renderPage, handleApiRoute } from "virtual:vinext-server-entry";

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const urlWithQuery = pathname + url.search;

      // Block protocol-relative URL open redirects (//evil.com/ or /\evil.com/).
      // Normalize backslashes: browsers treat /\ as // in URL context.
      if (pathname.replaceAll("\\", "/").startsWith("//")) {
        return new Response("404 Not Found", { status: 404 });
      }

      // API routes
      if (pathname.startsWith("/api/") || pathname === "/api") {
        return await handleApiRoute(request, urlWithQuery);
      }

      // Page routes — pass null for manifest (no SSR manifest in Workers build)
      return await renderPage(request, urlWithQuery, null);
    } catch (error) {
      console.error("[vinext] Worker error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
