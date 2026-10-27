/** Cloudflare Worker entry point that delegates to vinext. */
import handler from "vinext/server/fetch-handler";
import { handleStreamsLabDisconnect } from "./streams-lab-disconnect";

interface Env {
  ASSETS: Fetcher;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__streams-lab/")) {
      const response = handleStreamsLabDisconnect(url);
      if (response) return Promise.resolve(response);
    }
    return handler.fetch(request, env, ctx);
  },
};
