import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  clearPagesDataInflight,
  fetchStaticPagesData,
  getPagesStaticDataCache,
} from "../packages/vinext/src/shims/internal/pages-data-fetch-dedup.js";
import { prefetchPagesData } from "../packages/vinext/src/shims/internal/pages-data-target.js";

describe("prefetchPagesData", () => {
  beforeEach(() => {
    clearPagesDataInflight();
    vi.stubGlobal("document", {});
    vi.stubGlobal("window", {
      location: { href: "http://localhost/", origin: "http://localhost" },
      __VINEXT_PAGES_SSG_PATTERNS__: [],
      __VINEXT_PAGES_SSP_PATTERNS__: [],
    });
  });

  afterEach(() => {
    clearPagesDataInflight();
    vi.unstubAllGlobals();
    delete process.env.__VINEXT_DEPLOYMENT_ID;
  });

  // Ported from Next.js: test/production/deployment-id-handling/deployment-id-handling.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/production/deployment-id-handling/deployment-id-handling.test.ts
  it("sends the deployment ID on Pages data prefetch requests", async () => {
    window.__VINEXT_PAGES_SSG_PATTERNS__ = ["/about"];
    process.env.__VINEXT_DEPLOYMENT_ID = "dpl_123";
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response("{}"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const loader = vi.fn(async () => ({ default: null }));

    prefetchPagesData({
      buildId: "build-id",
      dataKind: "static",
      dataHref: "/_next/data/build-id/about.json",
      loader,
      locale: undefined,
      pagePath: "/about",
      params: {},
      pattern: "/about",
      search: "",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    const init = fetchMock.mock.calls[0][1];
    if (!init) throw new Error("expected prefetch request options");
    expect(init.headers).toEqual({
      Accept: "application/json",
      purpose: "prefetch",
      "x-deployment-id": "dpl_123",
      "x-nextjs-data": "1",
    });
    expect(loader).toHaveBeenCalledOnce();
  });

  // Ported from Next.js: test/e2e/middleware-rewrites/test/index.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/middleware-rewrites/test/index.test.ts
  it("prefetches data only for SSG pages and keeps non-SSG prefetches chunk-only", async () => {
    window.__VINEXT_PAGES_SSG_PATTERNS__ = ["/ssg"];
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response('{"pageProps":{}}'),
    );
    vi.stubGlobal("fetch", fetchMock);
    const loader = vi.fn(async () => ({ default: null }));

    prefetchPagesData({
      buildId: "build-id",
      dataKind: "static",
      dataHref: "/_next/data/build-id/ssg.json",
      loader,
      locale: undefined,
      pagePath: "/ssg",
      params: {},
      pattern: "/ssg",
      search: "",
    });
    prefetchPagesData({
      buildId: "build-id",
      dataKind: "server",
      dataHref: "/_next/data/build-id/dynamic.json",
      loader,
      locale: undefined,
      pagePath: "/dynamic",
      params: {},
      pattern: "/dynamic",
      search: "",
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const cacheKeys = Object.keys(getPagesStaticDataCache());
    expect(cacheKeys).toHaveLength(1);
    expect(cacheKeys[0]).toContain("/_next/data/build-id/ssg.json");
    expect(fetchMock.mock.calls[0][0]).toBe("/_next/data/build-id/ssg.json");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("caches middleware-effect prefetches for matched non-SSG pages", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response('{"pageProps":{}}'),
    );
    vi.stubGlobal("fetch", fetchMock);
    const loader = vi.fn(async () => ({ default: null }));

    prefetchPagesData({
      buildId: "build-id",
      dataKind: "server",
      dataHref: "/_next/data/build-id/dynamic.json",
      loader,
      locale: undefined,
      middlewareDataHref: "/_next/data/build-id/dynamic.json",
      pagePath: "/dynamic",
      params: {},
      pattern: "/dynamic",
      search: "",
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(Object.keys(getPagesStaticDataCache())).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/_next/data/build-id/dynamic.json");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Accept: "application/json",
      purpose: "prefetch",
      "x-middleware-prefetch": "1",
      "x-nextjs-data": "1",
    });
    expect(loader).toHaveBeenCalledOnce();

    prefetchPagesData({
      buildId: "build-id",
      dataKind: "server",
      dataHref: "/_next/data/build-id/dynamic.json",
      loader,
      locale: undefined,
      middlewareDataHref: "/_next/data/build-id/dynamic.json",
      pagePath: "/dynamic",
      params: {},
      pattern: "/dynamic",
      search: "",
    });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("evicts static data responses that opt out of middleware caching", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { headers: { "x-middleware-cache": "no-cache" } })),
    );

    await fetchStaticPagesData("/_next/data/build-id/ssg.json");

    expect(Object.keys(getPagesStaticDataCache())).toEqual([]);
  });

  it("keeps the persistent static fetch alive when one navigation aborts", async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const controller = new AbortController();
    const cancelled = fetchStaticPagesData("/_next/data/build-id/ssg.json", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    resolveFetch(new Response("{}"));
    await expect(fetchStaticPagesData("/_next/data/build-id/ssg.json")).resolves.toBeInstanceOf(
      Response,
    );
    expect(Object.keys(getPagesStaticDataCache())).toHaveLength(1);
  });

  it("keeps navigation data readable after a public cache consumer reads its response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"pageProps":{"value":1}}')),
    );

    await fetchStaticPagesData("/_next/data/build-id/ssg.json");
    const [publicEntry] = Object.values(getPagesStaticDataCache());
    expect(await (await publicEntry).json()).toEqual({ pageProps: { value: 1 } });

    await expect(
      (await fetchStaticPagesData("/_next/data/build-id/ssg.json")).json(),
    ).resolves.toEqual({ pageProps: { value: 1 } });
  });

  it("evicts static data from a different deployment", async () => {
    process.env.__VINEXT_DEPLOYMENT_ID = "deployment-a";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("{}", { headers: { "x-nextjs-deployment-id": "deployment-b" } }),
      ),
    );

    await fetchStaticPagesData("/_next/data/build-id/ssg.json", {
      headers: { "x-deployment-id": "deployment-a" },
    });

    expect(Object.keys(getPagesStaticDataCache())).toEqual([]);
  });

  it("retains static data matching the canonical deployment ID", async () => {
    process.env.__VINEXT_DEPLOYMENT_ID = "deployment-a";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("{}", { headers: { "x-nextjs-deployment-id": "deployment-a" } }),
      ),
    );

    await fetchStaticPagesData("/_next/data/build-id/ssg.json", {
      headers: { "x-deployment-id": "stale-caller-value" },
    });

    expect(Object.keys(getPagesStaticDataCache())).toHaveLength(1);
  });
});
