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
import {
  VINEXT_RSC_BUILD_ID_HEADER,
  VINEXT_RSC_VARY_HEADER,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";

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

  it("prefers completed prerender results over discovery-only paths", () => {
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

  it("selects RSC warm paths only from final cacheable App prerenders", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        basePath: "/docs",
        buildId: "build-a",
        deploymentId: "dpl_123",
        paths: ["/cached/intro", "/dynamic", "/pages"],
        responseVary: "verbatim",
        rscPaths: ["/cached/intro"],
        trailingSlash: true,
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          {
            route: "/cached/:slug",
            path: "/cached/intro",
            status: "rendered",
            router: "app",
            revalidate: 60,
            fallback: false,
          },
          { route: "/dynamic", status: "skipped", router: "app" },
          {
            route: "/pages",
            status: "rendered",
            router: "pages",
            revalidate: false,
            fallback: false,
          },
          {
            route: "/zero",
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
      buildId: "build-a",
      deploymentId: "dpl_123",
      paths: ["/docs/cached/intro/", "/docs/pages/"],
      rscPaths: ["/docs/cached/intro/"],
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
      "[vinext] CDN warmup has no completed prerender manifest; RSC warmup is disabled.",
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

  it("does not consume stale path-manifest configuration when final prerender data is current", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        basePath: "/stale",
        buildId: "old-build",
        deploymentId: "old-deployment",
        paths: ["/old"],
        responseVary: "verbatim",
        rscPaths: ["/old"],
        trailingSlash: true,
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "new-build",
        routes: [
          {
            route: "/current",
            status: "rendered",
            router: "app",
            revalidate: 60,
            fallback: false,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "new-build\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      buildId: "new-build",
      paths: ["/current"],
      rscPaths: [],
    });
  });

  it("derives RSC eligibility from completed prerender data when path metadata is stale", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        basePath: "/docs",
        buildId: "fixed-build-id",
        paths: ["/old"],
        responseVary: "verbatim",
        rscPaths: ["/old"],
        trailingSlash: true,
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "fixed-build-id",
        routes: [
          {
            route: "/current",
            status: "rendered",
            router: "app",
            revalidate: 60,
            fallback: false,
          },
          {
            route: "/old",
            status: "skipped",
            router: "app",
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "fixed-build-id\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      buildId: "fixed-build-id",
      paths: ["/docs/current/"],
      rscPaths: ["/docs/current/"],
    });
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

  it("encodes Unicode and spaces in deployment warm paths", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        paths: ["/café au lait"],
        responseVary: "verbatim",
        rscPaths: ["/café au lait"],
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          {
            route: "/café au lait",
            status: "rendered",
            router: "app",
            revalidate: 60,
            fallback: false,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      buildId: "build-a",
      paths: ["/caf%C3%A9%20au%20lait"],
      rscPaths: ["/caf%C3%A9%20au%20lait"],
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

  it("retries a staged-version 404 while the Worker version override propagates", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("old version", { status: 404 }))
      .mockResolvedValueOnce(new Response("new version", { status: 200 }));

    const result = await warmCdnCache({
      fetchImpl: fetchMock as typeof fetch,
      headers: {
        "Cloudflare-Workers-Version-Overrides": 'my-worker="22222222-2222-4222-8222-222222222222"',
      },
      paths: ["/new-route"],
      retryDelayMs: 0,
      targetUrl: "https://app.example.com",
    });

    expect(result).toMatchObject({ total: 1, warmed: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serializes propagating warm requests by default", async () => {
    let releaseFirst!: () => void;
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = () => resolve(new Response("first", { status: 200 }));
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce(new Response("second", { status: 200 }));

    const warming = warmCdnCache({
      fetchImpl: fetchMock as typeof fetch,
      headers: {
        "Cloudflare-Workers-Version-Overrides": 'my-worker="22222222-2222-4222-8222-222222222222"',
      },
      paths: ["/first", "/second"],
      targetUrl: "https://app.example.com",
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    releaseFirst();
    await expect(warming).resolves.toMatchObject({ total: 2, warmed: 2, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries transient RSC validation failures for a propagating target", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("old html response", {
          headers: { "content-type": "text/html" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response("flight", {
          headers: {
            "cache-control": "public, max-age=0, must-revalidate",
            "cf-cache-status": "MISS",
            "content-type": "text/x-component",
            vary: VINEXT_RSC_VARY_HEADER,
          },
        }),
      )
      .mockResolvedValueOnce(new Response("html", { status: 200 }));

    const result = await warmCdnCache({
      fetchImpl: fetchMock as typeof fetch,
      paths: ["/cached/intro"],
      propagatingTarget: true,
      retryDelayMs: 0,
      rscPaths: ["/cached/intro"],
      targetUrl: "https://app.example.com",
    });

    expect(result).toMatchObject({ total: 2, warmed: 2, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries an otherwise valid RSC response rendered by the previous build", async () => {
    const rscResponse = (buildId: string) =>
      new Response("flight", {
        headers: {
          "cache-control": "public, max-age=0, must-revalidate",
          "cf-cache-status": "MISS",
          "content-type": "text/x-component",
          [VINEXT_RSC_BUILD_ID_HEADER]: buildId,
          vary: VINEXT_RSC_VARY_HEADER,
        },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rscResponse("old-build"))
      .mockResolvedValueOnce(rscResponse("new-build"))
      .mockResolvedValueOnce(new Response("html", { status: 200 }));

    const result = await warmCdnCache({
      expectedBuildId: "new-build",
      fetchImpl: fetchMock as typeof fetch,
      paths: ["/cached/intro"],
      propagatingTarget: true,
      retryDelayMs: 0,
      rscPaths: ["/cached/intro"],
      targetUrl: "https://app.example.com",
    });

    expect(result).toMatchObject({ total: 2, warmed: 2, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("shares one propagation deadline across the entire serialized warmup", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchMock = vi.fn(async () => {
      now = 31_000;
      return new Response("old flight", {
        headers: {
          "cache-control": "public, max-age=0, must-revalidate",
          "cf-cache-status": "MISS",
          "content-type": "text/x-component",
          [VINEXT_RSC_BUILD_ID_HEADER]: "old-build",
          vary: VINEXT_RSC_VARY_HEADER,
        },
      });
    });

    const result = await warmCdnCache({
      expectedBuildId: "new-build",
      fetchImpl: fetchMock as typeof fetch,
      paths: ["/cached/intro"],
      propagatingTarget: true,
      retryDelayMs: 0,
      rscPaths: ["/cached/intro"],
      targetUrl: "https://app.example.com",
    });

    expect(result).toMatchObject({ total: 2, warmed: 0, failed: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("issues exactly one HTML and one canonical RSC request for an eligible path", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.get("rsc") === "1") {
        return new Response("flight", {
          headers: {
            "cache-control": "public, max-age=0, must-revalidate",
            "cf-cache-status": "MISS",
            "content-type": "text/x-component",
            vary: VINEXT_RSC_VARY_HEADER,
          },
        });
      }
      return new Response("html", { headers: { "content-type": "text/html" } });
    });

    const result = await warmCdnCache({
      deploymentId: "dpl_123",
      fetchImpl: fetchMock as typeof fetch,
      paths: ["/cached/intro"],
      rscPaths: ["/cached/intro"],
      targetUrl: "https://app.example.com",
    });

    expect(result).toMatchObject({ total: 2, warmed: 2, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]![0] as URL).href).toBe(
      "https://app.example.com/cached/intro?_rsc",
    );
    const rscInit = fetchMock.mock.calls[0]![1]!;
    expect(rscInit.redirect).toBe("manual");
    const headers = new Headers(rscInit.headers);
    expect(headers.get("accept")).toBe("text/x-component");
    expect(headers.get("rsc")).toBe("1");
    expect(headers.get("x-deployment-id")).toBe("dpl_123");
    expect(headers.get("next-router-prefetch")).toBeNull();
    expect(headers.get("next-router-state-tree")).toBeNull();
    expect(headers.get("next-url")).toBeNull();
    expect((fetchMock.mock.calls[1]![0] as URL).href).toBe("https://app.example.com/cached/intro");
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get("accept")).toBe("text/html");
  });

  it("rejects an RSC response that Cloudflare bypassed", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const isRsc = new Headers(init?.headers).get("rsc") === "1";
      return new Response(isRsc ? "flight" : "html", {
        headers: isRsc
          ? {
              "cache-control": "no-store",
              "cf-cache-status": "BYPASS",
              "content-type": "text/x-component",
              vary: VINEXT_RSC_VARY_HEADER,
            }
          : { "content-type": "text/html" },
      });
    });

    await expect(
      warmCdnCache({
        fetchImpl: fetchMock as typeof fetch,
        paths: ["/cached/intro"],
        rscPaths: ["/cached/intro"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow("Cache-Control is not cacheable");
  });

  it.each([
    {
      label: "an unsupported Vary field",
      headers: {
        "cf-cache-status": "MISS",
        vary: `${VINEXT_RSC_VARY_HEADER}, User-Agent`,
      },
      error: "response Vary has unsupported field user-agent",
    },
    {
      label: "no Cloudflare cache admission evidence",
      headers: { vary: VINEXT_RSC_VARY_HEADER },
      error: "response is missing CF-Cache-Status",
    },
  ])("rejects an RSC response with $label", async ({ headers, error }) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const isRsc = new Headers(init?.headers).get("rsc") === "1";
      const responseHeaders = new Headers(
        isRsc
          ? {
              "cache-control": "public, max-age=0, must-revalidate",
              "content-type": "text/x-component",
            }
          : { "content-type": "text/html" },
      );
      if (isRsc) {
        for (const [name, value] of Object.entries(headers)) {
          responseHeaders.set(name, value);
        }
      }
      return new Response(isRsc ? "flight" : "html", {
        headers: responseHeaders,
      });
    });

    await expect(
      warmCdnCache({
        fetchImpl: fetchMock as typeof fetch,
        paths: ["/cached/intro"],
        rscPaths: ["/cached/intro"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow(error);
  });

  it("times out when response headers arrive but the body never completes", async () => {
    const fetchMock = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
        },
      });
      return new Response(body, { status: 200 });
    });

    const result = await warmCdnCache({
      fetchImpl: fetchMock as typeof fetch,
      paths: ["/stalled"],
      retries: 0,
      targetUrl: "https://app.example.com",
      timeoutMs: 5,
    });

    expect(result).toEqual({
      total: 1,
      warmed: 0,
      failed: 1,
      failures: [{ path: "/stalled", error: "timed out after 5ms" }],
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
    ).rejects.toThrow("CDN warmup failed for 1/1 request");
  });
});
