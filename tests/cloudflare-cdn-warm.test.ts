import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildWarmupUrl,
  DEFAULT_CDN_WARM_TIMEOUT_MS,
  warmCdnCache,
  getWarmPathsFromPrerenderManifest,
  probeWorkerVersion,
  readPrerenderWarmPlan,
  readPrerenderWarmPaths,
  warmCdnCacheFromPrerender,
} from "../packages/cloudflare/src/cdn-warm.js";
import { VINEXT_RSC_NON_CONTEXTUAL_VARY_HEADER } from "../packages/vinext/src/server/app-rsc-cache-busting.js";

const CANONICAL_RSC_VARY = `${VINEXT_RSC_NON_CONTEXTUAL_VARY_HEADER}, Cookie, Authorization, Host, X-Forwarded-Proto`;

let tmpDir: string;

function writeFile(relativePath: string, content: string): void {
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cdn-warm-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Cloudflare CDN warmup", () => {
  it("uses a 5 second default request timeout", () => {
    expect(DEFAULT_CDN_WARM_TIMEOUT_MS).toBe(5_000);
  });

  it("retries until a staged Worker version override is observable", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 204,
          headers: { "X-Vinext-Worker-Version": "version-old" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 204,
          headers: { "X-Vinext-Worker-Version": "version-new" },
        }),
      );

    await expect(
      probeWorkerVersion({
        targetUrl: "https://app.example.com",
        pathname: "/about",
        versionId: "version-new",
        headers: { "Cloudflare-Workers-Version-Overrides": 'app="version-new"' },
        retries: 1,
        retryDelayMs: 0,
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({ verified: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toEqual(
      new URL("https://app.example.com/about?__vinext_version_probe=version-new"),
    );
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("X-Vinext-Version-Probe")).toBe("1");
    expect(new Headers(init?.headers).get("Cloudflare-Workers-Version-Overrides")).toBe(
      'app="version-new"',
    );
  });

  it("reports a missing version metadata binding without warming optimistically", async () => {
    await expect(
      probeWorkerVersion({
        targetUrl: "https://app.example.com",
        pathname: "/about",
        versionId: "version-new",
        retryDelayMs: 0,
        fetchImpl: async () =>
          new Response(null, {
            status: 503,
            headers: { "X-Vinext-Worker-Version": "unavailable" },
          }),
      }),
    ).resolves.toEqual({ verified: false, reason: "binding-unavailable" });
  });

  it("bounds and cancels a stalled version-probe response body", async () => {
    vi.useFakeTimers();
    let bodyCancelled = false;
    const stalledBody = new ReadableStream<Uint8Array>({
      cancel() {
        bodyCancelled = true;
      },
    });

    try {
      const resultPromise = probeWorkerVersion({
        targetUrl: "https://app.example.com",
        pathname: "/about",
        versionId: "version-new",
        timeoutMs: 5,
        retries: 0,
        fetchImpl: async () =>
          new Response(stalledBody, {
            status: 200,
            headers: { "X-Vinext-Worker-Version": "version-old" },
          }),
      });

      await vi.advanceTimersByTimeAsync(5);

      await expect(resultPromise).resolves.toEqual({ verified: false, reason: "not-ready" });
      expect(bodyCancelled).toBe(true);
      await vi.waitFor(() => expect(stalledBody.locked).toBe(false));
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads warmable paths from the prerender manifest", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({ buildId: "build-a", paths: ["/", "/docs/intro"] }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          { route: "/", status: "rendered", router: "app", revalidate: false, fallback: false },
          {
            route: "/docs/:slug",
            path: "/docs/intro",
            status: "rendered",
            router: "pages",
            revalidate: false,
            fallback: false,
          },
          {
            route: "/blog/:slug",
            path: "/blog/[slug]",
            status: "rendered",
            router: "app",
            revalidate: 60,
            fallback: true,
          },
          {
            route: "/500",
            status: "rendered",
            router: "pages",
            revalidate: false,
            fallback: false,
          },
          {
            route: "/_error",
            status: "rendered",
            router: "pages",
            revalidate: false,
            fallback: false,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPaths(tmpDir)).toEqual(["/", "/docs/intro"]);
  });

  it("keeps HTML Accept variants out of strict warmup for App and Pages routes", async () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        paths: ["/app-vary-accept", "/pages-vary-accept", "/safe"],
        appPaths: ["/app-vary-accept"],
        rscCacheKeyMode: "response-vary",
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          {
            route: "/app-vary-accept",
            status: "rendered",
            router: "app",
            revalidate: false,
            fallback: false,
            headers: { Vary: "Accept" },
          },
          {
            route: "/pages-vary-accept",
            status: "rendered",
            router: "pages",
            revalidate: false,
            fallback: false,
            headers: { Vary: "Accept" },
          },
          {
            route: "/safe",
            status: "rendered",
            router: "pages",
            revalidate: false,
            fallback: false,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("html", {
          status: 200,
          headers: {
            "CF-Cache-Status": "MISS",
            Vary: "Cookie, Authorization, Host, X-Forwarded-Proto",
          },
        }),
    );

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      paths: ["/safe"],
      rscPaths: [],
      rscCacheKeyMode: "response-vary",
    });
    await expect(
      warmCdnCacheFromPrerender({
        root: tmpDir,
        targetUrl: "https://app.example.com",
        strict: true,
        fetchImpl,
      }),
    ).resolves.toMatchObject({ total: 1, warmed: 1, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toEqual(new URL("https://app.example.com/safe"));
  });

  it("uses trailing-slash config from the full prerender manifest fallback", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({ buildId: "build-a", paths: ["/about"] }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        trailingSlash: true,
        routes: [
          {
            route: "/about",
            status: "rendered",
            router: "app",
            revalidate: false,
            fallback: false,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      paths: ["/about/"],
      rscPaths: [],
      rscCacheKeyMode: "header-digest",
    });
  });

  it("admits HTML paths only from the final prerender manifest", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        paths: ["/", "/cached/intro", "not-a-path"],
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          { route: "/old", status: "rendered", router: "app", revalidate: false, fallback: false },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPaths(tmpDir)).toEqual(["/old"]);
  });

  it("takes RSC warm paths only from exact cacheable final App prerenders", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        paths: ["/static", "/posts/first", "/dynamic", "/private", "/pages"],
        appPaths: ["/static", "/posts/first", "/dynamic", "/private"],
        rscCacheKeyMode: "response-vary",
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          {
            route: "/static",
            status: "rendered",
            router: "app",
            revalidate: false,
            fallback: false,
          },
          {
            route: "/posts/:slug",
            path: "/posts/first",
            status: "rendered",
            router: "app",
            revalidate: 60,
            fallback: false,
          },
          {
            route: "/late-discovery",
            status: "rendered",
            router: "app",
            revalidate: false,
            fallback: false,
          },
          {
            route: "/dynamic",
            status: "skipped",
            router: "app",
          },
          {
            route: "/fallback/:slug",
            path: "/fallback/[slug]",
            status: "rendered",
            router: "app",
            revalidate: 60,
            fallback: true,
          },
          {
            route: "/private",
            status: "rendered",
            router: "app",
            revalidate: false,
            fallback: false,
            headers: { "Cache-Control": "private, no-store" },
          },
          {
            route: "/pages",
            status: "rendered",
            router: "pages",
            revalidate: false,
            fallback: false,
          },
          {
            route: "/500",
            status: "rendered",
            router: "app",
            revalidate: false,
            fallback: false,
          },
          {
            route: "/failed",
            status: "error",
            router: "app",
          },
          {
            route: "/revalidate-zero",
            status: "rendered",
            router: "app",
            revalidate: 0,
            fallback: false,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      paths: ["/static", "/posts/first", "/late-discovery", "/pages"],
      rscPaths: ["/static", "/posts/first", "/late-discovery"],
      rscCacheKeyMode: "response-vary",
    });
  });

  it("adds final-render-only HTML paths in header-digest mode", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({ buildId: "build-a", paths: ["/known"], rscCacheKeyMode: "header-digest" }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          { route: "/known", status: "rendered", router: "app", revalidate: false },
          { route: "/late", status: "rendered", router: "app", revalidate: 60 },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      paths: ["/known", "/late"],
      rscPaths: [],
      rscCacheKeyMode: "header-digest",
    });
  });

  it("does not trust discovery-time appPaths when the final manifest is missing", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        paths: ["/static", "/dynamic"],
        appPaths: ["/static", "/dynamic"],
        rscCacheKeyMode: "response-vary",
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      paths: [],
      rscPaths: [],
      rscCacheKeyMode: "header-digest",
    });
  });

  it("warms the client-visible basePath and trailing-slash URL shapes", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        basePath: "/base",
        buildId: "build-a",
        deploymentId: "deploy-a",
        trailingSlash: true,
        paths: ["/", "/about", "/feed.json"],
        appPaths: ["/", "/about"],
        rscCacheKeyMode: "response-vary",
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          {
            route: "/",
            status: "rendered",
            router: "app",
            revalidate: false,
            fallback: false,
          },
          {
            route: "/about",
            status: "rendered",
            router: "app",
            revalidate: false,
            fallback: false,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      deploymentId: "deploy-a",
      paths: ["/base/", "/base/about/"],
      rscPaths: ["/base/", "/base/about/"],
      rscCacheKeyMode: "response-vary",
    });
  });

  it("treats a missing deployment ID in the built path manifest as authoritative", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        paths: ["/app"],
        appPaths: ["/app"],
        rscCacheKeyMode: "response-vary",
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        deploymentId: "current-source-id",
        routes: [
          {
            route: "/app",
            status: "rendered",
            router: "app",
            revalidate: false,
            fallback: false,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      paths: ["/app"],
      rscPaths: ["/app"],
      rscCacheKeyMode: "response-vary",
    });
  });

  it("does not guess request identity from the final manifest when the path manifest is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        deploymentId: "full-manifest-id",
        routes: [
          {
            route: "/app",
            status: "rendered",
            router: "app",
            revalidate: false,
            fallback: false,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      paths: [],
      rscPaths: [],
      rscCacheKeyMode: "header-digest",
    });
    expect(warn).toHaveBeenCalledWith(
      "[vinext] CDN warmup skipped: prerender path manifest not found or invalid.",
    );
  });

  it("throws in strict mode when the final manifest has no path manifest", () => {
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          { route: "/app", status: "rendered", router: "app", revalidate: false, fallback: false },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(() => readPrerenderWarmPaths(tmpDir, { strict: true })).toThrow(
      "prerender path manifest not found or invalid",
    );
  });

  it("uses the full prerender manifest when fallback shell paths are requested", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        paths: ["/", "/cached/intro"],
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          { route: "/", status: "rendered", router: "app", revalidate: false, fallback: false },
          {
            route: "/blog/:slug",
            path: "/blog/[slug]",
            status: "rendered",
            router: "app",
            revalidate: 60,
            fallback: true,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPaths(tmpDir, { includeFallbackShells: true })).toEqual([
      "/",
      "/blog/[slug]",
    ]);
  });

  it("keeps the built RSC URL mode while excluding fallback shells from RSC warmup", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        paths: ["/"],
        appPaths: ["/"],
        rscCacheKeyMode: "response-vary",
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          { route: "/", status: "rendered", router: "app", revalidate: false, fallback: false },
          {
            route: "/blog/:slug",
            path: "/blog/[slug]",
            status: "rendered",
            router: "app",
            revalidate: 60,
            fallback: true,
          },
          {
            route: "/about",
            status: "rendered",
            router: "pages",
            revalidate: false,
            fallback: false,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPlan(tmpDir, { includeFallbackShells: true })).toEqual({
      paths: ["/", "/blog/[slug]", "/about"],
      rscPaths: ["/"],
      rscCacheKeyMode: "response-vary",
    });
  });

  it("skips discovery-only paths when the final prerender manifest is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        paths: ["/", "/cached/intro"],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPaths(tmpDir, { includeFallbackShells: true })).toEqual([]);
    expect(warn).toHaveBeenCalledWith("[vinext] CDN warmup skipped: prerender manifest not found.");
  });

  it("throws in strict mode when only the discovery manifest exists", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({ buildId: "build-a", paths: ["/"] }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(() => readPrerenderWarmPaths(tmpDir, { strict: true })).toThrow(
      "prerender manifest not found",
    );
  });

  it("fails safely when optional path-manifest fields are malformed", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        paths: ["/"],
        appPaths: "not-an-array",
        rscCacheKeyMode: "invalid",
        trailingSlash: "true",
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          { route: "/", status: "rendered", router: "app", revalidate: false, fallback: false },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      paths: [],
      rscPaths: [],
      rscCacheKeyMode: "header-digest",
    });
  });

  it("throws in strict mode when the path manifest is malformed", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({ buildId: "build-a", paths: ["/"], rscCacheKeyMode: "invalid" }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          { route: "/", status: "rendered", router: "app", revalidate: false, fallback: false },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(() => readPrerenderWarmPaths(tmpDir, { strict: true })).toThrow(
      "prerender path manifest not found or invalid",
    );
  });

  it("skips warm paths when the path manifest build ID does not match the built Worker", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "old-build",
        paths: ["/"],
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "new-build",
        routes: [
          { route: "/", status: "rendered", router: "app", revalidate: false, fallback: false },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "new-build\n");

    expect(readPrerenderWarmPaths(tmpDir)).toEqual([]);
  });

  it("skips warm paths when the manifest build ID does not match the built Worker", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({ buildId: "new-build", paths: ["/"] }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "old-build",
        routes: [
          { route: "/", status: "rendered", router: "app", revalidate: false, fallback: false },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "new-build\n");

    expect(readPrerenderWarmPaths(tmpDir)).toEqual([]);
  });

  it("throws in strict mode when the manifest build ID does not match the built Worker", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({ buildId: "new-build", paths: ["/"] }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "old-build",
        routes: [
          { route: "/", status: "rendered", router: "app", revalidate: false, fallback: false },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "new-build\n");

    expect(() => readPrerenderWarmPaths(tmpDir, { strict: true })).toThrow(
      "prerender manifest buildId does not match",
    );
  });

  it("limits deploy warm paths to App and Pages documents", () => {
    expect(
      getWarmPathsFromPrerenderManifest({
        routes: [
          { route: "/app", status: "rendered", router: "app", revalidate: false },
          { route: "/pages", status: "rendered", router: "pages", revalidate: 60 },
          { route: "/robots.txt", status: "rendered", router: "metadata", revalidate: false },
        ],
      }),
    ).toEqual(["/app", "/pages"]);
  });

  it("builds a mixed App/Pages warm plan without immediately stale metadata", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        paths: ["/app", "/pages", "/robots.txt"],
        appPaths: ["/app"],
        rscCacheKeyMode: "response-vary",
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          { route: "/app", status: "rendered", router: "app", revalidate: false },
          { route: "/pages", status: "rendered", router: "pages", revalidate: 60 },
          {
            route: "/robots.txt",
            status: "rendered",
            router: "metadata",
            revalidate: false,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      paths: ["/app", "/pages"],
      rscPaths: ["/app"],
      rscCacheKeyMode: "response-vary",
    });
  });

  it("can select fallback-shell placeholder paths when requested", () => {
    expect(
      getWarmPathsFromPrerenderManifest(
        {
          routes: [
            {
              route: "/blog/:slug",
              path: "/blog/[slug]",
              status: "rendered",
              router: "app",
              revalidate: 60,
              fallback: true,
            },
          ],
        },
        { includeFallbackShells: true },
      ),
    ).toEqual(["/blog/[slug]"]);
  });

  it("can select error documents when requested", () => {
    expect(
      getWarmPathsFromPrerenderManifest(
        {
          routes: [
            {
              route: "/500",
              status: "rendered",
              router: "pages",
              revalidate: false,
              fallback: false,
            },
            {
              route: "/_error",
              status: "rendered",
              router: "pages",
              revalidate: false,
              fallback: false,
            },
          ],
        },
        { includeErrorDocuments: true },
      ),
    ).toEqual(["/500", "/_error"]);
  });

  it("builds target URLs from root and nested paths", () => {
    expect(buildWarmupUrl("https://worker.example.workers.dev", "/docs/intro").toString()).toBe(
      "https://worker.example.workers.dev/docs/intro",
    );
  });

  it("rejects warm paths that can escape the configured target origin", () => {
    expect(() =>
      buildWarmupUrl("https://worker.example.workers.dev", "//attacker.invalid"),
    ).toThrow("Unsafe CDN warmup pathname");
  });

  it("rejects protocol-relative base paths from build manifests", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        basePath: "//attacker.invalid",
        buildId: "build-a",
        paths: ["/"],
        appPaths: [],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      paths: [],
      rscPaths: [],
      rscCacheKeyMode: "header-digest",
    });
  });

  it("rejects noncanonical root base paths from build manifests", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        basePath: "/",
        buildId: "build-a",
        paths: ["/nested"],
        appPaths: [],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      paths: [],
      rscPaths: [],
      rscCacheKeyMode: "header-digest",
    });
  });

  it("requests every warmable path through the target URL", async () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        paths: ["/", "/about"],
        appPaths: ["/"],
        rscCacheKeyMode: "response-vary",
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          { route: "/", status: "rendered", router: "app", revalidate: false, fallback: false },
          {
            route: "/about",
            status: "rendered",
            router: "pages",
            revalidate: false,
            fallback: false,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Headers(init?.headers).get("RSC") === "1"
        ? new Response("flight", {
            status: 200,
            headers: {
              "CF-Cache-Status": "MISS",
              "Content-Type": "text/x-component",
              Vary: CANONICAL_RSC_VARY,
            },
          })
        : new Response("ok", {
            status: 200,
            headers: {
              "CF-Cache-Status": "MISS",
              Vary: "Cookie, Authorization, Host, X-Forwarded-Proto",
            },
          }),
    );

    const result = await warmCdnCacheFromPrerender({
      root: tmpDir,
      targetUrl: "https://app.example.com",
      concurrency: 1,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toMatchObject({ total: 3, warmed: 3, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstInput = fetchMock.mock.calls[0]![0];
    const secondInput = fetchMock.mock.calls[1]![0];
    expect(firstInput).toBeInstanceOf(URL);
    expect(secondInput).toBeInstanceOf(URL);
    expect((firstInput as URL).href).toBe("https://app.example.com/");
    expect((secondInput as URL).href).toBe("https://app.example.com/about");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
    expect((fetchMock.mock.calls[2]![0] as URL).href).toBe("https://app.example.com/?_rsc");
    expect(fetchMock.mock.calls[2]![1]).toMatchObject({ redirect: "manual" });
  });

  it("warms an already resolved path list without rereading the manifest", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("ok", {
          status: 200,
          headers: {
            "CF-Cache-Status": "HIT",
            Vary: "Cookie, Authorization, Host, X-Forwarded-Proto",
          },
        }),
    );

    const result = await warmCdnCache({
      targetUrl: "https://app.example.com",
      paths: ["/", "/about"],
      concurrency: 1,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toMatchObject({ total: 2, warmed: 2, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds response body draining by the configured request timeout", async () => {
    vi.useFakeTimers();
    let bodyCancelled = false;
    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
      cancel() {
        bodyCancelled = true;
      },
    });

    try {
      const resultPromise = warmCdnCache({
        targetUrl: "https://app.example.com",
        paths: ["/streaming"],
        timeoutMs: 25,
        retries: 0,
        fetchImpl: async () =>
          new Response(stalledBody, {
            status: 200,
            headers: {
              "CF-Cache-Status": "MISS",
              Vary: "Cookie, Authorization, Host, X-Forwarded-Proto",
            },
          }),
      });

      await vi.advanceTimersByTimeAsync(25);

      await expect(resultPromise).resolves.toMatchObject({
        total: 1,
        warmed: 0,
        failed: 1,
        failures: [{ path: "/streaming", error: "timed out after 25ms" }],
      });
      expect(bodyCancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a late response without locking its body after timeout", async () => {
    vi.useFakeTimers();
    let bodyCancelled = false;
    const lateBody = new ReadableStream<Uint8Array>({
      cancel() {
        bodyCancelled = true;
      },
    });

    try {
      const resultPromise = warmCdnCache({
        targetUrl: "https://app.example.com",
        paths: ["/late"],
        timeoutMs: 5,
        retries: 0,
        fetchImpl: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          return new Response(lateBody, { status: 200 });
        },
      });

      await vi.advanceTimersByTimeAsync(10);

      await expect(resultPromise).resolves.toMatchObject({
        total: 1,
        warmed: 0,
        failed: 1,
        failures: [{ path: "/late", error: "timed out after 5ms" }],
      });
      expect(bodyCancelled).toBe(true);
      expect(lateBody.locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries after a response body drain times out", async () => {
    vi.useFakeTimers();
    let bodyCancelled = false;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              bodyCancelled = true;
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response("complete", {
          status: 200,
          headers: {
            "CF-Cache-Status": "MISS",
            Vary: "Cookie, Authorization, Host, X-Forwarded-Proto",
          },
        }),
      );

    try {
      const resultPromise = warmCdnCache({
        targetUrl: "https://app.example.com",
        paths: ["/streaming"],
        timeoutMs: 25,
        retries: 1,
        fetchImpl: fetchMock,
      });

      await vi.advanceTimersByTimeAsync(25);

      await expect(resultPromise).resolves.toMatchObject({ total: 1, warmed: 1, failed: 0 });
      expect(bodyCancelled).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("warms one exact base RSC request for each App Router path", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      return headers.get("RSC") === "1"
        ? new Response("flight", {
            status: 200,
            headers: {
              "CF-Cache-Status": "MISS",
              "Content-Type": "text/x-component; charset=utf-8",
              Vary: CANONICAL_RSC_VARY,
            },
          })
        : new Response("html", {
            status: 200,
            headers: {
              "CF-Cache-Status": "MISS",
              "Content-Type": "text/html",
              Vary: "Cookie, Authorization, Host, X-Forwarded-Proto",
            },
          });
    });

    const result = await warmCdnCache({
      targetUrl: "https://app.example.com",
      paths: ["/app", "/pages"],
      rscPaths: ["/app"],
      rscCacheKeyMode: "response-vary",
      deploymentId: "configured-deploy-id",
      headers: { "Cloudflare-Workers-Version-Overrides": 'app="version-a"' },
      concurrency: 1,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toMatchObject({ total: 3, warmed: 3, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [rscInput, rscInit] = fetchMock.mock.calls[2]!;
    const rscHeaders = new Headers(rscInit?.headers);
    expect((rscInput as URL).href).toBe("https://app.example.com/app?_rsc");
    expect(rscInit).toMatchObject({ method: "GET", redirect: "manual" });
    expect(rscHeaders.get("RSC")).toBe("1");
    expect(rscHeaders.get("Accept")).toBe("text/x-component");
    expect(rscHeaders.get("Next-Router-State-Tree")).toBeNull();
    expect(rscHeaders.get("Next-Router-Prefetch")).toBeNull();
    expect(rscHeaders.get("Next-Router-Segment-Prefetch")).toBeNull();
    expect(rscHeaders.get("Next-Url")).toBeNull();
    expect(rscHeaders.get("x-deployment-id")).toBe("configured-deploy-id");
    expect(rscHeaders.get("Cloudflare-Workers-Version-Overrides")).toBe('app="version-a"');
  });

  it("does not count redirected or non-RSC responses as warmed RSC variants", async () => {
    for (const response of [
      new Response(null, { status: 307, headers: { Location: "/app?_rsc" } }),
      new Response("html", { status: 200, headers: { "Content-Type": "text/html" } }),
    ]) {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        response.clone(),
      );
      const result = await warmCdnCache({
        targetUrl: "https://app.example.com",
        paths: [],
        rscPaths: ["/app"],
        rscCacheKeyMode: "response-vary",
        fetchImpl: fetchMock as typeof fetch,
      });

      expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1 });
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
    }
  });

  it("does not follow HTML redirects outside the warm target", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, {
          status: 307,
          headers: { Location: "https://attacker.invalid/capture" },
        }),
    );

    const result = await warmCdnCache({
      targetUrl: "https://app.example.com",
      paths: ["/redirect"],
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });

  it("does not inherit a deploy-process deployment ID when the artifact has none", async () => {
    const previousInternal = process.env.__VINEXT_DEPLOYMENT_ID;
    const previousPublic = process.env.NEXT_DEPLOYMENT_ID;
    delete process.env.__VINEXT_DEPLOYMENT_ID;
    process.env.NEXT_DEPLOYMENT_ID = "current-source-id";
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("flight", {
          status: 200,
          headers: {
            "CF-Cache-Status": "MISS",
            "Content-Type": "text/x-component",
            Vary: CANONICAL_RSC_VARY,
          },
        }),
    );

    try {
      await warmCdnCache({
        targetUrl: "https://app.example.com",
        paths: [],
        rscPaths: ["/app"],
        rscCacheKeyMode: "response-vary",
        fetchImpl: fetchMock as typeof fetch,
      });
    } finally {
      if (previousInternal === undefined) delete process.env.__VINEXT_DEPLOYMENT_ID;
      else process.env.__VINEXT_DEPLOYMENT_ID = previousInternal;
      if (previousPublic === undefined) delete process.env.NEXT_DEPLOYMENT_ID;
      else process.env.NEXT_DEPLOYMENT_ID = previousPublic;
    }

    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("x-deployment-id")).toBeNull();
  });

  it.each(["BYPASS", "DYNAMIC", "NONE/UNKNOWN", "unexpected"])(
    "does not count CF-Cache-Status %s responses as warmed",
    async (cacheStatus) => {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const isRsc = new Headers(init?.headers).get("RSC") === "1";
        return new Response(isRsc ? "flight" : "html", {
          status: 200,
          headers: {
            "CF-Cache-Status": cacheStatus,
            "Content-Type": isRsc ? "text/x-component" : "text/html",
            ...(isRsc ? { Vary: CANONICAL_RSC_VARY } : {}),
          },
        });
      });

      const result = await warmCdnCache({
        targetUrl: "https://app.example.com",
        paths: ["/app"],
        rscPaths: ["/app"],
        rscCacheKeyMode: "response-vary",
        fetchImpl: fetchMock as typeof fetch,
      });

      expect(result).toMatchObject({ total: 2, warmed: 0, failed: 2 });
    },
  );

  it("does not count responses without CF-Cache-Status as warmed", async () => {
    const result = await warmCdnCache({
      targetUrl: "https://app.example.com",
      paths: ["/app"],
      fetchImpl: async () =>
        new Response("html", {
          status: 200,
          headers: { Vary: "Cookie, Authorization, Host, X-Forwarded-Proto" },
        }),
    });

    expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1 });
    expect(result.failures[0]?.error).toBe("missing CF-Cache-Status");
  });

  it("does not count a cache entry varied by the warmup user agent as reusable", async () => {
    const result = await warmCdnCache({
      targetUrl: "https://app.example.com",
      paths: ["/app"],
      fetchImpl: async () =>
        new Response("html", {
          status: 200,
          headers: { "CF-Cache-Status": "MISS", Vary: "User-Agent" },
        }),
    });

    expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1 });
    expect(result.failures[0]?.error).toBe("unsupported Vary field: User-Agent");
  });

  it.each([
    ["Authorization, Host", "cookie"],
    ["Cookie, Host", "authorization"],
    ["Cookie, Authorization", "host"],
    ["Cookie, Authorization, Host", "x-forwarded-proto"],
  ])("rejects HTML entries without required Vary isolation (%s)", async (vary, missing) => {
    const result = await warmCdnCache({
      targetUrl: "https://app.example.com",
      paths: ["/app"],
      fetchImpl: async () =>
        new Response("html", {
          status: 200,
          headers: { "CF-Cache-Status": "MISS", Vary: vary },
        }),
    });

    expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1 });
    expect(result.failures[0]?.error).toBe(`missing required Vary field: ${missing}`);
  });

  it("accepts HTML entries isolated by credentials, host, and forwarded protocol", async () => {
    const result = await warmCdnCache({
      targetUrl: "https://app.example.com",
      paths: ["/app"],
      fetchImpl: async () =>
        new Response("html", {
          status: 200,
          headers: {
            "CF-Cache-Status": "MISS",
            Vary: "Cookie, Authorization, Host, X-Forwarded-Proto",
          },
        }),
    });

    expect(result).toMatchObject({ total: 1, warmed: 1, failed: 0 });
  });

  it("accepts adapter-controlled identity variance for reusable RSC entries", async () => {
    const result = await warmCdnCache({
      targetUrl: "https://app.example.com",
      paths: [],
      rscPaths: ["/app"],
      rscCacheKeyMode: "response-vary",
      fetchImpl: async (_input, init) => {
        expect(new Headers(init?.headers).get("Cookie")).toBeNull();
        return new Response("flight", {
          status: 200,
          headers: {
            "CF-Cache-Status": "MISS",
            "Content-Type": "text/x-component",
            Vary: CANONICAL_RSC_VARY,
          },
        });
      },
    });

    expect(result).toMatchObject({ total: 1, warmed: 1, failed: 0 });
  });

  it("rejects RSC entries without every required Vary isolation field", async () => {
    const result = await warmCdnCache({
      targetUrl: "https://app.example.com",
      paths: [],
      rscPaths: ["/app"],
      rscCacheKeyMode: "response-vary",
      fetchImpl: async () =>
        new Response("flight", {
          status: 200,
          headers: {
            "CF-Cache-Status": "MISS",
            "Content-Type": "text/x-component",
          },
        }),
    });

    expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1 });
    expect(result.failures[0]?.error).toBe("missing required Vary field: rsc");
  });

  it("rejects RSC entries without forwarded-protocol isolation", async () => {
    const result = await warmCdnCache({
      targetUrl: "https://app.example.com",
      paths: [],
      rscPaths: ["/app"],
      rscCacheKeyMode: "response-vary",
      fetchImpl: async () =>
        new Response("flight", {
          status: 200,
          headers: {
            "CF-Cache-Status": "MISS",
            "Content-Type": "text/x-component",
            Vary: `${VINEXT_RSC_NON_CONTEXTUAL_VARY_HEADER}, Cookie, Authorization, Host`,
          },
        }),
    });

    expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1 });
    expect(result.failures[0]?.error).toBe("missing required Vary field: x-forwarded-proto");
  });

  it("accepts host and forwarded protocol in the canonical RSC Vary contract", async () => {
    const result = await warmCdnCache({
      targetUrl: "https://warm.example.com",
      paths: [],
      rscPaths: ["/app"],
      rscCacheKeyMode: "response-vary",
      fetchImpl: async () =>
        new Response("flight", {
          status: 200,
          headers: {
            "CF-Cache-Status": "MISS",
            "Content-Type": "text/x-component",
            Vary: CANONICAL_RSC_VARY,
          },
        }),
    });

    expect(result).toMatchObject({ total: 1, warmed: 1, failed: 0 });
  });

  it("reports warmup failures and throws in strict mode", async () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({ buildId: "build-a", paths: ["/broken"] }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          {
            route: "/broken",
            status: "rendered",
            router: "pages",
            revalidate: false,
            fallback: false,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("nope", { status: 404 }),
    );

    await expect(
      warmCdnCacheFromPrerender({
        root: tmpDir,
        targetUrl: "https://app.example.com",
        strict: true,
        fetchImpl: fetchMock as typeof fetch,
      }),
    ).rejects.toThrow("CDN warmup failed for 1/1 request");
  });
});
