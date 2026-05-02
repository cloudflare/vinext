/**
 * Tests for seeding the memory cache from pre-rendered routes.
 *
 * Verifies that seedMemoryCacheFromPrerender() reads vinext-prerender.json
 * and the corresponding HTML/RSC files from disk, then populates the
 * CacheHandler so pre-rendered pages are served as cache HITs on first request.
 */
import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  MemoryCacheHandler,
  setCacheHandler,
  getCacheHandler,
  type CacheHandler,
  type CacheHandlerValue,
  type IncrementalCacheValue,
} from "../packages/vinext/src/shims/cache.js";
import { isrCacheKey, getRevalidateDuration } from "../packages/vinext/src/server/isr-cache.js";
import { seedMemoryCacheFromPrerender } from "../packages/vinext/src/server/seed-cache.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTempServerDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vinext-seed-cache-"));
}

/**
 * Write a vinext-prerender.json manifest and corresponding pre-rendered files
 * to a temporary directory structure matching the production build layout.
 */
function setupPrerenderFixture(
  serverDir: string,
  manifest: { buildId: string; trailingSlash?: boolean; routes: unknown[] },
  files: Record<string, string>,
): void {
  fs.writeFileSync(
    path.join(serverDir, "vinext-prerender.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );

  const prerenderDir = path.join(serverDir, "prerendered-routes");
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(prerenderDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
  }
}

/**
 * Write raw content to vinext-prerender.json (for corrupt manifest tests).
 */
function writeRawManifest(serverDir: string, content: string): void {
  fs.writeFileSync(path.join(serverDir, "vinext-prerender.json"), content, "utf-8");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("seedMemoryCacheFromPrerender", () => {
  let serverDir: string;

  beforeEach(() => {
    serverDir = createTempServerDir();
    setCacheHandler(new MemoryCacheHandler());
  });

  afterEach(() => {
    fs.rmSync(serverDir, { recursive: true, force: true });
  });

  // ── App Router ISR routes ─────────────────────────────────────────────────

  it("seeds App Router ISR routes with HTML and RSC entries", async () => {
    const buildId = "test-build-001";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [{ route: "/about", status: "rendered", revalidate: 60, router: "app" }],
      },
      {
        "about.html": "<html><body>About page</body></html>",
        "about.rsc": "RSC payload for about",
      },
    );

    await seedMemoryCacheFromPrerender(serverDir);

    const htmlKey = isrCacheKey("app", "/about", buildId) + ":html";
    const htmlEntry = await getCacheHandler().get(htmlKey);
    expect(htmlEntry).not.toBeNull();
    const htmlValue = htmlEntry?.value;
    expect(htmlValue).not.toBeNull();
    expect(htmlValue?.kind).toBe("APP_PAGE");
    if (htmlValue?.kind === "APP_PAGE") {
      expect(htmlValue.html).toBe("<html><body>About page</body></html>");
    }

    const rscKey = isrCacheKey("app", "/about", buildId) + ":rsc";
    const rscEntry = await getCacheHandler().get(rscKey);
    expect(rscEntry).not.toBeNull();
    const rscValue = rscEntry?.value;
    expect(rscValue).not.toBeNull();
    expect(rscValue?.kind).toBe("APP_PAGE");
    if (rscValue?.kind === "APP_PAGE") {
      expect(rscValue.rscData).toBeDefined();
      const rscText = new TextDecoder().decode(rscValue.rscData!);
      expect(rscText).toBe("RSC payload for about");
    }
  });

  it("seeds the index route correctly", async () => {
    const buildId = "test-build-002";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [{ route: "/", status: "rendered", revalidate: 30, router: "app" }],
      },
      {
        "index.html": "<html><body>Home</body></html>",
        "index.rsc": "RSC payload for index",
      },
    );

    await seedMemoryCacheFromPrerender(serverDir);

    const htmlKey = isrCacheKey("app", "/", buildId) + ":html";
    const htmlEntry = await getCacheHandler().get(htmlKey);
    expect(htmlEntry).not.toBeNull();
    expect(htmlEntry?.value?.kind).toBe("APP_PAGE");
  });

  it("seeds dynamic routes using their concrete path", async () => {
    const buildId = "test-build-003";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [
          {
            route: "/blog/:slug",
            status: "rendered",
            revalidate: 120,
            path: "/blog/hello-world",
            router: "app",
          },
        ],
      },
      {
        "blog/hello-world.html": "<html><body>Blog post</body></html>",
        "blog/hello-world.rsc": "RSC blog payload",
      },
    );

    await seedMemoryCacheFromPrerender(serverDir);

    const htmlKey = isrCacheKey("app", "/blog/hello-world", buildId) + ":html";
    const htmlEntry = await getCacheHandler().get(htmlKey);
    expect(htmlEntry).not.toBeNull();
    expect(htmlEntry?.value?.kind).toBe("APP_PAGE");
  });

  // ── Return value ──────────────────────────────────────────────────────────

  it("returns the number of seeded routes", async () => {
    setupPrerenderFixture(
      serverDir,
      {
        buildId: "count-test",
        routes: [
          { route: "/a", status: "rendered", revalidate: 60, router: "app" },
          { route: "/b", status: "rendered", revalidate: 60, router: "app" },
          { route: "/c", status: "skipped", reason: "ssr" },
        ],
      },
      {
        "a.html": "<html>A</html>",
        "a.rsc": "RSC a",
        "b.html": "<html>B</html>",
        "b.rsc": "RSC b",
      },
    );

    const count = await seedMemoryCacheFromPrerender(serverDir);
    expect(count).toBe(2);
  });

  it("returns 0 when no manifest exists", async () => {
    const count = await seedMemoryCacheFromPrerender(serverDir);
    expect(count).toBe(0);
  });

  // ── Revalidate duration tracking ──────────────────────────────────────────

  it("populates revalidate duration map for ISR routes", async () => {
    const buildId = "reval-duration-test";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [{ route: "/isr", status: "rendered", revalidate: 45, router: "app" }],
      },
      {
        "isr.html": "<html>ISR</html>",
        "isr.rsc": "RSC isr",
      },
    );

    await seedMemoryCacheFromPrerender(serverDir);

    const baseKey = isrCacheKey("app", "/isr", buildId);
    expect(getRevalidateDuration(baseKey + ":html")).toBe(45);
    expect(getRevalidateDuration(baseKey + ":rsc")).toBe(45);
  });

  it("preserves legacy revalidate context while writing cache-control metadata", async () => {
    const contexts: Record<string, unknown>[] = [];
    const handler: CacheHandler = {
      async get(): Promise<CacheHandlerValue | null> {
        return null;
      },
      async set(
        _key: string,
        _data: IncrementalCacheValue | null,
        ctx?: Record<string, unknown>,
      ): Promise<void> {
        contexts.push(ctx ?? {});
      },
      async revalidateTag(): Promise<void> {
        // not used by this test
      },
    };
    setCacheHandler(handler);

    setupPrerenderFixture(
      serverDir,
      {
        buildId: "seed-context-test",
        routes: [{ route: "/isr", status: "rendered", revalidate: 60, expire: 300, router: "app" }],
      },
      {
        "isr.html": "<html>ISR</html>",
        "isr.rsc": "RSC isr",
      },
    );

    await seedMemoryCacheFromPrerender(serverDir);

    expect(contexts).toEqual([
      { cacheControl: { revalidate: 60, expire: 300 }, revalidate: 60 },
      { cacheControl: { revalidate: 60, expire: 300 }, revalidate: 60 },
    ]);
  });

  it("does not set revalidate duration for static routes", async () => {
    const buildId = "static-duration-test";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [{ route: "/static", status: "rendered", revalidate: false, router: "app" }],
      },
      {
        "static.html": "<html>Static</html>",
        "static.rsc": "RSC static",
      },
    );

    await seedMemoryCacheFromPrerender(serverDir);

    const baseKey = isrCacheKey("app", "/static", buildId);
    expect(getRevalidateDuration(baseKey + ":html")).toBeUndefined();
    expect(getRevalidateDuration(baseKey + ":rsc")).toBeUndefined();
  });

  // ── Static routes (revalidate: false) ─────────────────────────────────────

  it("seeds static routes (revalidate: false) with no expiry", async () => {
    const buildId = "test-build-004";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [{ route: "/static", status: "rendered", revalidate: false, router: "app" }],
      },
      {
        "static.html": "<html><body>Static page</body></html>",
        "static.rsc": "RSC static payload",
      },
    );

    await seedMemoryCacheFromPrerender(serverDir);

    const htmlKey = isrCacheKey("app", "/static", buildId) + ":html";
    const htmlEntry = await getCacheHandler().get(htmlKey);
    expect(htmlEntry).not.toBeNull();
    expect(htmlEntry?.cacheState).toBeUndefined();
  });

  // ── Skipped and errored routes ────────────────────────────────────────────

  it("does not seed skipped routes", async () => {
    const buildId = "test-build-005";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [
          { route: "/ssr-page", status: "skipped", reason: "ssr" },
          { route: "/about", status: "rendered", revalidate: 60, router: "app" },
        ],
      },
      {
        "about.html": "<html><body>About</body></html>",
        "about.rsc": "RSC about",
      },
    );

    await seedMemoryCacheFromPrerender(serverDir);

    const skippedKey = isrCacheKey("app", "/ssr-page", buildId) + ":html";
    expect(await getCacheHandler().get(skippedKey)).toBeNull();

    const aboutKey = isrCacheKey("app", "/about", buildId) + ":html";
    expect(await getCacheHandler().get(aboutKey)).not.toBeNull();
  });

  it("does not seed errored routes", async () => {
    const buildId = "test-build-006";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [{ route: "/broken", status: "error", error: "render failed" }],
      },
      {},
    );

    const count = await seedMemoryCacheFromPrerender(serverDir);
    expect(count).toBe(0);
  });

  // ── Multiple routes ───────────────────────────────────────────────────────

  it("seeds multiple routes in one pass", async () => {
    const buildId = "test-build-007";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [
          { route: "/", status: "rendered", revalidate: 30, router: "app" },
          { route: "/about", status: "rendered", revalidate: 60, router: "app" },
          {
            route: "/blog/:slug",
            status: "rendered",
            revalidate: 120,
            path: "/blog/post-1",
            router: "app",
          },
        ],
      },
      {
        "index.html": "<html>Home</html>",
        "index.rsc": "RSC home",
        "about.html": "<html>About</html>",
        "about.rsc": "RSC about",
        "blog/post-1.html": "<html>Blog Post 1</html>",
        "blog/post-1.rsc": "RSC blog 1",
      },
    );

    const count = await seedMemoryCacheFromPrerender(serverDir);
    expect(count).toBe(3);

    for (const pathname of ["/", "/about", "/blog/post-1"]) {
      const htmlKey = isrCacheKey("app", pathname, buildId) + ":html";
      expect(
        await getCacheHandler().get(htmlKey),
        `expected cache entry for ${pathname}`,
      ).not.toBeNull();
    }
  });

  // ── Graceful degradation ──────────────────────────────────────────────────

  it("is a no-op when vinext-prerender.json does not exist", async () => {
    const count = await seedMemoryCacheFromPrerender(serverDir);
    expect(count).toBe(0);
  });

  it("skips routes whose HTML files are missing from disk", async () => {
    const buildId = "test-build-008";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [{ route: "/missing", status: "rendered", revalidate: 60, router: "app" }],
      },
      {},
    );

    const count = await seedMemoryCacheFromPrerender(serverDir);
    expect(count).toBe(0);
  });

  it("returns 0 and warns on corrupt manifest JSON", async () => {
    writeRawManifest(serverDir, "{ this is not valid json !!!");

    const count = await seedMemoryCacheFromPrerender(serverDir);
    expect(count).toBe(0);
  });

  it("returns 0 when manifest has no buildId", async () => {
    writeRawManifest(serverDir, JSON.stringify({ routes: [] }));

    const count = await seedMemoryCacheFromPrerender(serverDir);
    expect(count).toBe(0);
  });

  // ── trailingSlash ──────────────────────────────────────────────────────────

  it("reads files from trailingSlash directory layout", async () => {
    const buildId = "test-build-010";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        trailingSlash: true,
        routes: [{ route: "/about", status: "rendered", revalidate: 60, router: "app" }],
      },
      {
        "about/index.html": "<html><body>About (trailing slash)</body></html>",
        "about.rsc": "RSC about",
      },
    );

    await seedMemoryCacheFromPrerender(serverDir);

    const htmlKey = isrCacheKey("app", "/about", buildId) + ":html";
    const htmlEntry = await getCacheHandler().get(htmlKey);
    expect(htmlEntry).not.toBeNull();
    if (htmlEntry?.value?.kind === "APP_PAGE") {
      expect(htmlEntry.value.html).toBe("<html><body>About (trailing slash)</body></html>");
    }
  });

  // ── RSC file optional ─────────────────────────────────────────────────────

  it("seeds HTML even when RSC file is missing", async () => {
    const buildId = "test-build-009";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [{ route: "/html-only", status: "rendered", revalidate: 60, router: "app" }],
      },
      {
        "html-only.html": "<html><body>HTML only</body></html>",
      },
    );

    const count = await seedMemoryCacheFromPrerender(serverDir);
    expect(count).toBe(1);

    const htmlKey = isrCacheKey("app", "/html-only", buildId) + ":html";
    expect(await getCacheHandler().get(htmlKey)).not.toBeNull();

    const rscKey = isrCacheKey("app", "/html-only", buildId) + ":rsc";
    expect(await getCacheHandler().get(rscKey)).toBeNull();
  });

  // ── Long pathnames (FNV hash path) ────────────────────────────────────────

  it("seeds routes with very long pathnames that hit the hash path", async () => {
    const buildId = "hash-test";
    const longSlug = "a".repeat(200);
    const longPath = `/blog/${longSlug}`;
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [
          {
            route: "/blog/:slug",
            status: "rendered",
            revalidate: 60,
            path: longPath,
            router: "app",
          },
        ],
      },
      {
        [`blog/${longSlug}.html`]: "<html>Long path</html>",
        [`blog/${longSlug}.rsc`]: "RSC long",
      },
    );

    const count = await seedMemoryCacheFromPrerender(serverDir);
    expect(count).toBe(1);

    // Verify the hashed key matches what isrCacheKey produces
    const htmlKey = isrCacheKey("app", longPath, buildId) + ":html";
    expect(htmlKey).toContain("__hash:");
    expect(await getCacheHandler().get(htmlKey)).not.toBeNull();
  });
});
