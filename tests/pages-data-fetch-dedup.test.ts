/**
 * Pages Router `/_next/data/<id>/<page>.json` client-side fetch dedup parity.
 *
 * Ported from Next.js: `test/e2e/getserversideprops/test/index.test.ts`
 * https://github.com/vercel/next.js/blob/canary/test/e2e/getserversideprops/test/index.test.ts
 * (specifically the `should dedupe server data requests` case, which clicks
 * the same link four times in rapid succession and asserts the gSSP "hit"
 * counter only ticks once on the server.)
 *
 * Next.js implements this via an in-flight Promise cache keyed by the resolved
 * data URL — see `fetchNextData()` in
 * `packages/next/src/shared/lib/router/router.ts` and the `inflightCache`
 * parameter. The first call seeds `inflightCache[cacheKey]` with the fetch
 * Promise; subsequent concurrent calls for the same key reuse that Promise
 * instead of starting a new network request. The entry is dropped once the
 * fetch settles (success or failure) so the next navigation re-fetches fresh.
 *
 * This file pins the parity fix at the helper level: concurrent calls to
 * `dedupedPagesDataFetch()` for the same URL must share a single `fetch()`
 * invocation, and each caller must receive an independently-readable Response.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";

let dedupedPagesDataFetch: (typeof import("../packages/vinext/src/shims/internal/pages-data-fetch-dedup.js"))["dedupedPagesDataFetch"];
let clearPagesDataInflight: (typeof import("../packages/vinext/src/shims/internal/pages-data-fetch-dedup.js"))["clearPagesDataInflight"];

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../packages/vinext/src/shims/internal/pages-data-fetch-dedup.js");
  dedupedPagesDataFetch = mod.dedupedPagesDataFetch;
  clearPagesDataInflight = mod.clearPagesDataInflight;
  clearPagesDataInflight();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe("dedupedPagesDataFetch", () => {
  it("shares a single fetch across concurrent calls for the same URL", async () => {
    // Hold the fetch open so all 10 callers race the same in-flight Promise.
    let resolveFetch: (res: Response) => void = () => {};
    const fetchPromise = new Promise<Response>((r) => {
      resolveFetch = r;
    });
    const fetchSpy = vi.fn(() => fetchPromise);
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;

    const url = "/_next/data/build-id/foo.json";
    const consumers = Array.from({ length: 10 }, () =>
      dedupedPagesDataFetch(url, { headers: { Accept: "application/json" } }),
    );

    // Single network request despite 10 concurrent consumers.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Resolve the shared fetch; every caller should observe its own Response
    // (each consumer must be able to read .json() independently).
    resolveFetch(
      new Response(JSON.stringify({ pageProps: { hit: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const results = await Promise.all(consumers);
    for (const res of results) {
      expect(res.status).toBe(200);
      const body = (await res.json()) as { pageProps: { hit: number } };
      expect(body.pageProps.hit).toBe(1);
    }
  });

  it("re-fetches once the previous request settles", async () => {
    const fetchSpy = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ pageProps: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;

    const url = "/_next/data/build-id/foo.json";
    await dedupedPagesDataFetch(url);
    await dedupedPagesDataFetch(url);

    // Two sequential (non-overlapping) calls should each hit the network —
    // dedup only applies while a fetch is in flight.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("dedupes per-URL: different URLs do not share a fetch", async () => {
    const fetchSpy = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ pageProps: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;

    await Promise.all([
      dedupedPagesDataFetch("/_next/data/id/a.json"),
      dedupedPagesDataFetch("/_next/data/id/b.json"),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("evicts the inflight entry on fetch rejection so the next call retries", async () => {
    let attempt = 0;
    const fetchSpy = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error("network fail"));
      return Promise.resolve(
        new Response(JSON.stringify({ pageProps: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;

    const url = "/_next/data/build-id/retry.json";
    await expect(dedupedPagesDataFetch(url)).rejects.toThrow("network fail");

    const res = await dedupedPagesDataFetch(url);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
