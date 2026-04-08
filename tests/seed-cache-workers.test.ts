/**
 * Tests for Workers-side lazy cache seeding from pre-rendered assets.
 *
 * Verifies that seedRouteFromAssets() fetches pre-rendered HTML/RSC from
 * the assets binding and populates the MemoryCacheHandler per-route on
 * first request, with dedup for concurrent cold hits.
 */
import { describe, it, expect, beforeEach } from "vite-plus/test";
import {
  MemoryCacheHandler,
  setCacheHandler,
  getCacheHandler,
} from "../packages/vinext/src/shims/cache.js";
import { isrCacheKey, getRevalidateDuration } from "../packages/vinext/src/server/isr-cache.js";
import {
  seedRouteFromAssets,
  _resetForTesting,
} from "../packages/vinext/src/server/seed-cache-workers.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BUILD_ID = "workers-test-build";

/** Minimal prerender manifest for testing. */
function makeManifest(routes: unknown[], trailingSlash = false) {
  return {
    buildId: BUILD_ID,
    trailingSlash,
    routes,
  };
}

/**
 * Create a mock asset fetcher backed by an in-memory file map.
 * Simulates env.ASSETS.fetch() without a real Workers environment.
 */
function createMockFetcher(files: Record<string, string>) {
  const calls: string[] = [];
  const fetcher = async (assetPath: string): Promise<Response> => {
    calls.push(assetPath);
    const content = files[assetPath];
    if (content === undefined) {
      return new Response("Not Found", { status: 404 });
    }
    return new Response(content, { status: 200 });
  };
  return { fetcher, calls };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("seedRouteFromAssets", () => {
  beforeEach(() => {
    setCacheHandler(new MemoryCacheHandler());
    _resetForTesting();
  });

  // ── Basic seeding ─────────────────────────────────────────────────────────

  it("seeds HTML and RSC from assets on cache miss", async () => {
    const manifest = makeManifest([
      { route: "/about", status: "rendered", revalidate: 60, router: "app" },
    ]);
    const { fetcher } = createMockFetcher({
      "/__prerender/vinext-prerender.json": JSON.stringify(manifest),
      "/__prerender/about.html": "<html>About</html>",
      "/__prerender/about.rsc": "RSC about payload",
    });

    await seedRouteFromAssets("/about", fetcher);

    // HTML should be cached
    const htmlKey = isrCacheKey("app", "/about", BUILD_ID) + ":html";
    const htmlEntry = await getCacheHandler().get(htmlKey);
    expect(htmlEntry).not.toBeNull();
    expect(htmlEntry?.value?.kind).toBe("APP_PAGE");
    if (htmlEntry?.value?.kind === "APP_PAGE") {
      expect(htmlEntry.value.html).toBe("<html>About</html>");
    }

    // RSC should be cached
    const rscKey = isrCacheKey("app", "/about", BUILD_ID) + ":rsc";
    const rscEntry = await getCacheHandler().get(rscKey);
    expect(rscEntry).not.toBeNull();
    if (rscEntry?.value?.kind === "APP_PAGE") {
      const rscText = new TextDecoder().decode(rscEntry.value.rscData!);
      expect(rscText).toBe("RSC about payload");
    }
  });

  it("seeds the index route", async () => {
    const manifest = makeManifest([
      { route: "/", status: "rendered", revalidate: 30, router: "app" },
    ]);
    const { fetcher } = createMockFetcher({
      "/__prerender/vinext-prerender.json": JSON.stringify(manifest),
      "/__prerender/index.html": "<html>Home</html>",
      "/__prerender/index.rsc": "RSC home",
    });

    await seedRouteFromAssets("/", fetcher);

    const htmlKey = isrCacheKey("app", "/", BUILD_ID) + ":html";
    const entry = await getCacheHandler().get(htmlKey);
    expect(entry).not.toBeNull();
  });

  it("seeds trailing-slash routes when request pathname has trailing slash", async () => {
    const manifest = makeManifest(
      [{ route: "/about", status: "rendered", revalidate: 30, router: "app" }],
      true,
    );
    const { fetcher, calls } = createMockFetcher({
      "/__prerender/vinext-prerender.json": JSON.stringify(manifest),
      "/__prerender/about/index.html": "<html>About</html>",
      "/__prerender/about.rsc": "RSC about",
    });

    await seedRouteFromAssets("/about/", fetcher);

    const htmlKey = isrCacheKey("app", "/about", BUILD_ID) + ":html";
    expect(await getCacheHandler().get(htmlKey)).not.toBeNull();
    expect(calls).toContain("/__prerender/about/index.html");
  });

  it("seeds when request pathname uses .rsc suffix", async () => {
    const manifest = makeManifest([
      { route: "/about", status: "rendered", revalidate: 30, router: "app" },
    ]);
    const { fetcher } = createMockFetcher({
      "/__prerender/vinext-prerender.json": JSON.stringify(manifest),
      "/__prerender/about.html": "<html>About</html>",
      "/__prerender/about.rsc": "RSC about",
    });

    await seedRouteFromAssets("/about.rsc", fetcher);

    const htmlKey = isrCacheKey("app", "/about", BUILD_ID) + ":html";
    expect(await getCacheHandler().get(htmlKey)).not.toBeNull();
  });

  it("strips basePath from request pathname before manifest lookup", async () => {
    const manifest = {
      ...makeManifest([{ route: "/about", status: "rendered", revalidate: 30, router: "app" }]),
      basePath: "/docs",
    };
    const { fetcher, calls } = createMockFetcher({
      "/__prerender/vinext-prerender.json": JSON.stringify(manifest),
      "/__prerender/about.html": "<html>About</html>",
      "/__prerender/about.rsc": "RSC about",
    });

    await seedRouteFromAssets("/docs/about", fetcher);

    const htmlKey = isrCacheKey("app", "/about", BUILD_ID) + ":html";
    expect(await getCacheHandler().get(htmlKey)).not.toBeNull();
    expect(calls).toContain("/__prerender/about.html");
  });

  it("seeds dynamic routes using their concrete path", async () => {
    const manifest = makeManifest([
      {
        route: "/blog/:slug",
        status: "rendered",
        revalidate: 120,
        path: "/blog/hello",
        router: "app",
      },
    ]);
    const { fetcher } = createMockFetcher({
      "/__prerender/vinext-prerender.json": JSON.stringify(manifest),
      "/__prerender/blog/hello.html": "<html>Blog</html>",
      "/__prerender/blog/hello.rsc": "RSC blog",
    });

    await seedRouteFromAssets("/blog/hello", fetcher);

    const htmlKey = isrCacheKey("app", "/blog/hello", BUILD_ID) + ":html";
    expect(await getCacheHandler().get(htmlKey)).not.toBeNull();
  });

  // ── No-ops ────────────────────────────────────────────────────────────────

  it("is a no-op when manifest is missing from assets", async () => {
    const { fetcher } = createMockFetcher({});

    await seedRouteFromAssets("/about", fetcher);

    const htmlKey = isrCacheKey("app", "/about", BUILD_ID) + ":html";
    expect(await getCacheHandler().get(htmlKey)).toBeNull();
  });

  it("is a no-op for non-prerendered routes", async () => {
    const manifest = makeManifest([
      { route: "/about", status: "rendered", revalidate: 60, router: "app" },
    ]);
    const { fetcher } = createMockFetcher({
      "/__prerender/vinext-prerender.json": JSON.stringify(manifest),
    });

    await seedRouteFromAssets("/not-prerendered", fetcher);

    const htmlKey = isrCacheKey("app", "/not-prerendered", BUILD_ID) + ":html";
    expect(await getCacheHandler().get(htmlKey)).toBeNull();
  });

  it("is a no-op when route is already cached", async () => {
    const manifest = makeManifest([
      { route: "/about", status: "rendered", revalidate: 60, router: "app" },
    ]);
    const { fetcher, calls } = createMockFetcher({
      "/__prerender/vinext-prerender.json": JSON.stringify(manifest),
      "/__prerender/about.html": "<html>About</html>",
      "/__prerender/about.rsc": "RSC about",
    });

    // Seed once
    await seedRouteFromAssets("/about", fetcher);
    const callsAfterFirst = calls.length;

    // Second call should not fetch assets again
    await seedRouteFromAssets("/about", fetcher);
    expect(calls.length).toBe(callsAfterFirst);
  });

  // ── Concurrent dedup ──────────────────────────────────────────────────────

  it("deduplicates concurrent seed requests for the same route", async () => {
    const manifest = makeManifest([
      { route: "/about", status: "rendered", revalidate: 60, router: "app" },
    ]);
    const { fetcher, calls } = createMockFetcher({
      "/__prerender/vinext-prerender.json": JSON.stringify(manifest),
      "/__prerender/about.html": "<html>About</html>",
      "/__prerender/about.rsc": "RSC about",
    });

    // Fire two seeds concurrently
    await Promise.all([
      seedRouteFromAssets("/about", fetcher),
      seedRouteFromAssets("/about", fetcher),
    ]);

    // HTML file should only be fetched once (deduped)
    const htmlFetches = calls.filter((c) => c === "/__prerender/about.html");
    expect(htmlFetches.length).toBe(1);
  });

  // ── Manifest caching ─────────────────────────────────────────────────────

  it("caches the manifest across multiple routes", async () => {
    const manifest = makeManifest([
      { route: "/a", status: "rendered", revalidate: 60, router: "app" },
      { route: "/b", status: "rendered", revalidate: 60, router: "app" },
    ]);
    const { fetcher, calls } = createMockFetcher({
      "/__prerender/vinext-prerender.json": JSON.stringify(manifest),
      "/__prerender/a.html": "<html>A</html>",
      "/__prerender/a.rsc": "RSC a",
      "/__prerender/b.html": "<html>B</html>",
      "/__prerender/b.rsc": "RSC b",
    });

    await seedRouteFromAssets("/a", fetcher);
    await seedRouteFromAssets("/b", fetcher);

    // Manifest should be fetched only once
    const manifestFetches = calls.filter((c) => c.includes("vinext-prerender.json"));
    expect(manifestFetches.length).toBe(1);
  });

  // ── Revalidate duration tracking ────────────────────────────────────────

  it("populates revalidate duration map for ISR routes", async () => {
    const manifest = makeManifest([
      { route: "/isr", status: "rendered", revalidate: 45, router: "app" },
    ]);
    const { fetcher } = createMockFetcher({
      "/__prerender/vinext-prerender.json": JSON.stringify(manifest),
      "/__prerender/isr.html": "<html>ISR</html>",
      "/__prerender/isr.rsc": "RSC isr",
    });

    await seedRouteFromAssets("/isr", fetcher);

    const baseKey = isrCacheKey("app", "/isr", BUILD_ID);
    expect(getRevalidateDuration(baseKey + ":html")).toBe(45);
    expect(getRevalidateDuration(baseKey + ":rsc")).toBe(45);
  });

  it("does not set revalidate duration for static routes", async () => {
    const manifest = makeManifest([
      { route: "/static", status: "rendered", revalidate: false, router: "app" },
    ]);
    const { fetcher } = createMockFetcher({
      "/__prerender/vinext-prerender.json": JSON.stringify(manifest),
      "/__prerender/static.html": "<html>Static</html>",
      "/__prerender/static.rsc": "RSC static",
    });

    await seedRouteFromAssets("/static", fetcher);

    const baseKey = isrCacheKey("app", "/static", BUILD_ID);
    expect(getRevalidateDuration(baseKey + ":html")).toBeUndefined();
    expect(getRevalidateDuration(baseKey + ":rsc")).toBeUndefined();
  });

  // ── Concurrent dedup (with async yield) ─────────────────────────────────

  it("deduplicates concurrent seed requests even when fetches yield", async () => {
    const manifest = makeManifest([
      { route: "/slow", status: "rendered", revalidate: 60, router: "app" },
    ]);
    const calls: string[] = [];
    const fetcher = async (assetPath: string): Promise<Response> => {
      calls.push(assetPath);
      // Yield to the event loop to simulate real async I/O
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (assetPath.includes("vinext-prerender.json")) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      if (assetPath.includes("slow.html")) {
        return new Response("<html>Slow</html>", { status: 200 });
      }
      if (assetPath.includes("slow.rsc")) {
        return new Response("RSC slow", { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    await Promise.all([
      seedRouteFromAssets("/slow", fetcher),
      seedRouteFromAssets("/slow", fetcher),
    ]);

    const htmlFetches = calls.filter((c) => c === "/__prerender/slow.html");
    expect(htmlFetches.length).toBe(1);
  });

  // ── Error resilience ───────────────────────────────────────────────────────

  it("does not throw when asset fetch fails", async () => {
    const manifest = makeManifest([
      { route: "/fail", status: "rendered", revalidate: 60, router: "app" },
    ]);
    const fetcher = async (assetPath: string): Promise<Response> => {
      if (assetPath.includes("vinext-prerender.json")) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      throw new Error("network failure");
    };

    // Should not throw — seeding is best-effort
    await seedRouteFromAssets("/fail", fetcher);

    const htmlKey = isrCacheKey("app", "/fail", BUILD_ID) + ":html";
    expect(await getCacheHandler().get(htmlKey)).toBeNull();
  });

  it("does not throw when cache handler fails", async () => {
    const manifest = makeManifest([
      { route: "/broken", status: "rendered", revalidate: 60, router: "app" },
    ]);
    const { fetcher } = createMockFetcher({
      "/__prerender/vinext-prerender.json": JSON.stringify(manifest),
      "/__prerender/broken.html": "<html>Broken</html>",
      "/__prerender/broken.rsc": "RSC broken",
    });

    // Sabotage the cache handler
    const handler = getCacheHandler();
    handler.set = () => {
      throw new Error("cache write failed");
    };

    await seedRouteFromAssets("/broken", fetcher);
    // No assertion needed — test passes if it doesn't throw
  });

  it("retries manifest load after transient fetch failure", async () => {
    let manifestCallCount = 0;
    const manifest = makeManifest([
      { route: "/retry", status: "rendered", revalidate: 60, router: "app" },
    ]);

    const fetcher = async (assetPath: string): Promise<Response> => {
      if (assetPath.includes("vinext-prerender.json")) {
        manifestCallCount++;
        if (manifestCallCount === 1) {
          throw new Error("transient network error");
        }
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      if (assetPath.includes("retry.html")) {
        return new Response("<html>Retry</html>", { status: 200 });
      }
      if (assetPath.includes("retry.rsc")) {
        return new Response("RSC retry", { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    // First call — transient failure, no seeding
    await seedRouteFromAssets("/retry", fetcher);
    expect(
      await getCacheHandler().get(isrCacheKey("app", "/retry", BUILD_ID) + ":html"),
    ).toBeNull();

    // Second call — should retry manifest load and succeed
    await seedRouteFromAssets("/retry", fetcher);
    expect(
      await getCacheHandler().get(isrCacheKey("app", "/retry", BUILD_ID) + ":html"),
    ).not.toBeNull();
    expect(manifestCallCount).toBe(2);
  });

  it("does not retry manifest load after permanent 404", async () => {
    let manifestCallCount = 0;

    const fetcher = async (assetPath: string): Promise<Response> => {
      if (assetPath.includes("vinext-prerender.json")) {
        manifestCallCount++;
        return new Response("Not Found", { status: 404 });
      }
      return new Response("Not Found", { status: 404 });
    };

    await seedRouteFromAssets("/a", fetcher);
    await seedRouteFromAssets("/b", fetcher);

    // Manifest 404 is permanent — should not retry
    expect(manifestCallCount).toBe(1);
  });

  // ── Graceful degradation ──────────────────────────────────────────────────

  it("seeds HTML even when RSC file is missing", async () => {
    const manifest = makeManifest([
      { route: "/html-only", status: "rendered", revalidate: 60, router: "app" },
    ]);
    const { fetcher } = createMockFetcher({
      "/__prerender/vinext-prerender.json": JSON.stringify(manifest),
      "/__prerender/html-only.html": "<html>HTML only</html>",
      // No .rsc file
    });

    await seedRouteFromAssets("/html-only", fetcher);

    const htmlKey = isrCacheKey("app", "/html-only", BUILD_ID) + ":html";
    expect(await getCacheHandler().get(htmlKey)).not.toBeNull();

    const rscKey = isrCacheKey("app", "/html-only", BUILD_ID) + ":rsc";
    expect(await getCacheHandler().get(rscKey)).toBeNull();
  });
});
