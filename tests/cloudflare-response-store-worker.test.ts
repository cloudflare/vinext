import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createVinextResponseStoreHandler,
  createVinextResponseStoreOptions,
} from "../packages/cloudflare/src/cache/response-store-adapter.worker.js";
import createResponseStoreDataCacheAdapter, {
  captureResponseStoreRscData,
} from "../packages/cloudflare/src/cache/response-store-data.runtime.js";
import { createCanonicalRscRequestHeaders } from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import { VINEXT_RSC_VARY_HEADER } from "../packages/vinext/src/server/headers.js";

const stages = vi.hoisted(() => ({ request: vi.fn(), response: vi.fn() }));

vi.mock("virtual:vinext-request-stage", () => ({
  handleRequestStage: stages.request,
}));

vi.mock("virtual:vinext-response-stage", () => ({
  handleResponseStage: stages.response,
}));

describe("Cloudflare Response Store Worker", () => {
  beforeEach(() => {
    stages.request.mockReset();
    stages.response.mockReset();
    stages.request.mockImplementation((request, _env, _context, dispatchResponseStage) =>
      dispatchResponseStage(request, { kind: "app-page" }, { cache: "shared" }),
    );
  });

  it("seals framework variance in opaque requests without changing cached responses", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return new Response("cached body", {
        headers: {
          "Cache-Control": "public, max-age=60",
          "Content-Type": "text/plain",
          Vary: VINEXT_RSC_VARY_HEADER,
          "X-App-Header": "preserved",
        },
        status: 203,
        statusText: "Cached",
      });
    });
    const mutationResult = { backingStoreUpdated: true, edgePurgeAccepted: true };
    const store = {
      fetch,
      getTagExpiration: vi.fn(async () => 0),
      purge: vi.fn(async () => mutationResult),
      put: vi.fn(async () => mutationResult),
      refresh: vi.fn(async () => mutationResult),
    };
    const handler = createVinextResponseStoreHandler(store);
    const env = {} as Parameters<typeof handler.fetch>[1];
    const context = {
      passThroughOnException: vi.fn(),
      waitUntil: vi.fn(),
    };

    const html = await handler.fetch(new Request("https://example.com/page"), env, context);
    const rsc = await handler.fetch(
      new Request("https://example.com/page", { headers: { RSC: "1" } }),
      env,
      context,
    );

    expect(html.status).toBe(203);
    expect(html.statusText).toBe("Cached");
    expect(html.headers.get("content-type")).toBe("text/plain");
    expect(html.headers.get("vary")).toBe(VINEXT_RSC_VARY_HEADER);
    expect(html.headers.get("x-app-header")).toBe("preserved");
    expect(await html.text()).toBe("cached body");
    expect(await rsc.text()).toBe("cached body");

    expect(requests).toHaveLength(2);
    const [htmlKey, rscKey] = requests as [Request, Request];
    expect(htmlKey.url).not.toBe(rscKey.url);
    for (const key of [htmlKey, rscKey]) {
      expect(new URL(key.url).searchParams.get("__workers_response_store")).toMatch(
        /^v1\.[0-9a-f]{64}$/,
      );
      expect(new URL(key.url).searchParams.has("__vinext_response_store")).toBe(false);
    }
    for (const name of VINEXT_RSC_VARY_HEADER.split(",")) {
      expect(htmlKey.headers.get(name.trim())).toBe("vinext-keyed");
      expect(rscKey.headers.get(name.trim())).toBe("vinext-keyed");
    }
  });

  it("sanitizes response-stage props once on cache hits", async () => {
    const toJSON = vi.fn(() => ({ kind: "app-page" }));
    stages.request.mockImplementation((request, _env, _context, dispatchResponseStage) =>
      dispatchResponseStage(request, { toJSON }, { cache: "shared" }),
    );
    const store = {
      fetch: vi.fn(
        async () => new Response("cached", { headers: { "Cache-Control": "public, max-age=60" } }),
      ),
      getTagExpiration: vi.fn(async () => 0),
      purge: vi.fn(),
      put: vi.fn(),
      refresh: vi.fn(),
    };
    const handler = createVinextResponseStoreHandler(store);

    const response = await handler.fetch(new Request("https://example.com/hit"), {} as never, {
      passThroughOnException: vi.fn(),
      waitUntil: vi.fn(),
    });

    expect(await response.text()).toBe("cached");
    expect(toJSON).toHaveBeenCalledOnce();
    expect(stages.response).not.toHaveBeenCalled();
  });

  it("reuses prepared response-stage props on cache misses", async () => {
    const toJSON = vi.fn(() => ({ kind: "app-page" }));
    stages.request.mockImplementation((request, _env, _context, dispatchResponseStage) =>
      dispatchResponseStage(request, { toJSON }, { cache: "shared" }),
    );
    stages.response.mockResolvedValue(
      new Response("rendered", { headers: { "Cache-Control": "public, max-age=60" } }),
    );
    const mutationResult = { backingStoreUpdated: true, edgePurgeAccepted: true };
    const put = vi.fn(
      async (
        _request: Request,
        _response: Response,
        _options?: { revalidator?: { id: string; args: unknown[] } },
      ) => mutationResult,
    );
    const store = {
      fetch: vi.fn(
        async () =>
          new Response(null, {
            headers: { "X-Workers-Response-Store": "MISS" },
            status: 404,
          }),
      ),
      getTagExpiration: vi.fn(async () => 0),
      purge: vi.fn(async () => mutationResult),
      put,
      refresh: vi.fn(async () => mutationResult),
    };
    const handler = createVinextResponseStoreHandler(store);

    const response = await handler.fetch(new Request("https://example.com/miss"), {} as never, {
      passThroughOnException: vi.fn(),
      waitUntil: vi.fn(),
    });

    expect(await response.text()).toBe("rendered");
    expect(toJSON).toHaveBeenCalledOnce();
    expect(stages.response).toHaveBeenCalledOnce();
    const options = put.mock.calls[0]?.[2];
    expect(options?.revalidator?.args).toHaveLength(1);
    expect(JSON.parse(String(options?.revalidator?.args[0]))).toEqual({
      props: { kind: "app-page" },
      request: { headers: [], method: "GET", url: "https://example.com/miss" },
    });
  });

  it("serializes response-stage props once on bypasses", async () => {
    const toJSON = vi.fn(() => ({ kind: "app-page" }));
    stages.request.mockImplementation((request, _env, _context, dispatchResponseStage) =>
      dispatchResponseStage(request, { toJSON }, { cache: "bypass" }),
    );
    stages.response.mockResolvedValue(new Response("rendered"));
    const store = {
      fetch: vi.fn(),
      getTagExpiration: vi.fn(),
      purge: vi.fn(),
      put: vi.fn(),
      refresh: vi.fn(),
    };
    const handler = createVinextResponseStoreHandler(store);

    const response = await handler.fetch(new Request("https://example.com/bypass"), {} as never, {
      passThroughOnException: vi.fn(),
      waitUntil: vi.fn(),
    });

    expect(await response.text()).toBe("rendered");
    expect(response.headers.get("X-Vinext-Cache")).toBe("BYPASS");
    expect(toJSON).toHaveBeenCalledOnce();
    expect(store.fetch).not.toHaveBeenCalled();
  });
});

