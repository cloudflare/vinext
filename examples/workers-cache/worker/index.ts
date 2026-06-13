/**
 * Cloudflare Worker entry for the Workers Cache demo.
 *
 * The cache adapters are declared in vite.config via `vinext({ cache })`:
 * `cdnAdapter()` serves page-level ISR through the Cloudflare Workers Cache
 * (`ctx.cache`, exposed once `cache.enabled: true` is set in wrangler.jsonc) —
 * responses carry `CDN-Cache-Control` / `Cache-Tag` headers for the edge to
 * honor and `revalidateTag()` / `revalidatePath()` fan out to `ctx.cache.purge`
 * — and `kvDataAdapter()` backs the inner data cache with the `VINEXT_KV_CACHE`
 * KV namespace. The App Router handler registers them on the first request
 * (passing this Worker's `env` so the KV binding resolves), so the entry itself
 * just delegates — no manual registration needed.
 */
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  VINEXT_KV_CACHE: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handler.fetch(request, env, ctx);
  },
};
