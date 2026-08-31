import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createRscRequestHeaders,
  createRscRequestUrl,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import { APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL } from "../packages/vinext/src/server/app-rsc-render-mode.js";
import {
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
} from "../packages/vinext/src/server/headers.js";
import { resolveAppPrefetchRscRequest } from "../packages/vinext/src/shims/internal/app-prefetch-rsc-request.js";

const DEFAULT_OPTIONS = {
  canUseCanonicalLoadingShell: true,
  interceptionContext: null,
  mountedSlotsHeader: null,
  prefetchInlining: false,
  requiresRouteTreePrefetch: false,
  rewrittenPrefetchHref: null,
} as const;

type ContextualCaseOverrides = {
  canonical?: boolean;
  interceptionContext?: string | null;
  mountedSlotsHeader?: string | null;
  prefetchInlining?: boolean;
  requiresRouteTreePrefetch?: boolean;
};

const CONTEXTUAL_CASES: Array<[string, ContextualCaseOverrides]> = [
  ["canonical sharing is disabled", { canonical: false }],
  ["an interception context is present", { interceptionContext: "/feed" }],
  ["mounted slots are present", { mountedSlotsHeader: "slot-a" }],
  ["a route-tree prefetch is required", { requiresRouteTreePrefetch: true }],
  ["prefetch inlining is enabled", { prefetchInlining: true }],
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("shared App Router prefetch RSC request resolution", () => {
  it("normalizes a shareable full request to the deploy-warmer identity", async () => {
    vi.stubEnv("__VINEXT_CANONICAL_RSC_REQUESTS", "1");
    const headers = createRscRequestHeaders({
      nextUrl: "/source",
      prefetchRouterState: { pathAndSearch: "/source", routeId: "route:/source" },
    });
    headers.set(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER, "1");

    const resolved = await resolveAppPrefetchRscRequest({
      ...DEFAULT_OPTIONS,
      fullHref: "/target?tab=latest#section",
      headers,
    });

    expect(resolved).toEqual({
      additionalRscUrls: [],
      rscUrl: "/target?tab=latest&_rsc",
      usesCanonicalPrewarmedRequest: true,
    });
    expect(Object.fromEntries(headers)).toEqual({
      accept: "text/x-component",
      rsc: "1",
    });
  });

  it("normalizes a shareable loading shell to its deterministic warmed identity", async () => {
    vi.stubEnv("__VINEXT_CANONICAL_RSC_REQUESTS", "1");
    const headers = createRscRequestHeaders({
      nextUrl: "/source",
      prefetchRouterState: { pathAndSearch: "/source", routeId: "route:/source" },
      renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
    });
    headers.set(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER, "/__PAGE__");

    const resolved = await resolveAppPrefetchRscRequest({
      ...DEFAULT_OPTIONS,
      fullHref: "/target",
      headers,
    });

    expect(resolved).toEqual({
      additionalRscUrls: [],
      rscUrl: "/target?_rsc=9qLBDIU2NgN178cB",
      usesCanonicalPrewarmedRequest: true,
    });
    expect(headers.get(NEXT_ROUTER_PREFETCH_HEADER)).toBe("1");
    expect(headers.get(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER)).toBe("1");
    expect(headers.get("next-router-state-tree")).toBeNull();
    expect(headers.get("next-url")).toBeNull();
  });

  it("keeps non-main-tree loading shells contextual", async () => {
    vi.stubEnv("__VINEXT_CANONICAL_RSC_REQUESTS", "1");
    const headers = createRscRequestHeaders({
      nextUrl: "/source",
      prefetchRouterState: { pathAndSearch: "/source", routeId: "route:/source" },
      renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
    });
    headers.set(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER, "1");
    const expectedUrl = await createRscRequestUrl("/parallel", new Headers(headers));

    const resolved = await resolveAppPrefetchRscRequest({
      ...DEFAULT_OPTIONS,
      canUseCanonicalLoadingShell: false,
      fullHref: "/parallel",
      headers,
    });

    expect(resolved).toEqual({
      additionalRscUrls: [],
      rscUrl: expectedUrl,
      usesCanonicalPrewarmedRequest: false,
    });
    expect(headers.get("next-url")).toBe("/source");
    expect(new URL(expectedUrl, "http://vinext.local").searchParams.get("_rsc")).not.toBe("");
  });

  it.each(CONTEXTUAL_CASES)("keeps the request contextual when %s", async (_label, overrides) => {
    const { canonical = true, ...requestOverrides } = overrides;
    vi.stubEnv("__VINEXT_CANONICAL_RSC_REQUESTS", canonical ? "1" : "");
    const headers = createRscRequestHeaders({ nextUrl: "/source" });
    const expectedUrl = await createRscRequestUrl("/target", new Headers(headers));

    const resolved = await resolveAppPrefetchRscRequest({
      ...DEFAULT_OPTIONS,
      ...requestOverrides,
      fullHref: "/target",
      headers,
    });

    expect(resolved).toEqual({
      additionalRscUrls: [],
      rscUrl: expectedUrl,
      usesCanonicalPrewarmedRequest: false,
    });
    expect(headers.get("next-url")).toBe("/source");
  });

  it("keeps rewritten source and destination request identities together", async () => {
    vi.stubEnv("__VINEXT_CANONICAL_RSC_REQUESTS", "1");
    const headers = createRscRequestHeaders({ nextUrl: "/source" });
    const sourceUrl = await createRscRequestUrl("/source", new Headers(headers));
    const destinationUrl = await createRscRequestUrl("/destination", new Headers(headers));

    const resolved = await resolveAppPrefetchRscRequest({
      ...DEFAULT_OPTIONS,
      fullHref: "/source",
      headers,
      rewrittenPrefetchHref: "/destination",
    });

    expect(resolved).toEqual({
      additionalRscUrls: [destinationUrl],
      rscUrl: sourceUrl,
      usesCanonicalPrewarmedRequest: false,
    });
  });

  it("prefers the exported .txt artifact over deploy-warmer request sharing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("__NEXT_CONFIG_OUTPUT", "export");
    vi.stubEnv("__VINEXT_CANONICAL_RSC_REQUESTS", "1");
    vi.stubGlobal("window", {});
    const headers = createRscRequestHeaders({ nextUrl: "/source" });

    await expect(
      resolveAppPrefetchRscRequest({
        ...DEFAULT_OPTIONS,
        fullHref: "/target/",
        headers,
      }),
    ).resolves.toEqual({
      additionalRscUrls: [],
      rscUrl: "/target/index.txt",
      usesCanonicalPrewarmedRequest: false,
    });
  });
});
