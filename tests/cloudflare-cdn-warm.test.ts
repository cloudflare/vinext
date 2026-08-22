import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import { createServer } from "node:http";
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

  it("canonicalizes build-discovered paths to the manifest's trailingSlash form", () => {
    // Warmup fetches with redirect: "manual", so requesting the bare path
    // under trailingSlash: true would stop at the 308 and leave the canonical
    // HTML entry cold. Paths must be normalized before any request is made.
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        trailingSlash: true,
        paths: ["/", "/about", "/about/", "/docs/intro"],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPaths(tmpDir)).toEqual(["/", "/about/", "/docs/intro/"]);
  });

  it("warms the canonical trailing-slash URL instead of the redirecting bare path", async () => {
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        trailingSlash: true,
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
    expect(fetchMock.mock.calls.map(([input]) => (input as URL).href)).toEqual([
      "https://app.example.com/",
      "https://app.example.com/about/",
    ]);
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
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });

  it("verifies a canonical redirect at its original cache key", async () => {
    const expectedVersionId = "22222222-2222-4222-8222-222222222222";
    const requestedPaths: string[] = [];
    const server = createServer((request, response) => {
      requestedPaths.push(request.url ?? "");
      if (request.url === "/old-path") {
        response.writeHead(302, {
          Location: "/destination",
          "x-vinext-worker-version": "11111111-1111-4111-8111-111111111111",
        });
      } else {
        response.writeHead(200, { "x-vinext-worker-version": expectedVersionId });
      }
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server");

      const result = await warmCdnCache({
        targetUrl: `http://127.0.0.1:${address.port}`,
        paths: ["/old-path"],
        expectedVersionId,
        retries: 0,
      });

      expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1 });
      expect(result.failures[0]?.error).toContain("expected Worker version");
      expect(requestedPaths).toEqual(["/old-path"]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
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

  it("retries a successful response until the cached representation matches the uploaded version", async () => {
    const expectedVersionId = "22222222-2222-4222-8222-222222222222";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("old cached html", {
          status: 200,
          headers: { "x-vinext-worker-version": "11111111-1111-4111-8111-111111111111" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("new html", {
          status: 200,
          headers: { "x-vinext-worker-version": expectedVersionId },
        }),
      );

    const result = await warmCdnCache({
      targetUrl: "https://app.example.com",
      paths: ["/"],
      expectedVersionId,
      retries: 1,
      retryDelayMs: 0,
      fetchImpl: fetchMock,
    });

    expect(result).toMatchObject({ total: 1, warmed: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "retryable status",
      async (): Promise<Response> => new Response("unavailable", { status: 503 }),
    ],
    ["network error", async (): Promise<Response> => Promise.reject(new Error("connection reset"))],
  ])("backs off before retrying a %s", async (_case, firstResult) => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(firstResult)
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));

      const resultPromise = warmCdnCache({
        targetUrl: "https://app.example.com",
        paths: ["/"],
        retries: 1,
        retryDelayMs: 250,
        fetchImpl: fetchMock,
      });

      await vi.advanceTimersByTimeAsync(249);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(resultPromise).resolves.toMatchObject({ total: 1, warmed: 1, failed: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not count an unverified 200 cache hit as warmed", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response("old cached html", {
          status: 200,
          headers: { "x-vinext-worker-version": "11111111-1111-4111-8111-111111111111" },
        }),
    );

    const result = await warmCdnCache({
      targetUrl: "https://app.example.com",
      paths: ["/"],
      expectedVersionId: "22222222-2222-4222-8222-222222222222",
      retries: 1,
      retryDelayMs: 0,
      fetchImpl: fetchMock,
    });

    expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1 });
    expect(result.failures[0]?.error).toContain("expected Worker version");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not count a legacy 200 cache hit without producer metadata as warmed", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("old cached html", { status: 200 }));

    const result = await warmCdnCache({
      targetUrl: "https://app.example.com",
      paths: ["/"],
      expectedVersionId: "22222222-2222-4222-8222-222222222222",
      retries: 0,
      retryDelayMs: 0,
      fetchImpl: fetchMock,
    });

    expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1 });
    expect(result.failures[0]?.error).toContain("did not include x-vinext-worker-version");
  });

  it("retries an old-version 404 instead of treating it as terminal", async () => {
    const expectedVersionId = "22222222-2222-4222-8222-222222222222";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        // Before the override propagates, the old Worker (100% traffic) answers
        // a newly added route with a 404 of its own, not the uploaded version's.
        new Response("not found", {
          status: 404,
          headers: { "x-vinext-worker-version": "11111111-1111-4111-8111-111111111111" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("new html", {
          status: 200,
          headers: { "x-vinext-worker-version": expectedVersionId },
        }),
      );

    const result = await warmCdnCache({
      targetUrl: "https://app.example.com",
      paths: ["/pricing"],
      expectedVersionId,
      retries: 1,
      retryDelayMs: 0,
      fetchImpl: fetchMock,
    });

    expect(result).toMatchObject({ total: 1, warmed: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails when a build-discovered path returns a 404 from the expected version", async () => {
    const expectedVersionId = "22222222-2222-4222-8222-222222222222";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("not found", {
        status: 404,
        headers: { "x-vinext-worker-version": expectedVersionId },
      }),
    );

    const result = await warmCdnCache({
      targetUrl: "https://app.example.com",
      paths: ["/removed"],
      expectedVersionId,
      retries: 0,
      fetchImpl: fetchMock,
    });

    expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1 });
    expect(result.failures[0]?.error).toBe("HTTP 404");
  });

  describe("cache-write confirmation (confirmCache)", () => {
    const expectedVersionId = "22222222-2222-4222-8222-222222222222";
    const cacheResponse = (cacheStatus: string | null, versionId = expectedVersionId): Response =>
      new Response("html", {
        status: 200,
        headers: {
          "x-vinext-worker-version": versionId,
          ...(cacheStatus ? { "cf-cache-status": cacheStatus } : {}),
        },
      });
    const warmOne = (fetchMock: typeof fetch, retries = 0) =>
      warmCdnCache({
        targetUrl: "https://app.example.com",
        paths: ["/"],
        expectedVersionId,
        confirmCache: true,
        retries,
        retryDelayMs: 0,
        fetchImpl: fetchMock,
      });

    it("accepts an immediate cache HIT without a confirm request", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(cacheResponse("HIT"));

      const result = await warmOne(fetchMock);

      expect(result).toMatchObject({ total: 1, warmed: 1, failed: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("confirms a MISS fill with a second cache-served request", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(cacheResponse("MISS"))
        .mockResolvedValueOnce(cacheResponse("HIT"));

      const result = await warmOne(fetchMock);

      expect(result).toMatchObject({ total: 1, warmed: 1, failed: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not count a fill that never comes back cache-served as warmed", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => cacheResponse("MISS"));

      const result = await warmOne(fetchMock, 1);

      expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1 });
      expect(result.failures[0]?.error).toBe("cache entry not confirmed (cf-cache-status: MISS)");
      // Two attempts, each a fill request plus a confirm request.
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("treats an uncacheable BYPASS response as terminal without burning retries", async () => {
      // Cache-Control: no-store / private / Set-Cookie produce BYPASS
      // deterministically — the same response shape returns on every retry.
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => cacheResponse("BYPASS"));

      const result = await warmOne(fetchMock, 3);

      expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1 });
      expect(result.failures[0]?.error).toBe(
        "response was not stored by Workers Cache (cf-cache-status: BYPASS)",
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("fails when the expected version responds without any cache status", async () => {
      // A per-entrypoint cache override can disable Workers Cache while the
      // top-level config still says enabled: the Worker answers 200 with the
      // right version header but the cache never runs.
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(cacheResponse(null));

      const result = await warmOne(fetchMock);

      expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1 });
      expect(result.failures[0]?.error).toBe(
        "response was not stored by Workers Cache (cf-cache-status: missing)",
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects a confirm response served by a different Worker version", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(cacheResponse("MISS"))
        .mockResolvedValueOnce(cacheResponse("HIT", "11111111-1111-4111-8111-111111111111"));

      const result = await warmOne(fetchMock);

      expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1 });
      expect(result.failures[0]?.error).toContain("expected Worker version");
    });
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
