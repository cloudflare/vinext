import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyRscCompatibilityIdHeader,
  applyRscDeploymentIdHeader,
  canonicalizeLoadingShellRscRequestHeaders,
  canonicalizePrewarmableRscRequestHeaders,
  computeRscCacheBustingSearchParam,
  createCanonicalLoadingShellRscRequestHeaders,
  createCanonicalRscRequestHeaders,
  createCanonicalRscRequestUrl,
  createRscRedirectLocation,
  createRscRequestHeaders,
  createRscRequestUrl,
  createServerActionRequestUrl,
  isRscCompatibilityIdCompatible,
  resolveInvalidRscCacheBustingRequest,
  setRscCacheBustingSearchParam,
  stripRscCacheBustingSearchParam,
  VINEXT_RSC_BUILD_ID_HEADER,
  VINEXT_RSC_COMPATIBILITY_ID_HEADER,
  VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM,
  VINEXT_RSC_RENDER_MODE_HEADER,
  VINEXT_RSC_VARY_HEADER,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import { APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL } from "../packages/vinext/src/server/app-rsc-render-mode.js";
import {
  FLIGHT_HEADERS,
  VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
  VINEXT_RSC_STATE_FINGERPRINT_HEADER,
} from "../packages/vinext/src/server/headers.js";
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
  // Ported from Next.js: test/production/deployment-id-handling/deployment-id-handling.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/production/deployment-id-handling/deployment-id-handling.test.ts
  it("adds the deployment ID header to RSC requests", () => {
    withEnvVar("__VINEXT_DEPLOYMENT_ID", "dpl_123", () => {
      expect(createRscRequestHeaders().get("x-deployment-id")).toBe("dpl_123");
    });
  });

  it("adds a bare _rsc search param when no variant headers are present", async () => {
    const headers = createRscRequestHeaders();

    await expect(createRscRequestUrl("/dashboard?tab=activity", headers)).resolves.toBe(
      "/dashboard?tab=activity&_rsc",
    );
  });

  it("builds the exact canonical full deploy-warmer request", () => {
    const headers = createCanonicalRscRequestHeaders("dpl_123");

    expect(Object.fromEntries(headers)).toEqual({
      accept: "text/x-component",
      rsc: "1",
      "x-deployment-id": "dpl_123",
    });
    expect(createCanonicalRscRequestUrl("/cached/intro?tab=latest")).toBe(
      "/cached/intro?tab=latest&_rsc",
    );
  });

  it("builds the deterministic loading-shell request identity", async () => {
    const headers = createCanonicalLoadingShellRscRequestHeaders("dpl_123");
    expect(Object.fromEntries(headers)).toEqual({
      accept: "text/x-component",
      "next-router-prefetch": "1",
      "next-router-segment-prefetch": "1",
      rsc: "1",
      "x-deployment-id": "dpl_123",
      "x-vinext-rsc-render-mode": "prefetch-loading-shell",
    });
    await expect(createRscRequestUrl("/cached/intro", headers)).resolves.toBe(
      "/cached/intro?_rsc=9qLBDIU2NgN178cB",
    );

    const contextual = createRscRequestHeaders({
      deploymentId: "dpl_123",
      nextUrl: "/source",
      prefetchRouterState: { pathAndSearch: "/source", routeId: "route:/source" },
      renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
    });
    contextual.set("next-router-segment-prefetch", "1");
    expect(canonicalizeLoadingShellRscRequestHeaders(contextual)).toBe(true);
    expect(Object.fromEntries(contextual)).toEqual(Object.fromEntries(headers));
  });

  it("normalizes full prefetch and navigation headers to the warmer shape", async () => {
    const headers = createRscRequestHeaders({
      clientReuseManifestHeader: '{"entries":[]}',
      deploymentId: "dpl_123",
      nextUrl: "/source",
      prefetchRouterState: { pathAndSearch: "/source", routeId: "route:/source" },
    });
    headers.set("next-router-segment-prefetch", "1");

    expect(canonicalizePrewarmableRscRequestHeaders(headers)).toBe(true);
    expect(Object.fromEntries(headers)).toEqual({
      accept: "text/x-component",
      rsc: "1",
      "x-deployment-id": "dpl_123",
    });
    await expect(createRscRequestUrl("/cached/intro", headers)).resolves.toBe("/cached/intro?_rsc");
  });

  it("does not canonicalize partial, intercepted, or mounted-slot payloads", () => {
    for (const headers of [
      createRscRequestHeaders({ renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL }),
      createRscRequestHeaders({ interceptionContext: "/source" }),
      createRscRequestHeaders({ interceptionId: "modal" }),
      createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" }),
    ]) {
      const before = Array.from(headers);
      expect(canonicalizePrewarmableRscRequestHeaders(headers)).toBe(false);
      expect(Array.from(headers)).toEqual(before);
    }
  });

  it("uses the canonical route URL for root RSC navigations", async () => {
    // Ported from Next.js: test/e2e/app-dir/navigation/navigation.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts
    // Client-side App Router navigations fetch the route URL with RSC: 1 and
    // _rsc cache busting, not Vinext's legacy /.rsc transport path.
    const headers = createRscRequestHeaders();

    await expect(createRscRequestUrl("/", headers)).resolves.toBe("/?_rsc");
  });

  it("preserves the route pathname trailing slash when building canonical RSC URLs", async () => {
    const headers = createRscRequestHeaders();

    await expect(createRscRequestUrl("/docs/", headers)).resolves.toBe("/docs/?_rsc");
  });

  it("preserves encoded spaces while adding the RSC cache-busting query", async () => {
    const headers = createRscRequestHeaders();

    await expect(createRscRequestUrl("/?param=with%20space", headers)).resolves.toBe(
      "/?param=with%20space&_rsc",
    );
  });

  it("only exposes fetch priority through the Next.js test-mode header", () => {
    withEnvVar("__NEXT_TEST_MODE", undefined, () => {
      expect(
        createRscRequestHeaders({ fetchPriority: "low" }).get("next-test-fetch-priority"),
      ).toBeNull();
    });
    withEnvVar("__NEXT_TEST_MODE", "1", () => {
      expect(
        createRscRequestHeaders({ fetchPriority: "low" }).get("next-test-fetch-priority"),
      ).toBe("low");
      expect(
        createRscRequestHeaders({ fetchPriority: "auto" }).get("next-test-fetch-priority"),
      ).toBe("auto");
    });
  });

  it("hashes Vinext RSC variant headers into the request URL", async () => {
    const headers = createRscRequestHeaders({
      interceptionContext: "/feed",
      mountedSlotsHeader: "slot:modal:/ slot:sidebar:/",
    });

    const hash = await computeRscCacheBustingSearchParam(headers);

    expect(hash).not.toBe("");
    await expect(createRscRequestUrl("/photos/42", headers)).resolves.toBe(
      `/photos/42?${VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM}=${hash}`,
    );
  });

  // Ported from Next.js:
  // packages/next/src/client/components/router-reducer/set-cache-busting-search-param.test.ts
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/router-reducer/set-cache-busting-search-param.test.ts
  it("falls back to the legacy FNV hash when Web Crypto is unavailable", async () => {
    vi.stubGlobal("crypto", {});

    try {
      const headers = createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" });
      const legacyHash = fnv1a64("0,0,0,0,0,0,slot:modal:/,0");

      await expect(createRscRequestUrl("/photos/42", headers)).resolves.toBe(
        `/photos/42?_rsc=${legacyHash}`,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("adds a valued _rsc query for visible App Router state", async () => {
    const headers = createRscRequestHeaders({
      routerState: { pathAndSearch: "/current", routeId: "route:/current" },
    });
    const hash = await computeRscCacheBustingSearchParam(headers);

    expect(headers.get(VINEXT_RSC_STATE_FINGERPRINT_HEADER)).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).not.toBe("");
    await expect(createRscRequestUrl("/destination", headers)).resolves.toBe(
      `/destination?_rsc=${hash}`,
    );
  });

  it("derives the same state fingerprint for reusable prefetch requests", () => {
    const routerState = { pathAndSearch: "/current", routeId: "route:/current" };
    const navigationHeaders = createRscRequestHeaders({ routerState });
    const prefetchHeaders = createRscRequestHeaders({ prefetchRouterState: routerState });

    expect(prefetchHeaders.get(VINEXT_RSC_STATE_FINGERPRINT_HEADER)).toBe(
      navigationHeaders.get(VINEXT_RSC_STATE_FINGERPRINT_HEADER),
    );
  });

  it("keeps router state but omits the prefetch header for a full prefetch", () => {
    const headers = createRscRequestHeaders({
      nextUrl: "/current",
      includePrefetchHeader: false,
      prefetchRouterState: { pathAndSearch: "/current", routeId: "route:/current" },
    });

    expect(headers.get("next-router-prefetch")).toBeNull();
    expect(headers.get("next-router-state-tree")).toBeTruthy();
    expect(headers.get("next-url")).toBe("/current");
  });

  it("keeps server action POSTs on the visible route URL", () => {
    // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
    expect(createServerActionRequestUrl("/server?name=alice#section")).toBe("/server?name=alice");
  });

  it("attaches client reuse manifests without making them shared cache variants", async () => {
    const manifestHeader = '{"entries":[]}';
    const headers = createRscRequestHeaders({ clientReuseManifestHeader: manifestHeader });

    expect(headers.get(VINEXT_CLIENT_REUSE_MANIFEST_HEADER)).toBe(manifestHeader);
    await expect(createRscRequestUrl("/dashboard", headers)).resolves.toBe("/dashboard?_rsc");
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

  it("redirects HTML-path RSC requests without cache-busting params to a separate URL", async () => {
    const headers = createRscRequestHeaders();
    const request = new Request("https://example.com/photos/42?tab=latest", { headers });

    const response = await resolveInvalidRscCacheBustingRequest({
      isRscRequest: true,
      request,
    });

    expect(response?.status).toBe(307);
    expect(response?.headers.get("Location")).toBe("/photos/42?tab=latest&_rsc");
  });

  it("accepts RSC requests whose cache-busting param matches the request headers", async () => {
    const headers = createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" });
    const url = await createRscRequestUrl("/photos/42", headers);
    const request = new Request(`https://example.com${url}`, { headers });

    await expect(
      resolveInvalidRscCacheBustingRequest({ isRscRequest: true, request }),
    ).resolves.toBeNull();
  });

  // Ported from Next.js: test/e2e/app-dir/segment-cache/cdn-cache-busting/cdn-cache-busting.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/cdn-cache-busting/cdn-cache-busting.test.ts
  it("accepts only definitive canonical request identities for strict-Vary adapters", async () => {
    await withEnvVar("__VINEXT_CANONICAL_RSC_REQUESTS", "1", async () => {
      const fullHeaders = createCanonicalRscRequestHeaders();
      const fullRequest = new Request("https://example.com/photos/42?_rsc", {
        headers: fullHeaders,
      });
      await expect(
        resolveInvalidRscCacheBustingRequest({ isRscRequest: true, request: fullRequest }),
      ).resolves.toBeNull();

      const loadingHeaders = createCanonicalLoadingShellRscRequestHeaders();
      const loadingPath = await createRscRequestUrl("/photos/42", loadingHeaders);
      expect(loadingPath).toBe("/photos/42?_rsc=9qLBDIU2NgN178cB");
      const loadingRequest = new Request(`https://example.com${loadingPath}`, {
        headers: loadingHeaders,
      });
      await expect(
        resolveInvalidRscCacheBustingRequest({ isRscRequest: true, request: loadingRequest }),
      ).resolves.toBeNull();

      const bareLoadingResponse = await resolveInvalidRscCacheBustingRequest({
        isRscRequest: true,
        request: new Request("https://example.com/photos/42?_rsc", { headers: loadingHeaders }),
      });
      expect(bareLoadingResponse?.status).toBe(307);
      expect(bareLoadingResponse?.headers.get("location")).toBe(loadingPath);

      const contextual = createCanonicalLoadingShellRscRequestHeaders();
      contextual.set("next-url", "/source");
      const response = await resolveInvalidRscCacheBustingRequest({
        isRscRequest: true,
        request: new Request("https://example.com/photos/42?_rsc", { headers: contextual }),
      });
      expect(response?.status).toBe(307);
      expect(response?.headers.get("location")).toMatch(/_rsc=.+/);
    });
  });

  it("preserves full and loading-shell identities across same-origin RSC redirects", async () => {
    await withEnvVar("__VINEXT_CANONICAL_RSC_REQUESTS", "1", async () => {
      const fullHeaders = createCanonicalRscRequestHeaders();
      await expect(
        createRscRedirectLocation(
          "/redirected?tab=1",
          new Request("https://example.com/photos/42?_rsc", { headers: fullHeaders }),
        ),
      ).resolves.toBe("https://example.com/redirected?tab=1&_rsc");

      const loadingHeaders = createCanonicalLoadingShellRscRequestHeaders();
      await expect(
        createRscRedirectLocation(
          "/redirected?tab=1",
          new Request("https://example.com/photos/42?_rsc", { headers: loadingHeaders }),
        ),
      ).resolves.toBe("https://example.com/redirected?tab=1&_rsc=9qLBDIU2NgN178cB");
    });
  });

  it("redirects bare loading-shell requests for adapters without strict Vary", async () => {
    await withEnvVar("__VINEXT_CANONICAL_RSC_REQUESTS", undefined, async () => {
      const headers = createCanonicalLoadingShellRscRequestHeaders();
      const response = await resolveInvalidRscCacheBustingRequest({
        isRscRequest: true,
        request: new Request("https://example.com/photos/42?_rsc", { headers }),
      });
      expect(response?.status).toBe(307);
      expect(response?.headers.get("location")).toMatch(/_rsc=.+/);
    });
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

  it("canonicalizes interception id requests whose hash omits the id", async () => {
    const interceptionId = "interception:slot:modal:/feed:/feed->/photos/:id";
    const headers = createRscRequestHeaders({
      interceptionContext: "/feed",
      interceptionId,
    });
    const previousHash = await sha256CacheBustingHash("0,0,0,0,/feed,0,0");
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

  it("accepts the prior bare navigation query after adding the state fingerprint", async () => {
    const headers = createRscRequestHeaders({
      routerState: { pathAndSearch: "/current", routeId: "route:/current" },
    });
    const request = new Request("https://example.com/photos/42?_rsc", { headers });

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
    // Mirrors Next.js App Router's base Vary header:
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/app-page/module.ts
    expect(VINEXT_RSC_VARY_HEADER).toBe(
      "RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch, Next-Url, X-Vinext-Interception-Context, X-Vinext-Interception-Id, X-Vinext-Mounted-Slots, X-Vinext-Rsc-Render-Mode, X-Vinext-Rsc-State-Fingerprint",
    );
    expect(VINEXT_RSC_VARY_HEADER.split(", ")).not.toContain("Accept");
    expect(FLIGHT_HEADERS).toContain(VINEXT_RSC_STATE_FINGERPRINT_HEADER.toLowerCase());
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

  it("applies the built RSC identity to response headers", () => {
    const headers = new Headers();

    withEnvVar("__VINEXT_RSC_BUILD_IDENTITY", "build-a", () =>
      applyRscCompatibilityIdHeader(headers),
    );

    expect(headers.get(VINEXT_RSC_BUILD_ID_HEADER)).toBe("build-a");
  });

  it("leaves the Next.js deployment ID header out of compatibility-only response headers", () => {
    const headers = new Headers();

    withEnvVar("__VINEXT_DEPLOYMENT_ID", "deployment-a", () =>
      applyRscCompatibilityIdHeader(headers, "compat-a"),
    );

    expect(headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER)).toBe("compat-a");
    expect(headers.has("x-nextjs-deployment-id")).toBe(false);
  });

  it("applies the Next.js deployment ID header to App Router RSC page response headers", () => {
    const headers = new Headers();

    withEnvVar("__VINEXT_DEPLOYMENT_ID", "deployment-a", () => applyRscDeploymentIdHeader(headers));

    expect(headers.get("x-nextjs-deployment-id")).toBe("deployment-a");
  });

  it("removes a spoofed Next.js deployment ID header when none is configured", () => {
    const headers = new Headers({
      "x-nextjs-deployment-id": "spoofed-deployment",
    });

    withEnvVar("__VINEXT_DEPLOYMENT_ID", undefined, () =>
      withEnvVar("NEXT_DEPLOYMENT_ID", undefined, () => applyRscDeploymentIdHeader(headers)),
    );

    expect(headers.has("x-nextjs-deployment-id")).toBe(false);
  });

  it("removes a spoofed compatibility ID header when no framework ID is available", () => {
    const headers = new Headers({
      [VINEXT_RSC_BUILD_ID_HEADER]: "spoofed-build",
      [VINEXT_RSC_COMPATIBILITY_ID_HEADER]: "spoofed-compat",
    });

    applyRscCompatibilityIdHeader(headers, "", "");

    expect(headers.has(VINEXT_RSC_BUILD_ID_HEADER)).toBe(false);
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
