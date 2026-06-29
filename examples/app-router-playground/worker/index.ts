/** Cloudflare Worker entry point that delegates to vinext. */
import handler from "vinext/server/entry";

interface Env {
  ASSETS: Fetcher;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handler.fetch(request, env, ctx);
  },
};
