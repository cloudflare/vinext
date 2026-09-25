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
  revalidatePath,
  type CacheHandler,
  type CacheHandlerValue,
  type IncrementalCacheValue,
} from "../packages/vinext/src/shims/cache.js";
import { appIsrCacheKey, isrGet } from "../packages/vinext/src/server/isr-cache.js";
import { getRenderedConcreteUrlPathsForRoute } from "../packages/vinext/src/server/pregenerated-concrete-paths.js";
import { seedMemoryCacheFromPrerender } from "../packages/vinext/src/server/seed-cache.js";
import { readAppPageCacheResponse } from "../packages/vinext/src/server/app-page-cache.js";
import {
  buildSearchParamsReadRenderObservation,
  queryInvariantPrerenderObservations,
} from "./render-observation-test-helpers.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTempServerDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vinext-seed-cache-"));
}

/**
 * Write a vinext-prerender.json manifest and corresponding pre-rendered files
 * to a temporary directory structure matching the production build layout.
 * Rendered App routes carry the observations of a render that left the query
 * unread, as a current build writes them, unless the route sets its own.
 */
function setupPrerenderFixture(
  serverDir: string,
  manifest: { buildId: string; trailingSlash?: boolean; routes: unknown[] },
  files: Record<string, string>,
): void {
  const routes = manifest.routes.map((route) =>
    typeof route === "object" &&
    route !== null &&
    "router" in route &&
    route.router === "app" &&
    !("renderObservations" in route)
      ? { ...route, renderObservations: queryInvariantPrerenderObservations() }
      : route,
  );
  fs.writeFileSync(
    path.join(serverDir, "vinext-prerender.json"),
    JSON.stringify({ ...manifest, routes }, null, 2),
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

    const htmlKey = appIsrCacheKey("/about", "html", buildId);
    const htmlEntry = await getCacheHandler().get(htmlKey);
    expect(htmlEntry).not.toBeNull();
    const htmlValue = htmlEntry?.value;
    expect(htmlValue).not.toBeNull();
    expect(htmlValue?.kind).toBe("APP_PAGE");
    if (htmlValue?.kind === "APP_PAGE") {
      expect(htmlValue.html).toBe("<html><body>About page</body></html>");
    }

    const rscKey = appIsrCacheKey("/about", "rsc", buildId);
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

  it("stores the prerender's render observations with the seeded entries", async () => {
    const buildId = "seed-observation-test";
    const renderObservations = queryInvariantPrerenderObservations();
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [
          {
            route: "/about",
            status: "rendered",
            revalidate: 60,
            router: "app",
            renderObservations,
          },
        ],
      },
      {
        "about.html": "<html><body>About page</body></html>",
        "about.rsc": "RSC payload for about",
      },
    );

    await expect(seedMemoryCacheFromPrerender(serverDir)).resolves.toBe(1);

    const htmlValue = (await getCacheHandler().get(appIsrCacheKey("/about", "html", buildId)))
      ?.value;
    const rscValue = (await getCacheHandler().get(appIsrCacheKey("/about", "rsc", buildId)))?.value;
    expect(htmlValue?.kind === "APP_PAGE" && htmlValue.renderObservation).toEqual(
      renderObservations.html,
    );
    expect(rscValue?.kind === "APP_PAGE" && rscValue.renderObservation).toEqual(
      renderObservations.rsc,
    );
  });

  it("does not seed a page whose render read searchParams", async () => {
    const buildId = "seed-search-params-read-test";
    const writes: string[] = [];
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [
          {
            route: "/about",
            status: "rendered",
            revalidate: 60,
            router: "app",
            renderObservations: {
              html: buildSearchParamsReadRenderObservation(),
              rsc: buildSearchParamsReadRenderObservation(),
            },
          },
        ],
      },
      {
        "about.html": "<html><body>About page</body></html>",
        "about.rsc": "RSC payload for about",
      },
    );

    await expect(
      seedMemoryCacheFromPrerender(serverDir, {
        async writeAppPageEntry(key): Promise<void> {
          writes.push(key);
        },
      }),
    ).resolves.toBe(0);
    expect(writes).toEqual([]);
  });

  it("does not seed a page from a manifest without render observations", async () => {
    // Manifests from older builds carry no observation, so nothing proves the
    // render left the query unread.
    const buildId = "seed-no-observation-test";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [
          {
            route: "/about",
            status: "rendered",
            revalidate: 60,
            router: "app",
            renderObservations: undefined,
          },
        ],
      },
      {
        "about.html": "<html><body>About page</body></html>",
        "about.rsc": "RSC payload for about",
      },
    );

    await expect(seedMemoryCacheFromPrerender(serverDir)).resolves.toBe(0);
    expect(await getCacheHandler().get(appIsrCacheKey("/about", "html", buildId))).toBeNull();
    expect(await getCacheHandler().get(appIsrCacheKey("/about", "rsc", buildId))).toBeNull();
  });

  it("serves query-bearing requests from a seeded entry", async () => {
    const buildId = "seed-query-hit-test";
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

    for (const isRscRequest of [false, true]) {
      const response = await readAppPageCacheResponse({
        cleanPathname: "/about",
        clearRequestContext() {},
        hasRequestSearchParams: true,
        isRscRequest,
        isrGet,
        isrHtmlKey: (pathname) => appIsrCacheKey(pathname, "html", buildId),
        isrRscKey: (pathname) => appIsrCacheKey(pathname, "rsc", buildId),
        async isrSet() {
          throw new Error("a seeded HIT must not overwrite the entry");
        },
        revalidateSeconds: 60,
        async renderFreshPageForCache() {
          throw new Error("a seeded HIT must not render");
        },
        scheduleBackgroundRegeneration() {
          throw new Error("a fresh seeded entry must not regenerate");
        },
      });

      expect(response?.headers.get("x-vinext-cache")).toBe("HIT");
      await expect(response?.text()).resolves.toBe(
        isRscRequest ? "RSC payload for about" : "<html><body>About page</body></html>",
      );
    }
  });

  it("seeds prerendered metadata responses as App Route entries", async () => {
    const buildId = "metadata-build";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [
          {
            route: "/robots.txt",
            status: "rendered",
            revalidate: 900,
            expire: 3600,
            stale: 300,
            router: "metadata",
            headers: {
              "content-type": "text/plain",
              "x-vinext-metadata-route-cache": "1",
            },
            responseStatus: 200,
          },
        ],
      },
      { "robots.txt.route": "User-Agent: *\nAllow: /buildtime\n" },
    );

    expect(await seedMemoryCacheFromPrerender(serverDir)).toBe(1);
    const entry = await getCacheHandler().get(appIsrCacheKey("/robots.txt", "route", buildId));
    expect(entry?.value?.kind).toBe("APP_ROUTE");
    expect(entry?.cacheControl).toEqual({ revalidate: 900, expire: 3600, stale: 300 });
    if (entry?.value?.kind === "APP_ROUTE") {
      expect(new TextDecoder().decode(entry.value.body)).toContain("/buildtime");
      expect(entry.value.headers["content-type"]).toBe("text/plain");
    }
  });

  it("does not seed invalid metadata client stale times", async () => {
    const policies: Array<{ cacheControl?: { stale?: number } }> = [];
    setupPrerenderFixture(
      serverDir,
      {
        buildId: "metadata-invalid-stale-build",
        routes: [
          {
            route: "/robots.txt",
            status: "rendered",
            revalidate: 900,
            stale: -1,
            router: "metadata",
            responseStatus: 200,
          },
        ],
      },
      { "robots.txt.route": "User-Agent: *\nAllow: /\n" },
    );

    await seedMemoryCacheFromPrerender(serverDir, {
      async writeAppRouteEntry(_key, _data, policy) {
        policies.push(policy);
      },
    });

    expect(policies).toHaveLength(1);
    expect(policies[0].cacheControl).toEqual({ revalidate: 900 });
  });

  it("does not seed metadata responses with zero revalidate", async () => {
    let writes = 0;
    setupPrerenderFixture(
      serverDir,
      {
        buildId: "metadata-zero-revalidate-build",
        routes: [
          {
            route: "/robots.txt",
            status: "rendered",
            revalidate: 0,
            router: "metadata",
            responseStatus: 200,
          },
        ],
      },
      { "robots.txt.route": "User-Agent: *\nAllow: /\n" },
    );

    const seeded = await seedMemoryCacheFromPrerender(serverDir, {
      async writeAppRouteEntry() {
        writes++;
      },
    });

    expect(seeded).toBe(0);
    expect(writes).toBe(0);
  });

  it("normalizes metadata keys and preserves route and user invalidation tags", async () => {
    const writes: Array<{ key: string; policy: { tags?: string[] } }> = [];
    setupPrerenderFixture(
      serverDir,
      {
        buildId: "metadata-encoded-build",
        routes: [
          {
            route: "/products/sitemap.xml",
            path: "/products/sitemap/hello%20world.xml",
            routeSegments: ["products"],
            status: "rendered",
            revalidate: 900,
            router: "metadata",
            headers: {
              "content-type": "application/xml",
              "x-vinext-metadata-route-cache": "1",
            },
            tags: ["metadata-user-tag"],
          },
        ],
      },
      {
        "products/sitemap/hello%20world.xml.route": '<?xml version="1.0"?><urlset></urlset>',
      },
    );

    await seedMemoryCacheFromPrerender(serverDir, {
      buildAppRouteKey(pathname) {
        return `metadata:${pathname}`;
      },
      async writeAppRouteEntry(key, _data, policy) {
        writes.push({ key, policy });
      },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBe("metadata:/products/sitemap/hello world.xml");
    expect(writes[0].policy.tags).toEqual(
      expect.arrayContaining([
        "/products/sitemap/hello world.xml",
        "_N_T_/products/sitemap/hello world.xml",
        "_N_T_/layout",
        "_N_T_/products/route",
        "metadata-user-tag",
      ]),
    );
  });

  it("replays prerendered App Router Link headers", async () => {
    const buildId = "test-build-link-header";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [
          {
            route: "/preloads",
            status: "rendered",
            revalidate: false,
            router: "app",
            headers: { link: "</font.woff2>; rel=preload; as=font" },
          },
        ],
      },
      {
        "preloads.html": "<html><body>Preloads</body></html>",
        "preloads.rsc": "RSC payload",
      },
    );

    await seedMemoryCacheFromPrerender(serverDir);

    const htmlKey = appIsrCacheKey("/preloads", "html", buildId);
    const htmlEntry = await getCacheHandler().get(htmlKey);
    expect(htmlEntry?.value).toMatchObject({
      kind: "APP_PAGE",
      headers: { link: "</font.woff2>; rel=preload; as=font" },
    });
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

    const htmlKey = appIsrCacheKey("/", "html", buildId);
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

    const htmlKey = appIsrCacheKey("/blog/hello-world", "html", buildId);
    const htmlEntry = await getCacheHandler().get(htmlKey);
    expect(htmlEntry).not.toBeNull();
    expect(htmlEntry?.value?.kind).toBe("APP_PAGE");
  });

  it("seeds encoded dynamic App Router paths under the runtime-normalized cache key", async () => {
    const buildId = "encoded-path-test";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [
          {
            route: "/:id",
            status: "rendered",
            revalidate: false,
            path: "/sticks%20%26%20stones",
            router: "app",
          },
        ],
      },
      {
        "sticks%20%26%20stones.html":
          "<html><body>params.id is sticks%20%26%20stones</body></html>",
        "sticks%20%26%20stones.rsc": "RSC encoded payload",
      },
    );

    await seedMemoryCacheFromPrerender(serverDir);

    const htmlKey = appIsrCacheKey("/sticks & stones", "html", buildId);
    const htmlEntry = await getCacheHandler().get(htmlKey);
    expect(htmlEntry).not.toBeNull();
    if (htmlEntry?.value?.kind === "APP_PAGE") {
      expect(htmlEntry.value.html).toBe(
        "<html><body>params.id is sticks%20%26%20stones</body></html>",
      );
    }

    const staleEncodedKey = appIsrCacheKey("/sticks%20%26%20stones", "html", buildId);
    expect(await getCacheHandler().get(staleEncodedKey)).toBeNull();
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

    // Path-derived implicit tags are attached so revalidatePath('/isr') can
    // invalidate seeded entries — see #1486.
    const expectedTags = [
      "/isr",
      "_N_T_/isr",
      "_N_T_/layout",
      "_N_T_/isr/layout",
      "_N_T_/isr/page",
    ];
    expect(contexts).toEqual([
      { cacheControl: { revalidate: 60, expire: 300 }, revalidate: 60, tags: expectedTags },
      { cacheControl: { revalidate: 60, expire: 300 }, revalidate: 60, tags: expectedTags },
    ]);
  });

  it("can write through an injected app page cache writer", async () => {
    const writes: {
      key: string;
      metadata: { expireSeconds?: number; revalidateSeconds?: number; tags?: string[] };
      valueKind: string;
    }[] = [];

    setupPrerenderFixture(
      serverDir,
      {
        buildId: "seed-injected-writer-test",
        routes: [{ route: "/isr", status: "rendered", revalidate: 60, expire: 300, router: "app" }],
      },
      {
        "isr.html": "<html>ISR</html>",
        "isr.rsc": "RSC isr",
      },
    );

    await seedMemoryCacheFromPrerender(serverDir, {
      async writeAppPageEntry(key, data, metadata): Promise<void> {
        writes.push({ key, metadata, valueKind: data.kind });
      },
    });

    // Path-derived implicit tags so revalidatePath('/isr') can invalidate
    // these entries — see #1486.
    const expectedTags = [
      "/isr",
      "_N_T_/isr",
      "_N_T_/layout",
      "_N_T_/isr/layout",
      "_N_T_/isr/page",
    ];
    expect(writes).toEqual([
      {
        key: appIsrCacheKey("/isr", "html", "seed-injected-writer-test"),
        metadata: { expireSeconds: 300, revalidateSeconds: 60, tags: expectedTags },
        valueKind: "APP_PAGE",
      },
      {
        key: appIsrCacheKey("/isr", "rsc", "seed-injected-writer-test"),
        metadata: { expireSeconds: 300, revalidateSeconds: 60, tags: expectedTags },
        valueKind: "APP_PAGE",
      },
    ]);
  });

  it("seeds the prerender's client stale time onto both artifacts", async () => {
    // A prerendered page's `cacheLife` resolves before the artifact is written,
    // so the seeded entry can carry the claim. Without it, a page served from
    // the seed would be reusable for the configured staleTimes default while an
    // identical runtime-rendered entry honored `cacheLife`.
    const writes: { key: string; staleSeconds?: number }[] = [];

    setupPrerenderFixture(
      serverDir,
      {
        buildId: "seed-stale-test",
        routes: [
          {
            route: "/isr",
            status: "rendered",
            revalidate: 60,
            expire: 300,
            stale: 30,
            router: "app",
          },
        ],
      },
      {
        "isr.html": "<html>ISR</html>",
        "isr.rsc": "RSC isr",
      },
    );

    await seedMemoryCacheFromPrerender(serverDir, {
      async writeAppPageEntry(key, _data, metadata): Promise<void> {
        writes.push({ key, staleSeconds: metadata.staleSeconds });
      },
    });

    expect(writes).toEqual([
      { key: appIsrCacheKey("/isr", "html", "seed-stale-test"), staleSeconds: 30 },
      { key: appIsrCacheKey("/isr", "rsc", "seed-stale-test"), staleSeconds: 30 },
    ]);
  });

  it("can use injected runtime app page cache key builders", async () => {
    const keys: string[] = [];

    setupPrerenderFixture(
      serverDir,
      {
        buildId: "manifest-build-id",
        routes: [{ route: "/isr", status: "rendered", revalidate: 60, router: "app" }],
      },
      {
        "isr.html": "<html>ISR</html>",
        "isr.rsc": "RSC isr",
      },
    );

    await seedMemoryCacheFromPrerender(serverDir, {
      buildAppPageHtmlKey(pathname) {
        return `runtime-build:${pathname}:html`;
      },
      buildAppPageRscKey(pathname) {
        return `runtime-build:${pathname}:rsc`;
      },
      async writeAppPageEntry(key): Promise<void> {
        keys.push(key);
      },
    });

    expect(keys).toEqual(["runtime-build:/isr:html", "runtime-build:/isr:rsc"]);
  });

  // ── revalidatePath invalidation of seeded entries (#1486) ─────────────────

  it("revalidatePath invalidates seeded HTML and RSC entries", async () => {
    const buildId = "revalidate-seeded-test";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [{ route: "/posts", status: "rendered", revalidate: 60, router: "app" }],
      },
      {
        "posts.html": "<html>Posts (seeded)</html>",
        "posts.rsc": "RSC posts seeded",
      },
    );

    await seedMemoryCacheFromPrerender(serverDir);

    const htmlKey = appIsrCacheKey("/posts", "html", buildId);
    const rscKey = appIsrCacheKey("/posts", "rsc", buildId);

    // Sanity: both seeded entries are present before revalidation.
    expect(await getCacheHandler().get(htmlKey)).not.toBeNull();
    expect(await getCacheHandler().get(rscKey)).not.toBeNull();

    // revalidatePath should invalidate both seeded artifacts.
    await Promise.resolve(revalidatePath("/posts"));

    expect(await getCacheHandler().get(htmlKey)).toBeNull();
    expect(await getCacheHandler().get(rscKey)).toBeNull();
  });

  it("user cache tags from the prerender manifest invalidate seeded entries", async () => {
    const buildId = "revalidate-seeded-user-tag-test";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [
          {
            route: "/update-tag-test",
            status: "rendered",
            revalidate: false,
            router: "app",
            tags: ["test-update-tag"],
          },
        ],
      },
      {
        "update-tag-test.html": "<html>Seeded data</html>",
        "update-tag-test.rsc": "RSC seeded data",
      },
    );

    await seedMemoryCacheFromPrerender(serverDir);

    const htmlKey = appIsrCacheKey("/update-tag-test", "html", buildId);
    const rscKey = appIsrCacheKey("/update-tag-test", "rsc", buildId);
    expect(await getCacheHandler().get(htmlKey)).not.toBeNull();
    expect(await getCacheHandler().get(rscKey)).not.toBeNull();

    await getCacheHandler().revalidateTag("test-update-tag");

    expect(await getCacheHandler().get(htmlKey)).toBeNull();
    expect(await getCacheHandler().get(rscKey)).toBeNull();
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

    const htmlKey = appIsrCacheKey("/static", "html", buildId);
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

    const skippedKey = appIsrCacheKey("/ssr-page", "html", buildId);
    expect(await getCacheHandler().get(skippedKey)).toBeNull();

    const aboutKey = appIsrCacheKey("/about", "html", buildId);
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
      const htmlKey = appIsrCacheKey(pathname, "html", buildId);
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

    const htmlKey = appIsrCacheKey("/about", "html", buildId);
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

    const htmlKey = appIsrCacheKey("/html-only", "html", buildId);
    expect(await getCacheHandler().get(htmlKey)).not.toBeNull();

    const rscKey = appIsrCacheKey("/html-only", "rsc", buildId);
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

    // Verify the hashed key matches what appIsrCacheKey produces.
    const htmlKey = appIsrCacheKey(longPath, "html", buildId);
    expect(htmlKey).toContain("__hash:");
    expect(await getCacheHandler().get(htmlKey)).not.toBeNull();
  });

  it("clears pregenerated concrete paths from a previous build and repopulates from the current manifest", async () => {
    setupPrerenderFixture(
      serverDir,
      {
        buildId: "build-a",
        routes: [
          {
            route: "/en/blog/:slug",
            status: "rendered",
            router: "app",
            path: "/en/blog/known-post",
            revalidate: 60,
          },
        ],
      },
      {
        "en/blog/known-post.html": "<html>build A</html>",
        "en/blog/known-post.rsc": "build-a-flight",
      },
    );
    await seedMemoryCacheFromPrerender(serverDir);

    const buildAPaths = getRenderedConcreteUrlPathsForRoute("/en/blog/:slug");
    expect(buildAPaths).toBeDefined();
    expect(buildAPaths!.has("/en/blog/known-post")).toBe(true);

    setupPrerenderFixture(
      serverDir,
      {
        buildId: "build-b",
        routes: [
          {
            route: "/en/blog/:slug",
            status: "rendered",
            router: "app",
            path: "/en/blog/new-post",
            revalidate: 60,
          },
        ],
      },
      {
        "en/blog/new-post.html": "<html>build B</html>",
        "en/blog/new-post.rsc": "build-b-flight",
      },
    );
    await seedMemoryCacheFromPrerender(serverDir);

    const buildBPaths = getRenderedConcreteUrlPathsForRoute("/en/blog/:slug");
    expect(buildBPaths).toBeDefined();
    expect(buildBPaths!.has("/en/blog/known-post")).toBe(false);
    expect(buildBPaths!.has("/en/blog/new-post")).toBe(true);
    expect(buildBPaths!.size).toBe(1);
  });

  it("excludes fallback-shell placeholder paths from concrete path registry", async () => {
    const buildId = "fallback-shell-test";
    setupPrerenderFixture(
      serverDir,
      {
        buildId,
        routes: [
          {
            route: "/en/blog/:slug",
            status: "rendered",
            router: "app",
            path: "/en/blog/known-post",
            revalidate: 60,
          },
          {
            route: "/en/blog/:slug",
            status: "rendered",
            router: "app",
            path: "/en/blog/[slug]",
            revalidate: 60,
            fallback: true,
          },
        ],
      },
      {
        "en/blog/known-post.html": "<html>known post</html>",
        "en/blog/known-post.rsc": "flight-data",
      },
    );
    await seedMemoryCacheFromPrerender(serverDir);

    const paths = getRenderedConcreteUrlPathsForRoute("/en/blog/:slug");
    expect(paths).toBeDefined();
    expect(paths!.has("/en/blog/known-post")).toBe(true);
    expect(paths!.has("/en/blog/[slug]")).toBe(false);
    expect(paths!.size).toBe(1);
  });

  it("retains empty static-param route markers without seeding an artifact", async () => {
    setupPrerenderFixture(
      serverDir,
      {
        buildId: "empty-static-params",
        routes: [
          {
            route: "/blog/:slug",
            status: "skipped",
            reason: "empty-static-params",
          },
        ],
      },
      {},
    );

    await expect(seedMemoryCacheFromPrerender(serverDir)).resolves.toBe(0);
    expect(getRenderedConcreteUrlPathsForRoute("/blog/:slug")).toEqual(new Set());
  });

  it("clears pregenerated concrete paths when manifest is absent from a subsequent build", async () => {
    setupPrerenderFixture(
      serverDir,
      {
        buildId: "build-a",
        routes: [
          {
            route: "/en/blog/:slug",
            status: "rendered",
            router: "app",
            path: "/en/blog/known-post",
            revalidate: 60,
          },
        ],
      },
      { "en/blog/known-post.html": "<html>A</html>" },
    );
    await seedMemoryCacheFromPrerender(serverDir);
    expect(getRenderedConcreteUrlPathsForRoute("/en/blog/:slug")).toBeDefined();

    fs.rmSync(path.join(serverDir, "vinext-prerender.json"));
    await seedMemoryCacheFromPrerender(serverDir);

    expect(getRenderedConcreteUrlPathsForRoute("/en/blog/:slug")).toBeUndefined();
  });
});