describe("Cloudflare Response Store Worker query-free cache identity", () => {
  type PutOptions = { revalidator?: { id: string; args: unknown[] } };
  type StoredEntry = { body: string; headers: Headers; options?: PutOptions };

  beforeEach(() => {
    stages.request.mockReset();
    stages.response.mockReset();
  });

  function createMemoryStore() {
    const entries = new Map<string, StoredEntry>();
    const mutationResult = { backingStoreUpdated: true, edgePurgeAccepted: true };
    const fetch = vi.fn(async (request: Request) => {
      const entry = entries.get(request.url);
      return entry
        ? new Response(entry.body, { headers: entry.headers })
        : new Response(null, { headers: { "X-Workers-Response-Store": "MISS" }, status: 404 });
    });
    const put = vi.fn(async (request: Request, response: Response, options?: PutOptions) => {
      entries.set(request.url, {
        body: await response.text(),
        headers: new Headers(response.headers),
        options,
      });
      return mutationResult;
    });
    return {
      entries,
      store: {
        fetch,
        getTagExpiration: vi.fn(async () => 0),
        purge: vi.fn(async () => mutationResult),
        put,
        refresh: vi.fn(async () => mutationResult),
      },
    };
  }

  function pageProps(resolvedUrl: string) {
    return {
      interceptionContext: null,
      interceptionId: null,
      isRscRequest: false,
      kind: "app-page",
      matchKind: "request",
      mountedSlotsHeader: null,
      renderMode: "navigation",
      resolvedUrl,
    };
  }

  function dispatchWithIdentity(withIdentity = true) {
    stages.request.mockImplementation((request: Request, _env, _context, dispatchResponseStage) => {
      const url = new URL(request.url);
      const identityUrl = new URL(url);
      identityUrl.search = "";
      const props = pageProps(`${url.pathname}${url.search}`);
      return dispatchResponseStage(
        request,
        props,
        withIdentity
          ? {
              cache: "shared",
              cacheIdentity: {
                props: { ...props, resolvedUrl: url.pathname },
                request: new Request(identityUrl, { headers: request.headers }),
              },
            }
          : { cache: "shared" },
      );
    });
  }

  function context() {
    return { passThroughOnException: vi.fn(), waitUntil: vi.fn() };
  }

  function revalidatorInvocation(entry: StoredEntry | undefined) {
    return JSON.parse(String(entry?.options?.revalidator?.args[0])) as {
      props: { resolvedUrl: string; isRscRequest: boolean };
      request: { url: string };
    };
  }

  it("serves two queries from one entry keyed and replayed by the identity", async () => {
    dispatchWithIdentity();
    const renderedUrls: string[] = [];
    stages.response.mockImplementation(async (request: Request, _env, _context, props) => {
      renderedUrls.push(`${request.url} ${(props as { resolvedUrl: string }).resolvedUrl}`);
      // Data-cache writes replay the render that produced them.
      await createResponseStoreDataCacheAdapter().set("data-key", null, { revalidate: 60 });
      return new Response("rendered", { headers: { "Cache-Control": "public, max-age=60" } });
    });
    const { entries, store } = createMemoryStore();
    const handler = createVinextResponseStoreHandler(store);

    const first = await handler.fetch(
      new Request("https://example.com/page?q=a"),
      {} as never,
      context(),
    );
    const second = await handler.fetch(
      new Request("https://example.com/page?q=b"),
      {} as never,
      context(),
    );

    expect(first.headers.get("X-Vinext-Cache")).toBe("MISS");
    expect(await first.text()).toBe("rendered");
    expect(second.headers.get("X-Vinext-Cache")).toBe("HIT");
    expect(await second.text()).toBe("rendered");
    expect(renderedUrls).toEqual(["https://example.com/page?q=a /page?q=a"]);
    const [firstKey, secondKey] = store.fetch.mock.calls.map(([request]) => request.url);
    expect(secondKey).toBe(firstKey);
    expect(new URL(firstKey!).pathname).toBe("/page");
    expect(new URL(firstKey!).searchParams.has("q")).toBe(false);

    const routeEntry = entries.get(firstKey!);
    expect(routeEntry?.options?.revalidator?.id).toBe("vinext:response");
    expect(revalidatorInvocation(routeEntry)).toMatchObject({
      props: { resolvedUrl: "/page" },
      request: { url: "https://example.com/page" },
    });
    const dataEntry = [...entries.values()].find(
      (entry) => entry.options?.revalidator?.id === "vinext:data",
    );
    expect(JSON.parse(String(dataEntry?.options?.revalidator?.args[1]))).toMatchObject({
      props: { resolvedUrl: "/page?q=a" },
      request: { url: "https://example.com/page?q=a" },
    });
  });

  it("keys the full request when no identity is given", async () => {
    dispatchWithIdentity(false);
    stages.response.mockImplementation(
      async () => new Response("rendered", { headers: { "Cache-Control": "public, max-age=60" } }),
    );
    const { entries, store } = createMemoryStore();
    const handler = createVinextResponseStoreHandler(store);

    for (const query of ["a", "b"]) {
      const response = await handler.fetch(
        new Request(`https://example.com/page?q=${query}`),
        {} as never,
        context(),
      );
      expect(response.headers.get("X-Vinext-Cache")).toBe("MISS");
      await response.text();
    }

    expect(stages.response).toHaveBeenCalledTimes(2);
    expect(entries.size).toBe(2);
    expect([...entries.values()].map((entry) => revalidatorInvocation(entry).request.url)).toEqual([
      "https://example.com/page?q=a",
      "https://example.com/page?q=b",
    ]);
  });

  it("stores and regenerates without the request's params and path headers", async () => {
    dispatchWithIdentity();
    const rscHeaders = {
      "Cache-Control": "public, max-age=60",
      "X-Vinext-Params": encodeURIComponent(JSON.stringify({ slug: "page" })),
      "X-Vinext-Rendered-Path-And-Search": encodeURIComponent("/page?q=a"),
    };
    stages.response.mockImplementation(async () => new Response("rsc", { headers: rscHeaders }));
    const { entries, store } = createMemoryStore();
    const handler = createVinextResponseStoreHandler(store);

    const miss = await handler.fetch(
      new Request("https://example.com/page?q=a"),
      {} as never,
      context(),
    );
    // The request stage recomposes both headers for every response, HITs included.
    expect(miss.headers.get("X-Vinext-Rendered-Path-And-Search")).toBe(
      encodeURIComponent("/page?q=a"),
    );
    await miss.text();
    const [entry] = [...entries.values()];
    expect(entry?.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(entry?.headers.has("X-Vinext-Params")).toBe(false);
    expect(entry?.headers.has("X-Vinext-Rendered-Path-And-Search")).toBe(false);

    stages.response.mockClear();
    const regenerated = await createVinextResponseStoreOptions().regenerate(
      {
        args: entry!.options!.revalidator!.args as string[],
        id: "vinext:response",
        reason: "stale",
        request: new Request("https://example.com/page"),
      } as never,
      { ctx: context(), env: {} } as never,
    );
    const [replayedRequest, , , replayedProps] = stages.response.mock.calls[0]!;
    expect((replayedRequest as Request).url).toBe("https://example.com/page");
    expect(replayedProps).toMatchObject({ resolvedUrl: "/page" });
    expect(regenerated.headers.has("X-Vinext-Params")).toBe(false);
    expect(regenerated.headers.has("X-Vinext-Rendered-Path-And-Search")).toBe(false);
  });

  it("seeds the canonical RSC entry under the identity during warmup", async () => {
    dispatchWithIdentity();
    stages.response.mockImplementation(async () => {
      captureResponseStoreRscData(Promise.resolve(new TextEncoder().encode("rsc").buffer));
      return new Response("html", { headers: { "Cache-Control": "public, max-age=60" } });
    });
    const { entries, store } = createMemoryStore();
    const handler = createVinextResponseStoreHandler(store);

    const warmup = await handler.fetch(
      new Request("https://example.com/page?q=a", {
        headers: { "user-agent": "vinext-cloudflare-cdn-warm" },
      }),
      {} as never,
      context(),
    );
    await warmup.text();

    const invocations = [...entries.values()].map(revalidatorInvocation);
    expect(invocations).toEqual([
      expect.objectContaining({
        props: expect.objectContaining({ isRscRequest: false, resolvedUrl: "/page" }),
        request: expect.objectContaining({ url: "https://example.com/page" }),
      }),
      expect.objectContaining({
        props: expect.objectContaining({ isRscRequest: true, resolvedUrl: "/page" }),
        request: expect.objectContaining({ url: "https://example.com/page?_rsc" }),
      }),
    ]);

    // A later canonical RSC navigation with any query reaches the seeded entry.
    stages.response.mockClear();
    stages.request.mockImplementation((_request, _env, _context, dispatchResponseStage) => {
      const props = { ...pageProps("/page"), isRscRequest: true };
      return dispatchResponseStage(
        new Request("https://example.com/page?q=b&_rsc", {
          headers: createCanonicalRscRequestHeaders(),
        }),
        { ...props, resolvedUrl: "/page?q=b" },
        {
          cache: "shared",
          cacheIdentity: {
            props,
            request: new Request("https://example.com/page?_rsc", {
              headers: createCanonicalRscRequestHeaders(),
            }),
          },
        },
      );
    });
    const rsc = await handler.fetch(
      new Request("https://example.com/page?q=b&_rsc"),
      {} as never,
      context(),
    );
    expect(rsc.headers.get("X-Vinext-Cache")).toBe("HIT");
    expect(await rsc.text()).toBe("rsc");
    expect(stages.response).not.toHaveBeenCalled();
  });
});
