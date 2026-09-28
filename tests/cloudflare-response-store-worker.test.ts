import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createVinextResponseStoreHandler } from "../packages/cloudflare/src/cache/response-store-adapter.worker.js";
import { VINEXT_RSC_VARY_HEADER } from "../packages/vinext/src/server/headers.js";

import { captureResponseStoreRscData } from "../packages/cloudflare/src/cache/response-store-data.runtime.js";

const stages = vi.hoisted(() => ({ request: vi.fn(), response: vi.fn() }));

vi.mock("virtual:vinext-request-stage", () => ({
  handleRequestStage: stages.request,
}));

vi.mock("virtual:vinext-response-stage", () => ({
  handleResponseStage: stages.response,
}));

describe("Cloudflare Response Store Worker", () => {
  afterEach(() => vi.restoreAllMocks());

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

  it.each(["throw", 500, 503, 404] as const)(
    "renders and repopulates after a failed response lookup (%s)",
    async (failure) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const cancel = vi.fn();
      const failed = new Response(new ReadableStream({ cancel }), {
        status: typeof failure === "number" ? failure : 500,
      });
      const fetch = vi.fn(async () => {
        if (failure === "throw") throw new Error("metadata overloaded");
        return failed;
      });
      const store = {
        fetch,
        getTagExpiration: vi.fn(),
        purge: vi.fn(),
        put: vi.fn(),
        refresh: vi.fn(),
      };
      stages.response.mockResolvedValue(
        new Response("rendered", {
          headers: { "Cache-Control": "public, max-age=60" },
        }),
      );
      const response = await createVinextResponseStoreHandler(store).fetch(
        new Request("https://example.com/outage"),
        {} as never,
        { passThroughOnException: vi.fn(), waitUntil: vi.fn() },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("rendered");
      expect(response.headers.get("X-Vinext-Cache")).toBe("MISS");
      expect(store.put).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledOnce();
      if (failure !== "throw") expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])("handles a fill outage with warmup=%s", async (warmup) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = {
      fetch: vi.fn().mockRejectedValue(new Error("lookup unavailable")),
      getTagExpiration: vi.fn(),
      purge: vi.fn(),
      refresh: vi.fn(),
      put: vi.fn().mockRejectedValue(new Error("fill unavailable")),
    };
    stages.response.mockResolvedValue(
      new Response("rendered", {
        headers: { "Cache-Control": "public, max-age=60" },
      }),
    );
    const result = createVinextResponseStoreHandler(store).fetch(
      new Request("https://example.com/outage", {
        headers: warmup ? { "User-Agent": "vinext-cloudflare-cdn-warm" } : {},
      }),
      {} as never,
      { passThroughOnException: vi.fn(), waitUntil: vi.fn() },
    );
    if (warmup) {
      await expect(result).rejects.toThrow("fill unavailable");
    } else {
      const response = await result;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("rendered");
      expect(response.headers.get("X-Vinext-Cache")).toBe("MISS");
    }
    expect(store.put).toHaveBeenCalledOnce();
  });

  it.each([301, 302, 307, 308])("preserves a cached %s redirect", async (status) => {
    const store = {
      fetch: vi.fn(async () => new Response(null, { status, headers: { Location: "/target" } })),
      getTagExpiration: vi.fn(),
      purge: vi.fn(),
      put: vi.fn(),
      refresh: vi.fn(),
    };
    const response = await createVinextResponseStoreHandler(store).fetch(
      new Request("https://example.com/redirect"),
      {} as never,
      { passThroughOnException: vi.fn(), waitUntil: vi.fn() },
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("Location")).toBe("/target");
    expect(response.headers.get("X-Vinext-Cache")).toBe("HIT");
    expect(stages.response).not.toHaveBeenCalled();
  });

  it.each(["throw", 503] as const)(
    "re-renders a warmup when its RSC lookup fails (%s)",
    async (failure) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      stages.request.mockImplementation((request, _env, _context, dispatch) =>
        dispatch(
          request,
          {
            kind: "app-page",
            isRscRequest: false,
            matchKind: "request",
            interceptionContext: null,
            interceptionId: null,
            mountedSlotsHeader: null,
          },
          { cache: "shared" },
        ),
      );
      const cancel = vi.fn();
      const fetch = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
      if (failure === "throw") fetch.mockRejectedValueOnce(new Error("metadata overloaded"));
      else fetch.mockResolvedValueOnce(new Response("unavailable", { status: failure }));
      const store = {
        fetch,
        getTagExpiration: vi.fn(),
        purge: vi.fn(),
        put: vi.fn(),
        refresh: vi.fn(),
      };
      stages.response.mockImplementation(async () => {
        captureResponseStoreRscData(Promise.resolve(new TextEncoder().encode("flight").buffer));
        return new Response("rendered", { headers: { "Cache-Control": "public, max-age=60" } });
      });
      const response = await createVinextResponseStoreHandler(store).fetch(
        new Request("https://example.com/warm", {
          headers: { "User-Agent": "vinext-cloudflare-cdn-warm" },
        }),
        {} as never,
        { passThroughOnException: vi.fn(), waitUntil: vi.fn() },
      );
      expect(await response.text()).toBe("rendered");
      expect(response.headers.get("X-Vinext-Cache")).toBe("MISS");
      expect(cancel).toHaveBeenCalledOnce();
      expect(store.put).toHaveBeenCalledTimes(2);
    },
  );

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
