/**
 * Cloudflare Worker entry point for vinext App Router.
 *
 * Architecture:
 * - The Worker runs in workerd (SSR environment)
 * - The RSC environment runs on Node.js (main Vite process)
 * - Communication uses fetch-based RPC (loadModuleDevProxy)
 *
 * For SSR pages, the Worker:
 * 1. Calls the RSC handler via RPC (which returns a Response with HTML)
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
      // Load the RSC handler from the RSC environment via RPC.
      // @ts-expect-error — import.meta.viteRsc is injected by @vitejs/plugin-rsc
      const rscModule = await import.meta.viteRsc.loadModule("rsc", "index");

      // The RSC handler returns a Response.
      // With loadModuleDevProxy, the Response is serialized/deserialized via turbo-stream.
      const result = await rscModule.default(request);

      // Reconstruct a proper Response if the RPC serialization
      // didn't produce a native Response instance.
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
