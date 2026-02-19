/**
 * Cloudflare Worker entry point for vinext App Router.
 *
 * Architecture:
 * - Both RSC and SSR environments run in workerd
 * - import.meta.viteRsc.loadModule (from @vitejs/plugin-rsc) loads the RSC handler
 *
 * For SSR pages, the Worker:
 * 1. Calls the RSC handler (which returns a Response with HTML)
 * 2. Returns that Response to the client
 *
 * For .rsc requests (client-side navigation), the RSC handler returns
 * the RSC stream directly.
 *
 * For API routes, the RSC handler handles them directly and returns JSON.
 */

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      // Load the RSC handler from the RSC environment.
      // @ts-expect-error — import.meta.viteRsc is injected by @vitejs/plugin-rsc
      const rscModule = await import.meta.viteRsc.loadModule("rsc", "index");

      // The RSC handler returns a Response.
      const result = await rscModule.default(request);

      // Return the Response if it's a native instance.
      if (result instanceof Response) {
        return result;
      }

      // turbo-stream should handle Response, but if it returns something else:
      if (result === null || result === undefined) {
        return new Response("Not Found", { status: 404 });
      }

      // Fallback: try to construct a Response from whatever we got
      return new Response(String(result), { status: 200 });
    } catch (error) {
      console.error("[vinext] Worker error:", error);
      return new Response(
        `Internal Server Error: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 },
      );
    }
  },
};
