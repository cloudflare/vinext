import { describe, expect, it } from "vite-plus/test";
import {
  computeRscCacheBustingSearchParam,
  createRscRequestHeaders,
  createRscRequestUrl,
  resolveInvalidRscCacheBustingRequest,
  setRscCacheBustingSearchParam,
  stripRscCacheBustingSearchParam,
  VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM,
  VINEXT_RSC_VARY_HEADER,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";

describe("App Router RSC cache-busting", () => {
  it("adds a bare _rsc search param when no variant headers are present", async () => {
    const headers = createRscRequestHeaders();

    await expect(createRscRequestUrl("/dashboard?tab=activity", headers)).resolves.toBe(
      "/dashboard.rsc?tab=activity&_rsc",
    );
  });

  it("hashes Vinext RSC variant headers into the request URL", async () => {
    const headers = createRscRequestHeaders({
      interceptionContext: "/feed",
      mountedSlotsHeader: "slot:modal:/ slot:sidebar:/",
    });

    const hash = await computeRscCacheBustingSearchParam(headers);

    expect(hash).not.toBe("");
    await expect(createRscRequestUrl("/photos/42", headers)).resolves.toBe(
      `/photos/42.rsc?${VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM}=${hash}`,
    );
  });

  it("changes the hash when a varying header changes", async () => {
    const feedHash = await computeRscCacheBustingSearchParam(
      createRscRequestHeaders({ interceptionContext: "/feed" }),
    );
    const galleryHash = await computeRscCacheBustingSearchParam(
      createRscRequestHeaders({ interceptionContext: "/gallery" }),
    );

    expect(feedHash).not.toBe(galleryHash);
  });

  it("preserves existing query params while replacing stale _rsc values", () => {
    const url = new URL("https://example.com/photos/42.rsc?tab=latest&_rsc=stale");

    setRscCacheBustingSearchParam(url, "fresh");

    expect(`${url.pathname}${url.search}`).toBe("/photos/42.rsc?tab=latest&_rsc=fresh");
  });

  it("strips internal _rsc params before exposing response URLs to browser navigation", () => {
    const url = new URL("https://example.com/photos/42.rsc?tab=latest&_rsc=fresh&view=modal");

    stripRscCacheBustingSearchParam(url);

    expect(`${url.pathname}${url.search}`).toBe("/photos/42.rsc?tab=latest&view=modal");
  });

  it("strips bare internal _rsc params without rewriting unrelated query encoding", () => {
    const url = new URL("https://example.com/search.rsc?q=custom%20spacing&_rsc");

    stripRscCacheBustingSearchParam(url);

    expect(`${url.pathname}${url.search}`).toBe("/search.rsc?q=custom%20spacing");
  });

  it("redirects RSC requests with missing cache-busting params to the canonical URL", async () => {
    const headers = createRscRequestHeaders({ interceptionContext: "/feed" });
    const request = new Request("https://example.com/photos/42.rsc?tab=latest", { headers });
    const hash = await computeRscCacheBustingSearchParam(headers);

    const response = await resolveInvalidRscCacheBustingRequest({
      isRscRequest: true,
      request,
    });

    expect(response?.status).toBe(307);
    expect(response?.headers.get("Location")).toBe(`/photos/42.rsc?tab=latest&_rsc=${hash}`);
  });

  it("accepts RSC requests whose cache-busting param matches the request headers", async () => {
    const headers = createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" });
    const url = await createRscRequestUrl("/photos/42", headers);
    const request = new Request(`https://example.com${url}`, { headers });

    await expect(
      resolveInvalidRscCacheBustingRequest({ isRscRequest: true, request }),
    ).resolves.toBeNull();
  });

  it("ignores non-RSC and mutating requests", async () => {
    const headers = createRscRequestHeaders({ interceptionContext: "/feed" });

    await expect(
      resolveInvalidRscCacheBustingRequest({
        isRscRequest: false,
        request: new Request("https://example.com/photos/42", { headers }),
      }),
    ).resolves.toBeNull();
    await expect(
      resolveInvalidRscCacheBustingRequest({
        isRscRequest: true,
        request: new Request("https://example.com/photos/42.rsc", { headers, method: "POST" }),
      }),
    ).resolves.toBeNull();
  });

  it("exports the full Vary value for RSC-bearing App Router responses", () => {
    expect(VINEXT_RSC_VARY_HEADER).toBe(
      "RSC, Accept, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch, Next-Url, X-Vinext-Interception-Context, X-Vinext-Mounted-Slots",
    );
  });
});
