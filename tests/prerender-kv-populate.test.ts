import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { buildPrerenderKVPairs } from "../packages/cloudflare/src/prerender-kv-populate.js";
import { appIsrCacheKey } from "../packages/vinext/src/server/isr-cache.js";

let serverDir: string;

function writePrerenderFixture(
  manifest: Record<string, unknown>,
  files: Record<string, string | Buffer>,
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
    fs.writeFileSync(fullPath, content);
  }
}

describe("buildPrerenderKVPairs", () => {
  beforeEach(() => {
    serverDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prerender-kv-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(serverDir, { recursive: true, force: true });
  });

  it("builds KV entries for prerendered App Router HTML and RSC artifacts", () => {
    writePrerenderFixture(
      {
        buildId: "build-1",
        routes: [
          {
            route: "/about",
            status: "rendered",
            revalidate: 60,
            expire: 300,
            router: "app",
            headers: { link: "</font.woff2>; rel=preload; as=font" },
          },
        ],
      },
      {
        "about.html": "<html>About</html>",
        "about.rsc": "flight",
      },
    );

    const { routeCount, pairs } = buildPrerenderKVPairs(serverDir, {
      appPrefix: "site-a",
      now: 1_000,
      ttlSeconds: 123,
    });

    expect(routeCount).toBe(1);
    expect(pairs.map((pair) => pair.key)).toEqual([
      "site-a:cache:app:build-1:/about:html",
      "site-a:cache:app:build-1:/about:rsc",
    ]);
    expect(pairs.map((pair) => pair.expiration_ttl)).toEqual([123, 123]);

    const htmlEntry = JSON.parse(pairs[0].value);
    expect(htmlEntry).toMatchObject({
      value: {
        kind: "APP_PAGE",
        html: "<html>About</html>",
        headers: { link: "</font.woff2>; rel=preload; as=font" },
      },
      lastModified: 1_000,
      revalidateAt: 61_000,
      expireAt: 301_000,
      cacheControl: { revalidate: 60, expire: 300 },
    });
    expect(pairs[0].metadata).toEqual({ tags: htmlEntry.tags });
    expect(htmlEntry.tags).toContain("/about");
    expect(htmlEntry.tags).toContain("_N_T_/about/page");

    const rscEntry = JSON.parse(pairs[1].value);
    expect(rscEntry.value).toMatchObject({
      kind: "APP_PAGE",
      html: "",
      rscData: Buffer.from("flight").toString("base64"),
    });
  });

  it("builds a KV entry for prerendered Pages Router HTML", () => {
    writePrerenderFixture(
      {
        buildId: "pages-build",
        routes: [
          {
            route: "/about",
            status: "rendered",
            revalidate: 60,
            expire: 300,
            router: "pages",
            headers: { "x-prerendered": "true" },
          },
        ],
      },
      { "about.html": "<html>Pages about</html>" },
    );

    const { routeCount, pairs } = buildPrerenderKVPairs(serverDir, {
      appPrefix: "site-a",
      now: 1_000,
      ttlSeconds: 123,
    });

    expect(routeCount).toBe(1);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      key: "site-a:cache:pages:pages-build:/about",
      expiration_ttl: 123,
    });
    expect(JSON.parse(pairs[0].value)).toEqual({
      value: {
        kind: "PAGES",
        html: "<html>Pages about</html>",
        pageData: {},
        headers: { "x-prerendered": "true" },
      },
      tags: [],
      lastModified: 1_000,
      revalidateAt: 61_000,
      expireAt: 301_000,
      cacheControl: { revalidate: 60, expire: 300 },
    });
  });

  it("skips Pages fallback shells and zero-revalidate entries", () => {
    writePrerenderFixture(
      {
        buildId: "pages-filtered",
        routes: [
          {
            route: "/posts/[slug]",
            status: "rendered",
            revalidate: false,
            router: "pages",
            fallback: true,
          },
          { route: "/zero", status: "rendered", revalidate: 0, router: "pages" },
          { route: "/static", status: "rendered", revalidate: false, router: "pages" },
        ],
      },
      {
        "posts/[slug].html": "<html>Fallback</html>",
        "zero.html": "<html>Zero</html>",
        "static.html": "<html>Static</html>",
      },
    );

    const { routeCount, pairs } = buildPrerenderKVPairs(serverDir, { now: 2_000 });

    expect(routeCount).toBe(1);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].key).toBe("cache:pages:pages-filtered:/static");
    expect(pairs[0]).not.toHaveProperty("expiration_ttl");
    expect(JSON.parse(pairs[0].value)).toMatchObject({
      revalidateAt: 31_536_002_000,
      cacheControl: { revalidate: 31_536_000 },
    });
  });

  it("preserves the status of Pages error documents", () => {
    writePrerenderFixture(
      {
        buildId: "pages-errors",
        routes: [
          { route: "/404", status: "rendered", revalidate: false, router: "pages" },
          { route: "/500", status: "rendered", revalidate: false, router: "pages" },
        ],
      },
      {
        "404.html": "<html>Not found</html>",
        "500.html": "<html>Server error</html>",
      },
    );

    const { pairs } = buildPrerenderKVPairs(serverDir, { now: 2_000 });

    expect(pairs.map((pair) => JSON.parse(pair.value).value.status)).toEqual([404, 500]);
  });

  it("omits KV expiration for static prerendered routes and skips zero revalidate", () => {
    writePrerenderFixture(
      {
        buildId: "build-static",
        routes: [
          { route: "/static", status: "rendered", revalidate: false, router: "app" },
          { route: "/zero", status: "rendered", revalidate: 0, router: "app" },
        ],
      },
      {
        "static.html": "<html>Static</html>",
        "zero.html": "<html>Zero</html>",
      },
    );

    const { routeCount, pairs } = buildPrerenderKVPairs(serverDir, { now: 2_000 });
    expect(routeCount).toBe(1);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).not.toHaveProperty("expiration_ttl");
    expect(pairs[0].key).toBe("cache:app:build-static:/static:html");

    const entry = JSON.parse(pairs[0].value);
    expect(entry.revalidateAt).toBeNull();
    expect(entry.expireAt).toBeNull();
    expect(entry.cacheControl).toBeUndefined();
  });

  it("uses the shared pregenerated pathname normalizer for KV keys and tags", () => {
    writePrerenderFixture(
      {
        buildId: "build-normalized",
        routes: [
          {
            route: "/blog/[slug]",
            path: "/blog//hello%20world",
            status: "rendered",
            revalidate: 60,
            router: "app",
          },
        ],
      },
      {
        "blog/hello%20world.html": "<html>Ignored clean path</html>",
        "blog//hello%20world.html": "<html>Normalized path</html>",
      },
    );

    const { pairs } = buildPrerenderKVPairs(serverDir, { now: 3_000 });

    expect(pairs.map((pair) => pair.key)).toEqual([
      "cache:app:build-normalized:/blog/hello world:html",
    ]);
    const htmlEntry = JSON.parse(pairs[0].value);
    expect(htmlEntry.tags).toContain("/blog/hello world");
    expect(htmlEntry.tags).toContain("_N_T_/blog/hello world/page");
    expect(htmlEntry.value.html).toBe("<html>Normalized path</html>");
  });

  it("includes artifact suffixes in the cache-key hash threshold", () => {
    const pathname = "/" + "a".repeat(188);
    writePrerenderFixture(
      {
        buildId: "abc123",
        routes: [{ route: pathname, status: "rendered", revalidate: 60, router: "app" }],
      },
      {
        [`${"a".repeat(188)}.html`]: "<html>Long path</html>",
        [`${"a".repeat(188)}.rsc`]: "flight",
      },
    );

    const { pairs } = buildPrerenderKVPairs(serverDir);

    expect(pairs.map((pair) => pair.key)).toEqual([
      `cache:${appIsrCacheKey(pathname, "html", "abc123")}`,
      `cache:${appIsrCacheKey(pathname, "rsc", "abc123")}`,
    ]);
    expect(pairs[0].key).toMatch(/^cache:app:abc123:__hash:[0-9a-f]+:html$/);
    expect(pairs[1].key).toMatch(/^cache:app:abc123:__hash:[0-9a-f]+:rsc$/);
  });

  it("returns no pairs when the prerender manifest or artifacts are absent", () => {
    expect(buildPrerenderKVPairs(serverDir)).toEqual({ routeCount: 0, pairs: [] });

    fs.writeFileSync(
      path.join(serverDir, "vinext-prerender.json"),
      JSON.stringify({
        buildId: "build",
        routes: [{ route: "/about", status: "rendered", revalidate: 60, router: "app" }],
      }),
    );
    expect(buildPrerenderKVPairs(serverDir)).toEqual({ routeCount: 0, pairs: [] });
  });

  it("skips prerender artifact paths that escape the prerender directory", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writePrerenderFixture(
      {
        buildId: "build-escape",
        routes: [
          {
            route: "/safe",
            status: "rendered",
            revalidate: 60,
            router: "app",
          },
          {
            route: "/escape",
            path: "/../escape",
            status: "rendered",
            revalidate: 60,
            router: "app",
          },
        ],
      },
      { "safe.html": "<html>Safe</html>" },
    );
    fs.mkdirSync(path.join(serverDir, "prerendered-routes"), { recursive: true });

    const { routeCount, pairs } = buildPrerenderKVPairs(serverDir);

    expect(routeCount).toBe(1);
    expect(pairs.map((pair) => pair.key)).toEqual(["cache:app:build-escape:/safe:html"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipping prerender KV seed"));
  });
});
