/**
 * Default Cloudflare Worker entry point for vinext App Router.
 *
 * Use this directly in wrangler.jsonc:
 *   "main": "vinext/server/app-router-entry"
 *
 * Or import and delegate to it from a custom worker:
 *   import handler from "vinext/server/app-router-entry";
 *   return handler.fetch(request);
 *
 * This file runs in the RSC environment. Configure the Cloudflare plugin with:
 *   cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } })
 */

// @ts-expect-error — virtual module resolved by vinext
import rscHandler from "virtual:vinext-rsc-entry";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Block protocol-relative URL open redirects (//evil.com/ or /\evil.com/).
    // Normalize backslashes: browsers treat /\ as // in URL context.
    const pathname = url.pathname.replaceAll("\\", "/");
    if (pathname.startsWith("//")) {
      return new Response("404 Not Found", { status: 404 });
    }

    // Delegate to RSC handler
    const result = await rscHandler(request);

    if (result instanceof Response) {
      return result;
    }

    if (result === null || result === undefined) {
      return new Response("Not Found", { status: 404 });
    }

    return new Response(String(result), { status: 200 });
  },
};
