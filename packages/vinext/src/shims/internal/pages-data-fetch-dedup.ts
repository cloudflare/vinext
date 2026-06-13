/**
 * In-flight request dedup for the Pages Router `/_next/data/<id>/<page>.json`
 * endpoint.
 *
 * Why this exists: when a user (or app code) triggers several near-simultaneous
 * navigations to the same gSSP route — e.g. clicking the same `<Link>` multiple
 * times before the first navigation lands — each call to `Router.push` would
 * otherwise enter its own `navigateClientData()` flow and dispatch its own
 * `fetch()` against the data endpoint. That balloons server load and breaks
 * Next.js' documented "one fetch per unique data URL" guarantee.
 *
 * Ported from Next.js: `fetchNextData()` in
 * `packages/next/src/shared/lib/router/router.ts`. Next.js maintains an
 * `inflightCache` (keyed by the resolved data URL) and reuses the existing
 * Promise when a concurrent caller asks for the same URL. The entry is
 * dropped once the fetch settles (success or rejection) so the next
 * navigation re-fetches fresh.
 *
 * Design notes:
 *
 * - Callers receive a cloned Response, so each can independently consume the
 *   body (`.json()`, `.text()`, etc.). The originating Response is never read
 *   directly by anyone, which keeps subsequent clones legal even after one
 *   caller has consumed its copy.
 *
 * - No `AbortSignal` is honored at the shared layer. Each `Router.push` cycle
 *   has its own AbortController that supersedes prior navigations via
 *   `_navigationId`; aborting the shared fetch on behalf of one caller would
 *   destroy the dedup gain for every other concurrent caller. Cancellation is
 *   handled by the caller's `assertStillCurrent()` checkpoints after `await`,
 *   not by abort propagation.
 *
 * - The map is module-scoped (one per realm). The Pages Router runs in the
 *   browser only, so a single `Map` is sufficient.
 */

/** Inflight fetch promises keyed by the resolved data URL. */
const inflight = new Map<string, Promise<Response>>();

/**
 * Dedupe a `fetch()` against the `_next/data` endpoint. Multiple concurrent
 * callers for the same `dataHref` share one underlying network request.
 *
 * Each call returns a freshly-cloned `Response` so consumers can read the
 * body independently. Once the in-flight Promise settles (resolve or reject)
 * the entry is removed, and the next call will hit the network again.
 *
 * Errors propagate to every concurrent caller — the in-flight entry is
 * dropped on failure so the next navigation can retry.
 */
export function dedupedPagesDataFetch(dataHref: string, init?: RequestInit): Promise<Response> {
  let entry = inflight.get(dataHref);
  if (!entry) {
    entry = fetch(dataHref, init).finally(() => {
      // Only drop the entry if it still matches the one we set. A racing
      // caller could in principle overwrite, but inflight is keyed by URL
      // and we never overwrite on a hit, so this check is defensive.
      if (inflight.get(dataHref) === entry) inflight.delete(dataHref);
    });
    inflight.set(dataHref, entry);
  }
  // Always return a clone so each consumer gets an independently-readable
  // body. The original `entry` Response is never consumed directly, so
  // cloning remains valid for every caller (including the first).
  return entry.then((res) => res.clone());
}

/**
 * Drop every cached in-flight entry. Intended for tests; production code
 * does not need to call this because entries self-evict on settle.
 */
export function clearPagesDataInflight(): void {
  inflight.clear();
}
