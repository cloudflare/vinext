import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createRscRequestHeaders,
  createRscRequestUrl,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import { resolveAppPrefetchRscRequest } from "../packages/vinext/src/shims/internal/app-prefetch-rsc-request.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("App Router prefetch RSC request resolution", () => {
  it("keeps the browser request contextual for server-side normalization", async () => {
    const headers = createRscRequestHeaders({
      nextUrl: "/source",
      prefetchRouterState: { pathAndSearch: "/source", routeId: "route:/source" },
    });
    const expectedUrl = await createRscRequestUrl("/target?tab=latest#section", headers);

    await expect(
      resolveAppPrefetchRscRequest({
        fullHref: "/target?tab=latest#section",
        headers,
        rewrittenPrefetchHref: null,
      }),
    ).resolves.toEqual({ additionalRscUrls: [], rscUrl: expectedUrl });
    expect(headers.get("next-router-state-tree")).not.toBeNull();
    expect(headers.get("next-url")).toBe("/source");
  });

  it("keeps rewritten source and destination request identities together", async () => {
    const headers = createRscRequestHeaders({ nextUrl: "/source" });
    const sourceUrl = await createRscRequestUrl("/source", new Headers(headers));
    const destinationUrl = await createRscRequestUrl("/destination", new Headers(headers));

    await expect(
      resolveAppPrefetchRscRequest({
        fullHref: "/source",
        headers,
        rewrittenPrefetchHref: "/destination",
      }),
    ).resolves.toEqual({ additionalRscUrls: [destinationUrl], rscUrl: sourceUrl });
  });

  it("uses the exported .txt artifact", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("__NEXT_CONFIG_OUTPUT", "export");
    vi.stubGlobal("window", {});

    await expect(
      resolveAppPrefetchRscRequest({
        fullHref: "/target/",
        headers: createRscRequestHeaders({ nextUrl: "/source" }),
        rewrittenPrefetchHref: null,
      }),
    ).resolves.toEqual({ additionalRscUrls: [], rscUrl: "/target/index.txt" });
  });
});
