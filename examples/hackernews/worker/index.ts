/**
 * Cloudflare Worker entry point for the Hacker News example.
 *
 * Based on vercel/next-react-server-components — a Hacker News clone
 * using React Server Components, now running on vinext + Cloudflare Workers.
 */

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const { pathname } = url;

      // Block protocol-relative URL open redirects (//evil.com/ or /\evil.com/).
      // Normalize backslashes: browsers treat /\ as // in URL context.
      const safePath = pathname.replaceAll("\\", "/");
      if (safePath.startsWith("//")) {
        return new Response("404 Not Found", { status: 404 });
      }

      // Load the RSC handler from the RSC environment.
      // @ts-expect-error — import.meta.viteRsc is injected by @vitejs/plugin-rsc
      const rscModule = await import.meta.viteRsc.loadModule("rsc", "index");

      const result = await rscModule.default(request);

      if (result instanceof Response) {
        return result;
      }

      if (result === null || result === undefined) {
        return new Response("Not Found", { status: 404 });
      }

      return new Response(String(result), { status: 200 });
    } catch (error) {
      console.error("[vinext] Worker error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
