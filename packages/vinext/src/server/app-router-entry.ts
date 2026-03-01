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

    // Normalize backslashes (browsers treat /\ as //) before any other checks.
    const rawPathname = url.pathname.replaceAll("\\", "/");

    // Block protocol-relative URL open redirects (//evil.com/ or /\evil.com/).
    // Check rawPathname BEFORE decode so the guard fires before normalization.
    if (rawPathname.startsWith("//")) {
      return new Response("404 Not Found", { status: 404 });
    }

    // Validate that percent-encoding is well-formed. The RSC handler performs
    // the actual decode + normalize; we only check here to return a clean 400
    // instead of letting a malformed sequence crash downstream.
    try {
      decodeURIComponent(rawPathname);
    } catch {
      // Malformed percent-encoding (e.g. /%E0%A4%A) — return 400 instead of throwing.
      return new Response("Bad Request", { status: 400 });
    }

     // Do NOT decode/normalize the pathname here. The RSC handler
     // (virtual:vinext-rsc-entry) is the single point of decoding — it calls
     // decodeURIComponent + normalizePath on the incoming URL. Decoding here
     // AND in the handler would double-decode, causing inconsistent path
     // matching between middleware and routing.

    // Delegate to RSC handler (which decodes + normalizes the pathname itself)
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
