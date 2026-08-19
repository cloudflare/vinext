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

function toRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url);
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
        buildIdentityPath: "/_next/static/build-a/rsc-build-a/vinext-rsc-prewarm.json",
        deploymentId: "dpl_123",
        paths: ["/cached/intro", "/dynamic", "/pages"],
        responseVary: "verbatim",
        rscBuildId: "rsc-build-a",
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
            rscVary: VINEXT_RSC_VARY_HEADER,
            rscPrewarmable: true,
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
      buildIdentityPath: "/_next/static/build-a/rsc-build-a/vinext-rsc-prewarm.json",
      deploymentId: "dpl_123",
      paths: ["/docs/cached/intro/", "/docs/pages/"],
      rscBuildId: "rsc-build-a",
      rscPaths: ["/docs/cached/intro/"],
    });
  });

  it("preserves discovered Pages HTML paths without prerendering Pages for RSC eligibility", () => {
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        pagesPaths: ["/pages"],
        paths: ["/cached/intro", "/pages"],
        responseVary: "verbatim",
        rscBuildId: "rsc-build-a",
        rscPaths: ["/cached/intro"],
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          {
            route: "/cached/intro",
            status: "rendered",
            router: "app",
            revalidate: 60,
            fallback: false,
            rscVary: VINEXT_RSC_VARY_HEADER,
            rscPrewarmable: true,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      paths: ["/cached/intro", "/pages"],
      rscBuildId: "rsc-build-a",
      rscPaths: ["/cached/intro"],
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
        rscBuildId: "old-rsc-build",
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
            rscVary: VINEXT_RSC_VARY_HEADER,
            rscPrewarmable: true,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "new-build\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
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
        rscBuildId: "rsc-build-a",
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
            rscVary: VINEXT_RSC_VARY_HEADER,
            rscPrewarmable: true,
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
      paths: ["/docs/current/"],
      rscBuildId: "rsc-build-a",
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
        rscBuildId: "rsc-build-a",
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
            rscVary: VINEXT_RSC_VARY_HEADER,
            rscPrewarmable: true,
          },
        ],
      }),
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      paths: ["/caf%C3%A9%20au%20lait"],
      rscBuildId: "rsc-build-a",
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

  it("keeps HTML-only warmup at normal concurrency", async () => {
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

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    releaseFirst();
    await expect(warming).resolves.toMatchObject({ total: 2, warmed: 2, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gates explicit warmup concurrency on the uploaded RSC build identity", async () => {
    let releaseRsc!: () => void;
    const rscGate = new Promise<void>((resolve) => {
      releaseRsc = resolve;
    });
    const events: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (new Headers(init?.headers).get("rsc") === "1") {
        events.push("start:rsc");
        await rscGate;
        events.push("end:rsc");
        return new Response("flight", {
          headers: {
            "cache-control": "public, max-age=0, must-revalidate",
            "cf-cache-status": "MISS",
            "content-type": "text/x-component",
            [VINEXT_RSC_BUILD_ID_HEADER]: "build-a",
            vary: VINEXT_RSC_VARY_HEADER,
          },
        });
      }
      events.push("start:html");
      return new Response("html", { status: 200 });
    });

    const warming = warmCdnCache({
      concurrency: 2,
      expectedRscBuildId: "build-a",
      fetchImpl: fetchMock as typeof fetch,
      paths: ["/cached/intro"],
      propagatingTarget: true,
      retryDelayMs: 0,
      rscPaths: ["/cached/intro"],
      targetUrl: "https://app.example.com",
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(events).toEqual(["start:rsc"]);
    releaseRsc();
    await expect(warming).resolves.toMatchObject({ total: 2, warmed: 2, failed: 0 });
    expect(events).toEqual(["start:rsc", "end:rsc", "start:html"]);
  });

  it("gates HTML-only warmup on an immutable uploaded-build asset", async () => {
    let identityAttempt = 0;
    const events: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = toRequestUrl(input);
      if (url.pathname.endsWith("/vinext-rsc-prewarm.json")) {
        identityAttempt++;
        events.push(`identity:${identityAttempt}`);
        return new Response(identityAttempt === 1 ? "missing" : "{}", {
          status: identityAttempt === 1 ? 404 : 200,
        });
      }
      events.push(`html:${url.pathname}`);
      return new Response("html", { status: 200 });
    });

    const result = await warmCdnCache({
      buildIdentityPath: "/_next/static/build-a/rsc-build-a/vinext-rsc-prewarm.json",
      fetchImpl: fetchMock as typeof fetch,
      paths: ["/pages-a", "/pages-b"],
      propagatingTarget: true,
      retryDelayMs: 0,
      targetUrl: "https://app.example.com",
    });

    expect(result).toMatchObject({ total: 2, warmed: 2, failed: 0 });
    expect(events.slice(0, 2)).toEqual(["identity:1", "identity:2"]);
    expect(new Set(events.slice(2))).toEqual(new Set(["html:/pages-a", "html:/pages-b"]));
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
      expectedRscBuildId: "new-build",
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

  it("limits the propagation deadline to the RSC identity gate", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (new Headers(init?.headers).get("rsc") === "1") {
        now = 31_000;
        return new Response("new flight", {
          headers: {
            "cache-control": "public, max-age=0, must-revalidate",
            "cf-cache-status": "MISS",
            "content-type": "text/x-component",
            [VINEXT_RSC_BUILD_ID_HEADER]: "new-build",
            vary: VINEXT_RSC_VARY_HEADER,
          },
        });
      }
      return new Response("html", { status: 200 });
    });

    const result = await warmCdnCache({
      expectedRscBuildId: "new-build",
      fetchImpl: fetchMock as typeof fetch,
      paths: ["/cached/intro", "/cached/second"],
      propagatingTarget: true,
      retryDelayMs: 0,
      rscPaths: ["/cached/intro"],
      targetUrl: "https://app.example.com",
    });

    expect(result).toMatchObject({ total: 3, warmed: 3, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses ordinary retry policy after the identity gate succeeds", async () => {
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = toRequestUrl(input);
      if (new Headers(init?.headers).get("rsc") !== "1") {
        return new Response("html", { status: 200 });
      }
      return rscResponse(url.pathname === "/first" ? "new-build" : "old-build");
    });

    const result = await warmCdnCache({
      expectedRscBuildId: "new-build",
      fetchImpl: fetchMock as typeof fetch,
      paths: ["/first", "/second"],
      propagatingTarget: true,
      retryDelayMs: 0,
      rscPaths: ["/first", "/second"],
      targetUrl: "https://app.example.com",
    });

    expect(result).toMatchObject({ total: 4, warmed: 3, failed: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
