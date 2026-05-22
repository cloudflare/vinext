import { describe, expect, it } from "vite-plus/test";
import {
  applyRscCompatibilityIdHeader,
  computeRscCacheBustingSearchParam,
  createRscRequestHeaders,
  createRscRequestUrl,
  isRscCompatibilityIdCompatible,
  resolveInvalidRscCacheBustingRequest,
  setRscCacheBustingSearchParam,
  stripRscCacheBustingSearchParam,
  VINEXT_RSC_COMPATIBILITY_ID_HEADER,
  VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM,
  VINEXT_RSC_RENDER_MODE_HEADER,
  VINEXT_RSC_VARY_HEADER,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import {
  APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
  APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI,
} from "../packages/vinext/src/server/app-rsc-render-mode.js";
import { fnv1a64 } from "../packages/vinext/src/utils/hash.js";
import { withEnvVar } from "./env-test-helpers.js";

const textEncoder = new TextEncoder();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256CacheBustingHash(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", textEncoder.encode(input));
  return encodeBase64Url(new Uint8Array(digest).subarray(0, 12));
}

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

  it("varies preserve-current-UI refresh payloads from normal navigations", async () => {
    const navigationHash = await computeRscCacheBustingSearchParam(createRscRequestHeaders());
    const refreshHash = await computeRscCacheBustingSearchParam(
      createRscRequestHeaders({ renderMode: APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI }),
    );

    expect(navigationHash).toBe("");
    expect(refreshHash).not.toBe("");
  });

  it("varies loading-shell prefetch payloads from normal navigations", async () => {
    const navigationHash = await computeRscCacheBustingSearchParam(createRscRequestHeaders());
    const prefetchShellHash = await computeRscCacheBustingSearchParam(
      createRscRequestHeaders({ renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL }),
    );

    expect(navigationHash).toBe("");
    expect(prefetchShellHash).not.toBe("");
  });

  it("normalizes invalid render modes to normal navigation for cache-busting", async () => {
    const headers = createRscRequestHeaders();
    headers.set(VINEXT_RSC_RENDER_MODE_HEADER, "invalid");

    await expect(computeRscCacheBustingSearchParam(headers)).resolves.toBe("");
  });

  it("preserves existing query params while replacing stale _rsc values", () => {
    const url = new URL("https://example.com/photos/42.rsc?tab=latest&_rsc=stale");

    setRscCacheBustingSearchParam(url, "fresh");

    expect(`${url.pathname}${url.search}`).toBe("/photos/42.rsc?tab=latest&_rsc=fresh");
  });

  it("replaces encoded reserved _rsc query keys", () => {
    const url = new URL("https://example.com/photos/42.rsc?%5Frsc=stale&tab=latest");

    setRscCacheBustingSearchParam(url, "fresh");

    expect(`${url.pathname}${url.search}`).toBe("/photos/42.rsc?tab=latest&_rsc=fresh");
  });

  it("does not treat query keys containing _rsc as cache-busting params", () => {
    const url = new URL("https://example.com/photos/42.rsc?filter_rsc=1&_rsc=stale");

    setRscCacheBustingSearchParam(url, "fresh");

    expect(`${url.pathname}${url.search}`).toBe("/photos/42.rsc?filter_rsc=1&_rsc=fresh");
  });

  it("strips internal _rsc params before exposing response URLs to browser navigation", () => {
    const url = new URL("https://example.com/photos/42.rsc?tab=latest&_rsc=fresh&view=modal");

    stripRscCacheBustingSearchParam(url);

    expect(`${url.pathname}${url.search}`).toBe("/photos/42.rsc?tab=latest&view=modal");
  });

  it("strips encoded reserved _rsc query keys before exposing response URLs", () => {
    const url = new URL("https://example.com/photos/42.rsc?filter_rsc=1&%5Frsc=stale");

    stripRscCacheBustingSearchParam(url);

    expect(`${url.pathname}${url.search}`).toBe("/photos/42.rsc?filter_rsc=1");
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

  it("redirects encoded stale _rsc keys to a canonical non-looping URL", async () => {
    const headers = createRscRequestHeaders();
    const request = new Request("https://example.com/photos/42.rsc?%5Frsc=stale", { headers });

    const response = await resolveInvalidRscCacheBustingRequest({
      isRscRequest: true,
      request,
    });

    expect(response?.status).toBe(307);
    expect(response?.headers.get("Location")).toBe("/photos/42.rsc?_rsc");
  });

  it("accepts RSC requests without cache-busting params when no variant headers are present", async () => {
    const headers = createRscRequestHeaders();
    const request = new Request("https://example.com/photos/42.rsc?tab=latest", { headers });

    await expect(
      resolveInvalidRscCacheBustingRequest({ isRscRequest: true, request }),
    ).resolves.toBeNull();
  });

  it("accepts RSC requests whose cache-busting param matches the request headers", async () => {
    const headers = createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" });
    const url = await createRscRequestUrl("/photos/42", headers);
    const request = new Request(`https://example.com${url}`, { headers });

    await expect(
      resolveInvalidRscCacheBustingRequest({ isRscRequest: true, request }),
    ).resolves.toBeNull();
  });

  it("accepts legacy FNV cache-busting params during rolling upgrades", async () => {
    const headers = createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" });
    const legacyHash = fnv1a64("0,0,0,0,0,slot:modal:/");
    const request = new Request(`https://example.com/photos/42.rsc?_rsc=${legacyHash}`, {
      headers,
    });

    await expect(
      resolveInvalidRscCacheBustingRequest({ isRscRequest: true, request }),
    ).resolves.toBeNull();
  });

  it("accepts previous SHA cache-busting params after adding a varying header", async () => {
    const headers = createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" });
    const previousHash = await sha256CacheBustingHash("0,0,0,0,0,slot:modal:/");
    const request = new Request(`https://example.com/photos/42.rsc?_rsc=${previousHash}`, {
      headers,
    });

    await expect(
      resolveInvalidRscCacheBustingRequest({ isRscRequest: true, request }),
    ).resolves.toBeNull();
  });

  it("does not accept a bare previous hash for preserve-current-UI payloads", async () => {
    const headers = createRscRequestHeaders({
      renderMode: APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI,
    });
    const request = new Request("https://example.com/photos/42.rsc?_rsc", { headers });
    const hash = await computeRscCacheBustingSearchParam(headers);

    const response = await resolveInvalidRscCacheBustingRequest({
      isRscRequest: true,
      request,
    });

    expect(response?.status).toBe(307);
    expect(response?.headers.get("Location")).toBe(`/photos/42.rsc?_rsc=${hash}`);
  });

  it("does not accept previous mounted-slot hashes for preserve-current-UI payloads", async () => {
    const headers = createRscRequestHeaders({
      mountedSlotsHeader: "slot:modal:/",
      renderMode: APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI,
    });
    const previousHash = await sha256CacheBustingHash("0,0,0,0,0,slot:modal:/");
    const currentHash = await computeRscCacheBustingSearchParam(headers);
    const request = new Request(`https://example.com/photos/42.rsc?_rsc=${previousHash}`, {
      headers,
    });

    const response = await resolveInvalidRscCacheBustingRequest({
      isRscRequest: true,
      request,
    });

    expect(response?.status).toBe(307);
    expect(response?.headers.get("Location")).toBe(`/photos/42.rsc?_rsc=${currentHash}`);
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
      "RSC, Accept, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch, Next-Url, X-Vinext-Interception-Context, X-Vinext-Mounted-Slots, X-Vinext-Rsc-Render-Mode",
    );
  });

  it("applies the current compatibility ID to RSC response headers when available", () => {
    const headers = new Headers();

    applyRscCompatibilityIdHeader(headers, "compat-a");

    expect(headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER)).toBe("compat-a");
  });

  it("uses the injected RSC compatibility ID by default", () => {
    const headers = new Headers();

    withEnvVar("__VINEXT_RSC_COMPATIBILITY_ID", "compat-env", () =>
      applyRscCompatibilityIdHeader(headers),
    );

    expect(headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER)).toBe("compat-env");
  });

  it("removes a spoofed compatibility ID header when no framework ID is available", () => {
    const headers = new Headers({
      [VINEXT_RSC_COMPATIBILITY_ID_HEADER]: "spoofed-compat",
    });

    applyRscCompatibilityIdHeader(headers, "");

    expect(headers.has(VINEXT_RSC_COMPATIBILITY_ID_HEADER)).toBe(false);
  });

  it("classifies mismatched RSC compatibility IDs as incompatible", () => {
    expect(isRscCompatibilityIdCompatible("compat-a", "compat-a")).toBe(true);
    expect(isRscCompatibilityIdCompatible("compat-b", "compat-a")).toBe(false);
  });

  it("treats missing response compatibility IDs as incompatible when the client has one", () => {
    expect(isRscCompatibilityIdCompatible(null, "compat-a")).toBe(false);
  });

  it("treats missing response compatibility IDs as compatible only when the client has none", () => {
    expect(isRscCompatibilityIdCompatible("compat-a", null)).toBe(true);
  });
});
