/**
 * Cloudflare Worker entry point for vinext App Router.
 *
 * For apps without image optimization, point wrangler.jsonc main
 * directly at "vinext/server/app-router-entry" instead of this file.
 */
import handler from "vinext/server/app-router-entry";

export default {
  async fetch(request: Request): Promise<Response> {
    return handler.fetch(request);
  },
};
