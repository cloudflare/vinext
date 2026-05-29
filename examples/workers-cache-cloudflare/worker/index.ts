/**
 * Cloudflare Worker entry for the request-context cache demo.
 *
 * vinext detects the Workers Cache on the per-request execution context at
 * runtime (`ctx.cache`, exposed once `cache.enabled: true` is set in
 * wrangler.jsonc). When present, page-level ISR is automatically served
 * through the edge-managed CDN cache adapter — responses carry
 * `CDN-Cache-Control` / `Cache-Tag` headers for the edge to honor — and
 * `revalidateTag()` / `revalidatePath()` fan their invalidations out to
 * `ctx.cache.purge`. No runtime-specific import or registration is required.
 */
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handler.fetch(request, env, ctx);
  },
};
