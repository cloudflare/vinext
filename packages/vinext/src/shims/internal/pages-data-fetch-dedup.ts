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
 * - Each caller owns one waiter. Cancelling a waiter leaves the shared request
 *   alive while another waiter remains; cancelling the final waiter aborts the
 *   underlying fetch and evicts the entry immediately so a replacement caller
 *   can retry without joining a doomed request.
 *
 * - The map is module-scoped (one per realm). The Pages Router runs in the
 *   browser only, so a single `Map` is sufficient.
 */

import { NEXT_DEPLOYMENT_ID_HEADER } from "../../utils/deployment-id.js";

type InflightEntry = {
  controller: AbortController;
  promise: Promise<Response>;
  settled: boolean;
  waiters: number;
};

/** Inflight fetch entries keyed by the resolved data request identity. */
const inflight = new Map<string, InflightEntry>();

function getInflightKey(dataHref: string, init?: RequestInit): string {
  let resolvedHref = dataHref;
  if (typeof window !== "undefined") {
    try {
      resolvedHref = new URL(dataHref, window.location.href).href;
    } catch {}
  }

  const deploymentId = new Headers(init?.headers).get(NEXT_DEPLOYMENT_ID_HEADER) ?? "";
  return `${resolvedHref}\n${deploymentId}`;
}

function cloneSharedResponse(
  key: string,
  entry: InflightEntry,
  signal?: AbortSignal,
): Promise<Response> {
  entry.waiters += 1;

  return new Promise<Response>((resolve, reject) => {
    let released = false;
    const release = (cancelled: boolean) => {
      if (released) return;
      released = true;
      entry.waiters -= 1;
      if (cancelled && entry.waiters === 0 && !entry.settled) {
        if (inflight.get(key) === entry) inflight.delete(key);
        entry.controller.abort();
      }
    };
    const abort = () => {
      release(true);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    entry.promise.then(
      (response) => {
        signal?.removeEventListener("abort", abort);
        release(false);
        resolve(response.clone());
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", abort);
        release(false);
        reject(error);
      },
    );
  });
}

/**
 * Dedupe a `fetch()` against the `_next/data` endpoint. Multiple concurrent
 * callers for the same resolved URL and deployment ID share one underlying
 * network request.
 *
 * Each call returns a freshly-cloned `Response` so consumers can read the
 * body independently. Once the in-flight Promise settles (resolve or reject)
 * the entry is removed, and the next call will hit the network again.
 *
 * Errors propagate to every concurrent caller — the in-flight entry is
 * dropped on failure so the next navigation can retry.
 */
export function dedupedPagesDataFetch(dataHref: string, init?: RequestInit): Promise<Response> {
  const key = getInflightKey(dataHref, init);
  const signal = init?.signal ?? undefined;
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));

  let entry = inflight.get(key);
  if (!entry) {
    const controller = new AbortController();
    let currentEntry: InflightEntry;
    const promise = fetch(dataHref, { ...init, signal: controller.signal }).finally(() => {
      currentEntry.settled = true;
      if (inflight.get(key) === currentEntry) inflight.delete(key);
    });
    currentEntry = {
      controller,
      promise,
      settled: false,
      waiters: 0,
    };
    inflight.set(key, currentEntry);
    entry = currentEntry;
  }
  return cloneSharedResponse(key, entry, signal);
}

/**
 * Drop every cached in-flight entry. Intended for tests; production code
 * does not need to call this because entries self-evict on settle.
 */
export function clearPagesDataInflight(): void {
  for (const entry of inflight.values()) entry.controller.abort();
  inflight.clear();
}
