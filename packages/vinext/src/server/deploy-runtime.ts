/**
 * Detects whether vinext is running in "deploy" mode — i.e. inside a Cloudflare
 * Workers runtime served from a deployed Worker. This is distinct from
 * standalone production mode (`vinext start`, served by `prod-server.ts` on
 * Node), where vinext is the only cache layer in front of the user.
 *
 * Why this matters for `Cache-Control`:
 *
 *   - Standalone: vinext itself is the cache. Emitting `s-maxage=<n>,
 *     stale-while-revalidate=<m>` is the right value to honor because nothing
 *     else interprets it before reaching the browser.
 *
 *   - Deploy (Cloudflare Workers): the deployed Worker sits behind Cloudflare's
 *     edge network and the user's own Workers Cache API usage. Cache freshness
 *     is governed by cache tags (`revalidateTag`) and the in-Worker cache
 *     handler, not by HTTP `s-maxage`. Next.js' deploy adapters (Vercel,
 *     OpenNext, etc.) collapse all ISR-style cache controls to
 *     `public, max-age=0, must-revalidate` — the browser revalidates on every
 *     request and the edge layer serves the cached payload based on tags.
 *     vinext's Next.js compatibility test suite (`NEXT_TEST_MODE=deploy`)
 *     asserts this exact header value, so vinext must match.
 *
 * Detection uses `navigator.userAgent === "Cloudflare-Workers"`, the standard
 * way to identify the Workers runtime. `prod-server.ts` (Node) does not
 * provide a `navigator` object with this value, so it correctly reports
 * `false` and preserves the standalone cache-control output.
 */

export const DEPLOY_CACHE_CONTROL = "public, max-age=0, must-revalidate";

/**
 * Returns `true` when the current process is running inside a Cloudflare
 * Workers runtime (the deploy target). Returns `false` for the Node-backed
 * standalone production server, dev server, and unit tests.
 *
 * The check is intentionally a simple `globalThis` lookup so it can run from
 * any module without coupling to a config object. Call sites can pass an
 * explicit `isDeploy` override (e.g. for tests) to avoid relying on this.
 */
export function isDeployRuntime(): boolean {
  // `navigator` is present in Workers, but `globalThis.navigator?.userAgent`
  // may also exist in unrelated runtimes (browsers, Deno) with a different
  // value. The exact string `"Cloudflare-Workers"` is the Workers contract:
  // https://developers.cloudflare.com/workers/runtime-apis/web-standards/#navigatoruseragent
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  return ua === "Cloudflare-Workers";
}
