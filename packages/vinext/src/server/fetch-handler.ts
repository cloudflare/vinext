/**
 * Default Cloudflare fetch handler for vinext.
 *
 * Use this directly in wrangler.jsonc:
 *   "main": "vinext/server/fetch-handler"
 *
 * Or import and delegate to it from a custom worker:
 *   import handler from "vinext/server/fetch-handler";
 *   return handler.fetch(request, env, ctx);
 *
 * The vinext plugin resolves this to the App Router or Pages Router handler
 * for the current project at build time.
 */

// Re-export the adapter-selected Worker facade. A single-stage output exposes
// only `default`; a multi-stage output may additionally expose named
// entrypoints which must remain top-level exports in the final Worker module.
// @ts-expect-error -- virtual module resolved by vinext at build time
export { default } from "virtual:vinext-worker-entry";
// @ts-expect-error -- virtual module resolved by vinext at build time
export * from "virtual:vinext-worker-entry";
