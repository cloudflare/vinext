import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { clearPagesDataInflight } from "../packages/vinext/src/shims/internal/pages-data-fetch-dedup.js";
import { prefetchPagesData } from "../packages/vinext/src/shims/internal/pages-data-target.js";

describe("prefetchPagesData", () => {
  beforeEach(() => {
    clearPagesDataInflight();
    vi.stubGlobal("document", {});
  });

  afterEach(() => {
    clearPagesDataInflight();
    vi.unstubAllGlobals();
    delete process.env.__VINEXT_DEPLOYMENT_ID;
  });

  // Ported from Next.js: test/production/deployment-id-handling/deployment-id-handling.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/production/deployment-id-handling/deployment-id-handling.test.ts
  it("sends the deployment ID on Pages data prefetch requests", async () => {
    process.env.__VINEXT_DEPLOYMENT_ID = "dpl_123";
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response("{}"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const loader = vi.fn(async () => ({ default: null }));

    prefetchPagesData({
      buildId: "build-id",
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
});
