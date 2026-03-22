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
} from "../packages/vinext/src/shims/cache.js";
import { isrCacheKey } from "../packages/vinext/src/server/isr-cache.js";
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
  // Write manifest to serverDir (dist/server/)
  fs.writeFileSync(
    path.join(serverDir, "vinext-prerender.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );

  // Write pre-rendered files to prerendered-routes/
  const prerenderDir = path.join(serverDir, "prerendered-routes");
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(prerenderDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("seedMemoryCacheFromPrerender", () => {
  let serverDir: string;
  let handler: MemoryCacheHandler;

  beforeEach(() => {
    serverDir = createTempServerDir();
    handler = new MemoryCacheHandler();
    setCacheHandler(handler);
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

    // HTML entry should be cached
    const htmlKey = isrCacheKey("app", "/about", buildId) + ":html";
    const htmlEntry = await getCacheHandler().get(htmlKey);
    expect(htmlEntry).not.toBeNull();
    const htmlValue = htmlEntry?.value;
    expect(htmlValue).not.toBeNull();
    expect(htmlValue?.kind).toBe("APP_PAGE");
    if (htmlValue?.kind === "APP_PAGE") {
      expect(htmlValue.html).toBe("<html><body>About page</body></html>");
    }

    // RSC entry should be cached
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
    expect(htmlEntry!.value!.kind).toBe("APP_PAGE");
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

    // Should use the concrete path, not the pattern
    const htmlKey = isrCacheKey("app", "/blog/hello-world", buildId) + ":html";
    const htmlEntry = await getCacheHandler().get(htmlKey);
    expect(htmlEntry).not.toBeNull();
    expect(htmlEntry!.value!.kind).toBe("APP_PAGE");
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
    // No cacheState means fresh — should never expire
    expect(htmlEntry!.cacheState).toBeUndefined();
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

    // Skipped route should not be in cache
    const skippedKey = isrCacheKey("app", "/ssr-page", buildId) + ":html";
    const skippedEntry = await getCacheHandler().get(skippedKey);
    expect(skippedEntry).toBeNull();

    // Rendered route should be cached
    const aboutKey = isrCacheKey("app", "/about", buildId) + ":html";
    const aboutEntry = await getCacheHandler().get(aboutKey);
    expect(aboutEntry).not.toBeNull();
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

    await seedMemoryCacheFromPrerender(serverDir);

    const brokenKey = isrCacheKey("app", "/broken", buildId) + ":html";
    const entry = await getCacheHandler().get(brokenKey);
    expect(entry).toBeNull();
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

    await seedMemoryCacheFromPrerender(serverDir);

    for (const pathname of ["/", "/about", "/blog/post-1"]) {
      const htmlKey = isrCacheKey("app", pathname, buildId) + ":html";
      const entry = await getCacheHandler().get(htmlKey);
      expect(entry, `expected cache entry for ${pathname}`).not.toBeNull();
    }
  });

  // ── Graceful degradation ──────────────────────────────────────────────────

  it("is a no-op when vinext-prerender.json does not exist", async () => {
    // serverDir has no manifest file
    await seedMemoryCacheFromPrerender(serverDir);
    // Should not throw — just silently skip
  });

  it("skips routes whose HTML files are missing from disk", async () => {
    const buildId = "test-build-008";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [{ route: "/missing", status: "rendered", revalidate: 60, router: "app" }],
      },
      {
        // Deliberately not writing any files for /missing
      },
    );

    await seedMemoryCacheFromPrerender(serverDir);

    const htmlKey = isrCacheKey("app", "/missing", buildId) + ":html";
    const entry = await getCacheHandler().get(htmlKey);
    expect(entry).toBeNull();
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
        // trailingSlash: true writes to about/index.html, not about.html
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
        // No .rsc file
      },
    );

    await seedMemoryCacheFromPrerender(serverDir);

    // HTML should be cached
    const htmlKey = isrCacheKey("app", "/html-only", buildId) + ":html";
    const htmlEntry = await getCacheHandler().get(htmlKey);
    expect(htmlEntry).not.toBeNull();

    // RSC should not be cached (no file to read)
    const rscKey = isrCacheKey("app", "/html-only", buildId) + ":rsc";
    const rscEntry = await getCacheHandler().get(rscKey);
    expect(rscEntry).toBeNull();
  });
});
