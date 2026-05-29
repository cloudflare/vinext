/**
 * Cloudflare Worker entry for the request-context cache demo.
 *
 * vinext detects `ctx.cache` on the per-request ExecutionContext at
 * runtime. When present (Cloudflare exposes it once `cache.enabled: true`
 * is set in wrangler.jsonc), `revalidateTag()` / `revalidatePath()` fan
 * out their tag invalidations to `ctx.cache.purge` automatically. No
 * runtime-specific import or registration is required.
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
