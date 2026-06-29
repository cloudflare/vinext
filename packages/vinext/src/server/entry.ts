/**
 * Default Cloudflare Worker entry point for vinext.
 *
 * Use this directly in wrangler.jsonc:
 *   "main": "vinext/server/entry"
 *
 * Or import and delegate to it from a custom worker:
 *   import handler from "vinext/server/entry";
 *   return handler.fetch(request, env, ctx);
 *
 * The vinext plugin resolves this to the App Router or Pages Router Worker
 * entry for the current project at build time.
 */

// @ts-expect-error -- virtual module resolved by vinext at build time
import handler from "virtual:vinext-worker-entry";

export default handler;
