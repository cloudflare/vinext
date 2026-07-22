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
 * - Each caller owns one waiter. Cancelling a waiter rejects only that caller;
 *   the shared request continues and self-evicts when it settles. This mirrors
 *   Next.js: a superseded data request may still reach the server, but its
 *   result is ignored by the cancelled navigation.
 *
 * - The map is module-scoped (one per realm). The Pages Router runs in the
 *   browser only, so a single `Map` is sufficient.
 */

import { getDeploymentId, NEXT_DEPLOYMENT_ID_HEADER } from "../../utils/deployment-id.js";
import { MIDDLEWARE_SKIP_HEADER } from "../../utils/protocol-headers.js";

type InflightEntry = {
  controller: AbortController;
  promise: Promise<Response>;
  settled: boolean;
  waiters: number;
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
  const previewVariant = window.__NEXT_DATA__?.isPreview === true ? "preview" : "normal";
  try {
    return `${new URL(dataHref, window.location.href).href}\n${previewVariant}`;
  } catch {
    return `${dataHref}\n${previewVariant}`;
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
          response.headers.get(MIDDLEWARE_SKIP_HEADER) !== null ||
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

export function fetchUncachedPagesData(dataHref: string, init?: RequestInit): Promise<Response> {
  return fetch(dataHref, init).then(async (response) => {
    const body = await response.arrayBuffer();
    return new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  });
}

export function evictPagesDataCache(dataHref: string): void {
  const key = getStaticDataKey(dataHref);
  delete staticDataCache[key];
  staticDataSources.delete(key);
}

function getInflightKey(dataHref: string, init?: RequestInit): string {
  let resolvedHref = dataHref;
  if (typeof window !== "undefined") {
    try {
      resolvedHref = new URL(dataHref, window.location.href).href;
    } catch {}
  }

  const deploymentId = new Headers(init?.headers).get(NEXT_DEPLOYMENT_ID_HEADER) ?? "";
  const previewVariant =
    typeof window !== "undefined" && window.__NEXT_DATA__?.isPreview === true
      ? "preview"
      : "normal";
  return `${resolvedHref}\n${deploymentId}\n${previewVariant}`;
}

function cloneSharedResponse(
  key: string,
  entry: InflightEntry,
  signal?: AbortSignal,
): Promise<Response> {
  entry.waiters += 1;

  return new Promise<Response>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.waiters -= 1;
    };
    const abort = () => {
      release();
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    entry.promise.then(
      (response) => {
        signal?.removeEventListener("abort", abort);
        release();
        resolve(response.clone());
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", abort);
        release();
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
  staticDataSources.clear();
  for (const key of Object.keys(staticDataCache)) delete staticDataCache[key];
}
