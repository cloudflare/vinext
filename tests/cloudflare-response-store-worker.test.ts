import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createVinextResponseStoreHandler } from "../packages/cloudflare/src/cache/response-store-adapter.worker.js";
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
});
