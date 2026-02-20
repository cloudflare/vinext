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

interface Env {
  ASSETS: Fetcher;
  IMAGES?: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const { pathname } = url;

      // Block protocol-relative URL open redirect attacks (//evil.com/).
      if (pathname.startsWith("//")) {
        return new Response("404 Not Found", { status: 404 });
      }

      // ── Image optimization via Cloudflare Images binding ──────────
      if (pathname === "/_vinext/image") {
        return handleImageOptimization(request, url, env);
      }

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

/**
 * Handle /_vinext/image requests.
 * Uses the Cloudflare Images binding (if available) to resize, transcode,
 * and quality-optimize images. Falls back to serving the original via ASSETS.
 */
async function handleImageOptimization(request: Request, url: URL, env: Env): Promise<Response> {
  const imageUrl = url.searchParams.get("url");
  if (!imageUrl) {
    return new Response("Missing url parameter", { status: 400 });
  }

  // Only allow path-relative URLs to prevent SSRF / open redirect.
  // Allowlist: must start with "/" but not "//" to be a valid relative path.
  // This blocks absolute URLs, protocol-relative, and exotic schemes.
  if (!imageUrl.startsWith("/") || imageUrl.startsWith("//")) {
    return new Response("Only relative URLs allowed", { status: 400 });
  }

  const width = parseInt(url.searchParams.get("w") || "0", 10);
  const quality = parseInt(url.searchParams.get("q") || "75", 10);

  // Validate width and quality ranges
  if (Number.isNaN(width) || width < 0 || Number.isNaN(quality) || quality < 1 || quality > 100) {
    return new Response("Bad Request", { status: 400 });
  }

  // Fetch source image from Assets binding
  const sourceReq = new Request(new URL(imageUrl, request.url));
  const source = await env.ASSETS.fetch(sourceReq);
  if (!source.ok || !source.body) {
    return new Response("Image not found", { status: 404 });
  }

  // If the Images binding is available, transform the image
  if (env.IMAGES) {
    try {
      const transforms: Record<string, unknown> = {};
      if (width > 0) transforms.width = width;

      // Negotiate format from Accept header
      const accept = request.headers.get("Accept") || "";
      const format = accept.includes("image/avif") ? "image/avif"
        : accept.includes("image/webp") ? "image/webp"
        : "image/jpeg";

      const result = await env.IMAGES.input(source.body)
        .transform(transforms)
        .output({ format, quality });

      const response = result.response();
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      headers.set("Vary", "Accept");
      return new Response(response.body, { status: 200, headers });
    } catch (e) {
      console.error("[vinext] Image optimization error:", e);
      // Fall through to serve original
    }
  }

  // Fallback: serve the original image with cache headers
  const headers = new Headers(source.headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Vary", "Accept");
  return new Response(source.body, { status: 200, headers });
}
