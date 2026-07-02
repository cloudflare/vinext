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
 * Promise when a concurrent caller asks for the same URL. Production prefetch
 * entries stay cached until a real `__N_SSP` navigation consumes them; failed
 * or uncached requests self-evict when they settle.
 *
 * Design notes:
 *
 * - The shared fetch is buffered once, and callers receive a fresh `Response`
 *   over those bytes. This mirrors Next.js' text-buffered `fetchNextData()`
 *   cache while avoiding unread prefetch streams.
 *
 * - Each caller owns one waiter. Cancelling a waiter rejects only that caller;
 *   the shared request continues and self-evicts when it settles. This mirrors
 *   Next.js: a superseded data request may still reach the server, but its
 *   result is ignored by the cancelled navigation.
 *
 * - The map is module-scoped (one per realm). The Pages Router runs in the
 *   browser only, so a single `Map` is sufficient.
 */

import { getDeploymentId } from "../../utils/deployment-id.js";

type InflightEntry = {
  controller: AbortController;
  deleteOnSettle: boolean;
  promise: Promise<BufferedResponse>;
  settled: boolean;
};

type BufferedResponse = {
  body: ArrayBuffer;
  headers: [string, string][];
  status: number;
  statusText: string;
};

export type PagesDataFetchInit = RequestInit & {
  persist?: boolean;
};

/** Inflight fetch entries keyed by the resolved data request identity. */
const inflight = new Map<string, InflightEntry>();
const staticDataCache: Record<string, Promise<Response>> = Object.create(null) as Record<
  string,
  Promise<Response>
>;
const staticDataSources = new Map<string, Promise<Response>>();

function getStaticDataKey(dataHref: string): string {
  if (typeof window === "undefined") return dataHref;
  try {
    return new URL(dataHref, window.location.href).href;
  } catch {
    return dataHref;
  }
}

function cloneStaticResponse(cached: Promise<Response>, signal?: AbortSignal): Promise<Response> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  if (!signal) return cached.then((response) => response.clone());

  return new Promise<Response>((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    cached.then(
      (response) => {
        signal.removeEventListener("abort", abort);
        resolve(response.clone());
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function getPagesStaticDataCache(): Record<string, Promise<Response>> {
  return staticDataCache;
}

export function fetchCachedPagesData(dataHref: string, init?: RequestInit): Promise<Response> {
  const key = getStaticDataKey(dataHref);
  let cached = staticDataSources.get(key);
  if (cached === undefined) {
    const { signal: _signal, ...sharedInit } = init ?? {};
    cached = dedupedPagesDataFetch(dataHref, sharedInit)
      .then((response) => {
        const expectedDeploymentId = getDeploymentId() ?? null;
        const responseDeploymentId = response.headers.get("x-nextjs-deployment-id");
        if (
          !response.ok ||
          response.headers.get("x-middleware-cache") === "no-cache" ||
          (responseDeploymentId !== null && responseDeploymentId !== expectedDeploymentId)
        ) {
          delete staticDataCache[key];
          staticDataSources.delete(key);
        }
        return response;
      })
      .catch((error: unknown) => {
        delete staticDataCache[key];
        staticDataSources.delete(key);
        throw error;
      });
    staticDataSources.set(key, cached);
    const publicCached = cached.then((response) => response.clone());
    publicCached.catch(() => {});
    staticDataCache[key] = publicCached;
  }
  return cloneStaticResponse(cached, init?.signal ?? undefined);
}

export function fetchStaticPagesData(dataHref: string, init?: RequestInit): Promise<Response> {
  return fetchCachedPagesData(dataHref, init);
}

export function evictPagesDataCache(dataHref: string): void {
  const staticKey = getStaticDataKey(dataHref);
  delete staticDataCache[staticKey];
  staticDataSources.delete(staticKey);
  const inflightKey = getInflightKey(dataHref);
  const entry = inflight.get(inflightKey);
  if (!entry) return;
  if (entry.settled) {
    inflight.delete(inflightKey);
  } else {
    entry.deleteOnSettle = true;
  }
}

function getInflightKey(dataHref: string): string {
  let resolvedHref = dataHref;
  if (typeof window !== "undefined") {
    try {
      resolvedHref = new URL(dataHref, window.location.href).href;
    } catch {}
  }

  return `${resolvedHref}\n${getDeploymentId() ?? ""}`;
}

function responseFromBuffered(buffered: BufferedResponse): Response {
  return new Response(buffered.body, {
    headers: buffered.headers,
    status: buffered.status,
    statusText: buffered.statusText,
  });
}

function cloneSharedResponse(entry: InflightEntry, signal?: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const abort = () => {
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    entry.promise.then(
      (buffered) => {
        signal?.removeEventListener("abort", abort);
        resolve(responseFromBuffered(buffered));
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * Dedupe a `fetch()` against the `_next/data` endpoint. Multiple callers for
 * the same resolved URL and deployment ID share one underlying network
 * request, including a navigation racing a completed prefetch.
 *
 * Each call returns a fresh `Response` so consumers can read the body
 * independently. Non-persistent entries are removed once the fetch settles.
 * Persistent entries model Next.js' `sdc` cache and should be cleared by the
 * navigation path after consuming an `__N_SSP` response.
 *
 * Errors and non-OK responses propagate to every concurrent caller, but are
 * dropped from cache so the next navigation can retry.
 */
export function dedupedPagesDataFetch(
  dataHref: string,
  init?: PagesDataFetchInit,
): Promise<Response> {
  const key = getInflightKey(dataHref);
  const signal = init?.signal ?? undefined;
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));

  let entry = inflight.get(key);
  if (!entry) {
    const controller = new AbortController();
    let currentEntry: InflightEntry;
    const { persist = false, signal: _signal, ...fetchInit } = init ?? {};
    const promise = fetch(dataHref, { ...fetchInit, signal: controller.signal })
      .then(async (response) => {
        const buffered: BufferedResponse = {
          body: await response.arrayBuffer(),
          headers: Array.from(response.headers.entries()),
          status: response.status,
          statusText: response.statusText,
        };
        currentEntry.settled = true;
        if (
          (!persist || !response.ok || currentEntry.deleteOnSettle) &&
          inflight.get(key) === currentEntry
        ) {
          inflight.delete(key);
        }
        return buffered;
      })
      .catch((error: unknown) => {
        currentEntry.settled = true;
        if (inflight.get(key) === currentEntry) inflight.delete(key);
        throw error;
      });
    currentEntry = {
      controller,
      deleteOnSettle: false,
      promise,
      settled: false,
    };
    inflight.set(key, currentEntry);
    entry = currentEntry;
  }
  return cloneSharedResponse(entry, signal);
}

/**
 * Drop every cached in-flight entry. Intended for tests; production code
 * does not need to call this because non-persisted entries self-evict on
 * settle, while persisted entries are retained intentionally.
 */
export function clearPagesDataInflight(): void {
  for (const entry of inflight.values()) entry.controller.abort();
  inflight.clear();
  staticDataSources.clear();
  for (const key of Object.keys(staticDataCache)) delete staticDataCache[key];
}
