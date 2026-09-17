import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createVinextResponseStoreHandler } from "../packages/cloudflare/src/cache/response-store-adapter.worker.js";
import { VINEXT_RSC_VARY_HEADER } from "../packages/vinext/src/server/headers.js";

const stages = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("virtual:vinext-request-stage", () => ({
  handleRequestStage: stages.request,
}));

describe("Cloudflare Response Store Worker", () => {
  beforeEach(() => {
    stages.request.mockReset();
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
    for (const name of VINEXT_RSC_VARY_HEADER.split(",")) {
      expect(htmlKey.headers.get(name.trim())).toBe("vinext-keyed");
      expect(rscKey.headers.get(name.trim())).toBe("vinext-keyed");
    }
  });
});
