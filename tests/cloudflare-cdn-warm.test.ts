import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildWarmupUrl,
  DEFAULT_CDN_WARM_TIMEOUT_MS,
  warmCdnCache,
  getWarmPathsFromPrerenderManifest,
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
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok", { status: 200 }),
    );

    const result = await warmCdnCacheFromPrerender({
      root: tmpDir,
      targetUrl: "https://app.example.com",
      concurrency: 1,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toMatchObject({ total: 2, warmed: 2, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstInput = fetchMock.mock.calls[0]![0];
    const secondInput = fetchMock.mock.calls[1]![0];
    expect(firstInput).toBeInstanceOf(URL);
    expect(secondInput).toBeInstanceOf(URL);
    expect((firstInput as URL).href).toBe("https://app.example.com/");
    expect((secondInput as URL).href).toBe("https://app.example.com/about");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "follow" });
  });

  it("warms an already resolved path list without rereading the manifest", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok", { status: 200 }),
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

  it("reports warmup failures and throws in strict mode", async () => {
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          {
            route: "/broken",
            status: "rendered",
            router: "app",
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
    ).rejects.toThrow("CDN warmup failed for 1/1 path");
  });
});
