import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildWarmupUrl,
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
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Cloudflare CDN warmup", () => {
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
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPaths(tmpDir)).toEqual(["/", "/docs/intro"]);
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

  it("builds preview URLs from root and nested paths", () => {
    expect(buildWarmupUrl("https://worker.example.workers.dev", "/docs/intro").toString()).toBe(
      "https://worker.example.workers.dev/docs/intro",
    );
  });

  it("requests every warmable path through the preview URL", async () => {
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
      previewUrl: "https://version.example.workers.dev",
      concurrency: 1,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toMatchObject({ total: 2, warmed: 2, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstInput = fetchMock.mock.calls[0]![0];
    const secondInput = fetchMock.mock.calls[1]![0];
    expect(firstInput).toBeInstanceOf(URL);
    expect(secondInput).toBeInstanceOf(URL);
    expect((firstInput as URL).href).toBe("https://version.example.workers.dev/");
    expect((secondInput as URL).href).toBe("https://version.example.workers.dev/about");
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
        previewUrl: "https://version.example.workers.dev",
        strict: true,
        fetchImpl: fetchMock as typeof fetch,
      }),
    ).rejects.toThrow("CDN warmup failed for 1/1 path");
  });
});
