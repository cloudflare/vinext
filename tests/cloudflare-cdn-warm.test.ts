import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildWarmupUrl,
  DEFAULT_CDN_WARM_TIMEOUT_MS,
  warmCdnCache,
  getWarmPathsFromPrerenderManifest,
  readPrerenderWarmPlan,
  readPrerenderWarmPaths,
  warmCdnCacheFromPrerender,
} from "../packages/cloudflare/src/cdn-warm.js";

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

  it("reads warmable paths from the prerender manifest", () => {
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

  it("uses trailing-slash config from the full prerender manifest fallback", () => {
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
      rscPaths: ["/about/"],
      rscCacheKeyMode: "header-digest",
    });
  });

  it("prefers the build-discovered prerender path manifest", () => {
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

    expect(readPrerenderWarmPaths(tmpDir)).toEqual(["/", "/cached/intro"]);
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
      paths: ["/static", "/posts/first", "/dynamic", "/private", "/pages"],
      rscPaths: ["/static", "/posts/first"],
      rscCacheKeyMode: "response-vary",
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
      paths: ["/static", "/dynamic"],
      rscPaths: [],
      rscCacheKeyMode: "response-vary",
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
      paths: ["/base/", "/base/about/", "/base/feed.json"],
      rscPaths: ["/base/", "/base/about/"],
      rscCacheKeyMode: "response-vary",
    });
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

  it("warns when fallback shells are requested without a prerender manifest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        paths: ["/", "/cached/intro"],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPaths(tmpDir, { includeFallbackShells: true })).toEqual([
      "/",
      "/cached/intro",
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[vinext] CDN warmup fallback shells requested, but prerender manifest not found; warming build-discovered paths only.",
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
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      paths: [],
      rscPaths: [],
      rscCacheKeyMode: "header-digest",
    });
  });

  it("skips warm paths when the path manifest build ID does not match the built Worker", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "old-build",
        paths: ["/"],
      }),
    );
    writeFile("dist/server/BUILD_ID", "new-build\n");

    expect(readPrerenderWarmPaths(tmpDir)).toEqual([]);
  });

  it("skips warm paths when the manifest build ID does not match the built Worker", () => {
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
            headers: { "CF-Cache-Status": "MISS", "Content-Type": "text/x-component" },
          })
        : new Response("ok", { status: 200, headers: { "CF-Cache-Status": "MISS" } }),
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
        new Response("ok", { status: 200, headers: { "CF-Cache-Status": "HIT" } }),
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

  it("warms one exact base RSC request for each App Router path", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      return headers.get("RSC") === "1"
        ? new Response("flight", {
            status: 200,
            headers: {
              "CF-Cache-Status": "MISS",
              "Content-Type": "text/x-component; charset=utf-8",
            },
          })
        : new Response("html", {
            status: 200,
            headers: { "CF-Cache-Status": "MISS", "Content-Type": "text/html" },
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
          headers: { "CF-Cache-Status": "MISS", "Content-Type": "text/x-component" },
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
      fetchImpl: async () => new Response("html", { status: 200 }),
    });

    expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1 });
    expect(result.failures[0]?.error).toBe("missing CF-Cache-Status");
  });

  it("reports warmup failures and throws in strict mode", async () => {
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
