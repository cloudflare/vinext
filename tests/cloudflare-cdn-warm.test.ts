import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildWarmupUrl,
  DEFAULT_CDN_WARM_CONCURRENCY,
  DEFAULT_CDN_WARM_TIMEOUT_MS,
  readPrerenderWarmPlan,
  waitForCdnWarmTargetReadiness,
  warmCdnCache,
  warmCdnCacheFromPrerender,
} from "../packages/cloudflare/src/cdn-warm.js";
import {
  VINEXT_RSC_BUILD_ID_HEADER,
  VINEXT_RSC_VARY_HEADER,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import { VINEXT_CDN_BUILD_ID_HEADER } from "../packages/cloudflare/src/cache/cdn-build-id.js";
import { VINEXT_PRERENDER_READINESS_HEADER } from "../packages/vinext/src/server/headers.js";

let tmpDir: string;

function writeFile(relativePath: string, content: string): void {
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

function cacheableRsc(body = "flight"): Response {
  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=0, must-revalidate",
      "cdn-cache-control": "public, max-age=60",
      "cf-cache-status": "MISS",
      "content-type": "text/x-component",
      [VINEXT_CDN_BUILD_ID_HEADER]: "build-a",
      [VINEXT_RSC_BUILD_ID_HEADER]: "rsc-build-a",
      vary: VINEXT_RSC_VARY_HEADER,
    },
  });
}

function cacheableHtml(body = "html"): Response {
  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=0, must-revalidate",
      "cdn-cache-control": "public, max-age=60",
      "cf-cache-status": "MISS",
      "content-type": "text/html",
      [VINEXT_CDN_BUILD_ID_HEADER]: "build-a",
    },
  });
}

function cacheablePagesData(body = '{"pageProps":{}}'): Response {
  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=0, must-revalidate",
      "cdn-cache-control": "public, max-age=60",
      "cf-cache-status": "MISS",
      "content-type": "application/json; charset=utf-8",
      [VINEXT_CDN_BUILD_ID_HEADER]: "build-a",
    },
  });
}

function requestHref(input: RequestInfo | URL | undefined): string | undefined {
  if (input instanceof URL) return input.href;
  if (typeof input === "string") return input;
  return input?.url;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cdn-warm-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Cloudflare CDN warmup", () => {
  it("uses the documented warmup defaults and preserves query strings", () => {
    expect(DEFAULT_CDN_WARM_CONCURRENCY).toBe(25);
    expect(DEFAULT_CDN_WARM_TIMEOUT_MS).toBe(10_000);
    expect(buildWarmupUrl("https://app.example.com", "/search?q=x").href).toBe(
      "https://app.example.com/search?q=x",
    );
    expect(buildWarmupUrl("https://app.example.com", "/posts/%7Euser").pathname).toBe(
      "/posts/%7Euser",
    );
    expect(buildWarmupUrl("https://app.example.com", "/posts/a%2fb").pathname).toBe("/posts/a%2fb");
  });

  it("reads only build-discovered paths and does not require local prerender output", () => {
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        basePath: "/docs",
        buildId: "build-a",
        buildIdentity: "rsc-build-a",
        deploymentId: "dpl_123",
        fallbackRoutePatterns: [
          { kind: "app-page", pattern: "/posts/:slug" },
          { kind: "app-route", pattern: "/api/posts/:slug" },
          { kind: "pages-page", pattern: "/legacy/:slug" },
        ],
        loadingShellPaths: ["/dashboard"],
        pagesDataPaths: ["/docs/_next/data/build-a/pages.json"],
        paths: ["/dashboard", "/dynamic", "/pages"],
        responseVary: "verbatim",
        rscBuildId: "rsc-build-a",
        rscPaths: ["/dashboard", "/dynamic"],
        routeHandlerPaths: ["/api/data"],
        trailingSlash: true,
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({ buildId: "old", routes: [{ route: "/wrong", status: "rendered" }] }),
    );

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      buildId: "build-a",
      buildIdentity: "rsc-build-a",
      deploymentId: "dpl_123",
      fallbackRoutePatterns: [
        { kind: "app-page", pattern: "/posts/:slug" },
        { kind: "app-route", pattern: "/api/posts/:slug" },
        { kind: "pages-page", pattern: "/legacy/:slug" },
      ],
      loadingShellPaths: ["/docs/dashboard/"],
      pagesDataPaths: ["/docs/_next/data/build-a/pages.json"],
      paths: ["/docs/dashboard/", "/docs/dynamic/", "/docs/pages/"],
      rscBuildId: "rsc-build-a",
      rscPaths: ["/docs/dashboard/", "/docs/dynamic/"],
      routeHandlerPaths: ["/docs/api/data/"],
    });
  });

  it("disables RSC variants for adapters without strict response Vary", () => {
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        loadingShellPaths: ["/dashboard"],
        paths: ["/dashboard"],
        rscBuildId: "rsc-build-a",
        rscPaths: ["/dashboard"],
      }),
    );

    expect(readPrerenderWarmPlan(tmpDir)).toEqual({
      buildId: "build-a",
      loadingShellPaths: [],
      paths: ["/dashboard"],
      rscPaths: [],
    });
  });

  it("preserves opt-in prerender fallback-shell warming", () => {
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "build-a",
        excludedWarmPaths: ["/blog/[slug]"],
        paths: ["/", "/cached/intro"],
      }),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          { route: "/", status: "rendered", router: "app", fallback: false },
          {
            route: "/blog/:slug",
            path: "/blog/[slug]",
            status: "rendered",
            router: "app",
            fallback: true,
          },
        ],
      }),
    );

    expect(readPrerenderWarmPlan(tmpDir, { includeFallbackShells: true }).paths).toEqual(["/"]);
  });

  it("falls back to discovered paths when fallback shells were not locally rendered", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({ buildId: "build-a", paths: ["/", "/cached/intro"] }),
    );

    expect(readPrerenderWarmPlan(tmpDir, { includeFallbackShells: true }).paths).toEqual([
      "/",
      "/cached/intro",
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[vinext] CDN warmup fallback shells requested, but prerender manifest not found; warming build-discovered paths only.",
    );
  });

  it("rejects a stale discovery manifest in strict mode", () => {
    writeFile("dist/server/BUILD_ID", "build-b\n");
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({ buildId: "build-a", paths: ["/"] }),
    );

    expect(() => readPrerenderWarmPlan(tmpDir, { strict: true })).toThrow(
      "prerender path manifest buildId does not match",
    );
  });

  it("warms canonical RSC, HTML, and Pages data with browser-identical requests", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.get("rsc") === "1") return cacheableRsc();
      return headers.get("accept") === "application/json" ? cacheablePagesData() : cacheableHtml();
    });

    const result = await warmCdnCache({
      deploymentId: "dpl_123",
      expectedBuildId: "build-a",
      expectedRscBuildId: "rsc-build-a",
      fetchImpl: fetchImpl as typeof fetch,
      loadingShellPaths: ["/search?q=x"],
      pagesDataPaths: ["/_next/data/build-a/pages.json"],
      paths: ["/search?q=x"],
      rscPaths: ["/search?q=x"],
      targetUrl: "https://app.example.com",
    });

    expect(result).toEqual({
      total: 4,
      warmed: 4,
      skipped: 0,
      failed: 0,
      failures: [],
      skippedTargets: [],
      warmedPlan: {
        loadingShellPaths: ["/search?q=x"],
        pagesDataPaths: ["/_next/data/build-a/pages.json"],
        paths: ["/search?q=x"],
        rscPaths: ["/search?q=x"],
      },
      retryPlan: { loadingShellPaths: [], pagesDataPaths: [], paths: [], rscPaths: [] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const fullCall = fetchImpl.mock.calls.find((call) => {
      const headers = new Headers(call[1]?.headers);
      return headers.get("rsc") === "1" && !headers.has("next-router-prefetch");
    });
    const shellCall = fetchImpl.mock.calls.find((call) => {
      const headers = new Headers(call[1]?.headers);
      return headers.get("rsc") === "1" && headers.get("next-router-prefetch") === "1";
    });
    const htmlCall = fetchImpl.mock.calls.find(
      (call) => new Headers(call[1]?.headers).get("accept") === "text/html",
    );
    const pagesDataCall = fetchImpl.mock.calls.find(
      (call) => new Headers(call[1]?.headers).get("accept") === "application/json",
    );
    expect(requestHref(fullCall?.[0])).toBe("https://app.example.com/search?q=x&_rsc");
    expect(requestHref(shellCall?.[0])).toBe(
      "https://app.example.com/search?q=x&_rsc=9qLBDIU2NgN178cB",
    );
    expect(requestHref(htmlCall?.[0])).toBe("https://app.example.com/search?q=x");
    expect(requestHref(pagesDataCall?.[0])).toBe(
      "https://app.example.com/_next/data/build-a/pages.json",
    );

    const full = new Headers(fullCall?.[1]?.headers);
    expect(Object.fromEntries(full)).toMatchObject({
      accept: "text/x-component",
      rsc: "1",
      "x-deployment-id": "dpl_123",
    });
    expect(full.get("next-router-prefetch")).toBeNull();
    expect(full.get("next-router-state-tree")).toBeNull();
    expect(full.get("next-url")).toBeNull();

    const shell = new Headers(shellCall?.[1]?.headers);
    expect(shell.get("next-router-prefetch")).toBe("1");
    expect(shell.get("next-router-segment-prefetch")).toBe("1");
    expect(shell.get("x-vinext-rsc-render-mode")).toBe("prefetch-loading-shell");
    expect(shell.get("next-router-state-tree")).toBeNull();
    expect(shell.get("next-url")).toBeNull();

    const html = new Headers(htmlCall?.[1]?.headers);
    expect(html.get("accept")).toBe("text/html");
    expect(new Headers(pagesDataCall?.[1]?.headers).get("accept")).toBe("application/json");
    for (const call of fetchImpl.mock.calls) {
      expect(new Headers(call[1]?.headers).get("user-agent")).toBe("vinext-cloudflare-cdn-warm");
    }
  });

  it("warms Route Handlers with the canonical fetch request identity", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Accept")).toBe("*/*");
      return cacheablePagesData('{"ok":true}');
    });

    const result = await warmCdnCache({
      expectedBuildId: "build-a",
      fetchImpl: fetchImpl as typeof fetch,
      paths: [],
      routeHandlerPaths: ["/api/data"],
      targetUrl: "https://app.example.com",
    });

    expect(result.warmed).toBe(1);
    expect(result.warmedPlan.routeHandlerPaths).toEqual(["/api/data"]);
    expect(requestHref(fetchImpl.mock.calls[0]?.[0])).toBe("https://app.example.com/api/data");
  });

  it("reports planned and completed cache entries by route pattern", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const paths = ["/products/warmed", "/products/private", "/products/failed"];
    const routePatterns = Object.fromEntries(
      paths.map((pathname) => [
        pathname,
        {
          cacheabilityProbe: { canPrunePattern: true },
          kind: "app-page" as const,
          pattern: "/products/:slug",
        },
      ]),
    );
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(requestHref(input)!).pathname;
      if (pathname === "/products/private") {
        return new Response("private", {
          headers: {
            "cache-control": "no-store",
            "cf-cache-status": "BYPASS",
            "content-type": "text/html",
            [VINEXT_CDN_BUILD_ID_HEADER]: "build-a",
          },
        });
      }
      if (pathname === "/products/failed") {
        return new Response("failed", {
          status: 500,
          headers: {
            "content-type": "text/html",
            [VINEXT_CDN_BUILD_ID_HEADER]: "build-a",
          },
        });
      }
      return cacheableHtml();
    });

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths,
        retries: 0,
        routePatterns,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ failed: 1, skipped: 1, warmed: 1 });

    expect(log).toHaveBeenCalledWith("\n  Warming 3 CDN cache entries...");
    expect(log).toHaveBeenCalledWith("  CDN warmup plan by route:");
    expect(log).toHaveBeenCalledWith("    Route pattern    Kind      Paths  Entries");
    expect(log).toHaveBeenCalledWith("    /products/:slug  App page      3        3");
    expect(log).toHaveBeenCalledWith("  CDN warmup result by route:");
    expect(log).toHaveBeenCalledWith("    Route pattern    Kind      Warmed  Skipped  Failed");
    expect(log).toHaveBeenCalledWith("    /products/:slug  App page     1/3        1       1");
    expect(log).toHaveBeenCalledWith("  CDN warmup: 1 warmed, 1 skipped, 1 failed.");
  });

  it("caps route reports without listing concrete paths for large apps", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const paths: string[] = [];
    const routePatterns: Record<
      string,
      {
        cacheabilityProbe: { canPrunePattern: boolean };
        kind: "app-page";
        pattern: string;
      }
    > = {};
    for (let routeIndex = 0; routeIndex < 12; routeIndex++) {
      const pattern = `/catalog-${String(routeIndex).padStart(2, "0")}/:slug`;
      for (const slug of ["first", "second"]) {
        const pathname = pattern.replace(":slug", slug);
        paths.push(pathname);
        routePatterns[pathname] = {
          cacheabilityProbe: { canPrunePattern: true },
          kind: "app-page",
          pattern,
        };
      }
    }

    await warmCdnCache({
      expectedBuildId: "build-a",
      fetchImpl: (async () => cacheableHtml()) as typeof fetch,
      paths,
      retries: 0,
      routePatterns,
      targetUrl: "https://app.example.com",
    });

    const output = log.mock.calls.map(([message]) => String(message)).join("\n");
    expect(output).toMatch(/\/catalog-00\/:slug\s+App page\s+2\s+2/);
    expect(output).toMatch(/\/catalog-00\/:slug\s+App page\s+2\/2\s+0\s+0/);
    expect(output.match(/2 additional route patterns omitted \(4 cache entries\)/g)).toHaveLength(
      2,
    );
    expect(output).not.toContain("/catalog-00/first");
    expect(output).not.toContain("/catalog-11/:slug");
  });

  it("counts coherent no-store/BYPASS responses as skipped, including in strict mode", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const isRsc = new Headers(init?.headers).get("rsc") === "1";
      return new Response(isRsc ? "flight" : "html", {
        headers: {
          "cache-control": "no-store",
          "cf-cache-status": "BYPASS",
          ...(isRsc
            ? {
                "content-type": "text/x-component",
                [VINEXT_RSC_BUILD_ID_HEADER]: "rsc-build-a",
                vary: VINEXT_RSC_VARY_HEADER,
              }
            : { "content-type": "text/html" }),
        },
      });
    });

    const result = await warmCdnCache({
      expectedRscBuildId: "rsc-build-a",
      fetchImpl: fetchImpl as typeof fetch,
      paths: ["/dynamic"],
      rscPaths: ["/dynamic"],
      strict: true,
      targetUrl: "https://app.example.com",
    });
    expect(result).toMatchObject({
      total: 2,
      warmed: 0,
      skipped: 2,
      failed: 0,
      failures: [],
      warmedPlan: { loadingShellPaths: [], pagesDataPaths: [], paths: [], rscPaths: [] },
      retryPlan: { loadingShellPaths: [], pagesDataPaths: [], paths: [], rscPaths: [] },
    });
    expect(result.skippedTargets).toHaveLength(2);
  });

  it("rejects a Pages data response with a non-JSON representation", async () => {
    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        fetchImpl: (async () => cacheableHtml()) as typeof fetch,
        pagesDataPaths: ["/_next/data/build-a/about.json"],
        paths: [],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow("expected application/json response");
  });

  it("does not certify a staged cache fill until the entry is reusable", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      const response = cacheableHtml();
      response.headers.set("cf-cache-status", attempt === 1 ? "MISS" : "HIT");
      return response;
    });

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/staged"],
        propagatingTarget: true,
        requireCacheHit: true,
        retries: 1,
        retryDelayMs: 0,
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ warmed: 1, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects a cache fill that becomes private during certification", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("dynamic", {
          headers: {
            "cache-control": "no-store",
            "cf-cache-status": "BYPASS",
            "content-type": "text/html",
            [VINEXT_CDN_BUILD_ID_HEADER]: "build-a",
          },
        }),
    );

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/changed"],
        requireCacheHit: true,
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow("CF-Cache-Status is BYPASS; the cache fill is not reusable");
  });

  it("certifies from response headers without consuming the cached body", async () => {
    let cancelled = false;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              "cf-cache-status": "HIT",
              "content-type": "text/html",
              [VINEXT_CDN_BUILD_ID_HEADER]: "build-a",
            },
          },
        ),
    );

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/cached"],
        requireCacheHit: true,
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ warmed: 1, failed: 0 });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("uses Cloudflare cache-control precedence when validating admission", async () => {
    const fetchImpl = vi.fn(async () => {
      const response = cacheableRsc();
      response.headers.set("cache-control", "no-store");
      return response;
    });

    await expect(
      warmCdnCache({
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: [],
        rscPaths: ["/broken"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ warmed: 1, failed: 0 });
  });

  it("trusts Cloudflare admission when a stripped edge policy overrides downstream no-store", async () => {
    const fetchImpl = vi.fn(async () => {
      const response = cacheableRsc();
      response.headers.set("cdn-cache-control", "no-store");
      return response;
    });

    await expect(
      warmCdnCache({
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: [],
        rscPaths: ["/broken"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ warmed: 1, failed: 0 });
  });

  it("accepts admitted field-qualified cookie policies and stripped cached cookies", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const response =
        new Headers(init?.headers).get("rsc") === "1" ? cacheableRsc() : cacheableHtml();
      response.headers.set(
        "cdn-cache-control",
        'public, max-age=60, private="set-cookie", no-cache="set-cookie"',
      );
      response.headers.set("set-cookie", "session=first-response-only; Path=/");
      return response;
    });

    await expect(
      warmCdnCache({
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/cookie-policy"],
        rscPaths: ["/cookie-policy"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ warmed: 2, failed: 0 });
  });

  it("rejects plain Set-Cookie MISS responses without proof the cookie was stripped", async () => {
    const fetchImpl = vi.fn(async () => {
      const response = cacheableHtml();
      response.headers.set("set-cookie", "session=uncacheable; Path=/");
      return response;
    });

    await expect(
      warmCdnCache({
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/plain-cookie"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow("response sets a cookie without an observable field-qualified cache policy");
  });

  it("requires an exact set-cookie field name in field-qualified cache policy", async () => {
    const fetchImpl = vi.fn(async () => {
      const response = cacheableHtml();
      response.headers.set(
        "cdn-cache-control",
        'public, max-age=60, private="not-set-cookie, x-set-cookie"',
      );
      response.headers.set("set-cookie", "session=uncacheable; Path=/");
      return response;
    });

    await expect(
      warmCdnCache({
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/substring-cookie-policy"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow("response sets a cookie without an observable field-qualified cache policy");
  });

  it("skips hidden Cloudflare-specific cache opt-outs reported as BYPASS", async () => {
    const fetchImpl = vi.fn(async () => {
      const response = cacheableRsc();
      response.headers.set("cf-cache-status", "BYPASS");
      return response;
    });

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: [],
        rscPaths: ["/hidden-opt-out"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ warmed: 0, skipped: 1, failed: 0 });
  });

  it("rejects cache statuses that cannot prove a reusable fill", async () => {
    const staleFetch = vi.fn(async () => {
      const response = cacheableRsc();
      response.headers.set("cf-cache-status", "STALE");
      return response;
    });
    await expect(
      warmCdnCache({
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: staleFetch as typeof fetch,
        paths: [],
        rscPaths: ["/stale"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow("CF-Cache-Status is STALE");
  });

  it("rejects DYNAMIC when the route response itself is cacheable", async () => {
    const fetchImpl = vi.fn(async () => {
      const response = cacheableRsc();
      response.headers.set("cf-cache-status", "DYNAMIC");
      return response;
    });

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: [],
        rscPaths: ["/request-ineligible"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow("CF-Cache-Status is DYNAMIC");
  });

  it("skips DYNAMIC only when the route response opts out of caching", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("flight", {
          headers: {
            "cache-control": "no-store",
            "cf-cache-status": "DYNAMIC",
            "content-type": "text/x-component",
            [VINEXT_CDN_BUILD_ID_HEADER]: "build-a",
            [VINEXT_RSC_BUILD_ID_HEADER]: "rsc-build-a",
            vary: VINEXT_RSC_VARY_HEADER,
          },
        }),
    );

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: [],
        rscPaths: ["/response-ineligible"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ warmed: 0, skipped: 1, failed: 0 });
  });

  it("trusts admitted freshness when a higher-priority edge policy is hidden", async () => {
    const fetchImpl = vi.fn(async () => {
      const response = cacheableRsc();
      response.headers.set("cdn-cache-control", "public, max-age=0, stale-while-revalidate=60");
      return response;
    });
    await expect(
      warmCdnCache({
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: [],
        rscPaths: ["/immediately-stale"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ warmed: 1, failed: 0 });
  });

  it("skips non-cacheable responses for adapters without build identity", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const isRsc = new Headers(init?.headers).get("rsc") === "1";
      return new Response(isRsc ? "flight" : "html", {
        headers: {
          "cache-control": "no-store",
          "cf-cache-status": "BYPASS",
          "content-type": isRsc ? "text/x-component" : "text/html",
          ...(isRsc ? { [VINEXT_RSC_BUILD_ID_HEADER]: "rsc-build-a" } : {}),
        },
      });
    });

    await expect(
      warmCdnCache({
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/dynamic"],
        rscPaths: ["/dynamic"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ warmed: 0, skipped: 2, failed: 0 });
  });

  it("skips same-build non-success responses that explicitly opt out of caching", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const isRsc = new Headers(init?.headers).get("rsc") === "1";
      return new Response(isRsc ? "flight not found" : "redirect", {
        status: isRsc ? 404 : 307,
        headers: {
          "cache-control": "no-store",
          "cf-cache-status": "BYPASS",
          "content-type": isRsc ? "text/x-component" : "text/html",
          [VINEXT_CDN_BUILD_ID_HEADER]: "build-a",
          ...(isRsc ? { [VINEXT_RSC_BUILD_ID_HEADER]: "rsc-build-a" } : {}),
          ...(isRsc ? { vary: VINEXT_RSC_VARY_HEADER } : {}),
        },
      });
    });

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/redirect"],
        rscPaths: ["/not-found"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ warmed: 0, skipped: 2, failed: 0 });
  });

  it("warms same-build cacheable redirect and not-found responses", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const isRsc = new Headers(init?.headers).get("rsc") === "1";
      return new Response(isRsc ? "flight not found" : "redirect", {
        status: isRsc ? 404 : 307,
        headers: {
          "cache-control": "public, max-age=0, must-revalidate",
          "cdn-cache-control": "public, max-age=60",
          "cf-cache-status": "MISS",
          "content-type": isRsc ? "text/x-component" : "text/html",
          [VINEXT_CDN_BUILD_ID_HEADER]: "build-a",
          ...(isRsc ? { [VINEXT_RSC_BUILD_ID_HEADER]: "rsc-build-a" } : {}),
          ...(isRsc ? { vary: VINEXT_RSC_VARY_HEADER } : {}),
        },
      });
    });

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/redirect"],
        rscPaths: ["/not-found"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ warmed: 2, skipped: 0, failed: 0 });
  });

  it("accepts custom Vary fields on cacheable terminal responses", async () => {
    const fetchImpl = vi.fn(async () => {
      const response = cacheableRsc("flight not found");
      response.headers.set("vary", `${VINEXT_RSC_VARY_HEADER}, User-Agent`);
      return new Response(response.body, { headers: response.headers, status: 404 });
    });

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: [],
        rscPaths: ["/not-found"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ warmed: 1, skipped: 0, failed: 0 });
  });

  it("does not treat same-build server errors as terminal route responses", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("error", {
          status: 500,
          headers: {
            "cache-control": "no-store",
            "cf-cache-status": "BYPASS",
            [VINEXT_CDN_BUILD_ID_HEADER]: "build-a",
          },
        }),
    );

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/error"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow("HTTP 500");
  });

  it("accepts an exact-build terminal response as staged-version readiness", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("not found", {
          status: 404,
          headers: {
            [VINEXT_CDN_BUILD_ID_HEADER]: "build-a",
            [VINEXT_RSC_BUILD_ID_HEADER]: "rsc-build-a",
          },
        }),
    );

    await expect(
      waitForCdnWarmTargetReadiness({
        expectedBuildId: "build-a",
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        maxAttempts: 1,
        plan: { loadingShellPaths: [], pagesDataPaths: [], paths: [], rscPaths: ["/not-found"] },
        probeIntervalMs: 0,
        requiredConsecutiveSuccesses: 1,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toEqual({ ready: true });
  });

  it("uses the authenticated readiness endpoint instead of rendering an application route", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      expect(url.pathname).toBe("/__vinext/prerender/readiness");
      expect(url.searchParams.has("__vinext_cdn_warm_readiness")).toBe(true);
      expect(init?.method).toBe("POST");
      expect(headers.get("accept")).toBe("text/html");
      expect(headers.get("rsc")).toBeNull();
      expect(headers.get("x-vinext-prerender-secret")).toBe("build-secret");
      return new Response(null, {
        status: 204,
        headers: {
          "cache-control": "no-store",
          [VINEXT_CDN_BUILD_ID_HEADER]: "build-a",
          [VINEXT_PRERENDER_READINESS_HEADER]: "1",
        },
      });
    });

    await expect(
      waitForCdnWarmTargetReadiness({
        expectedBuildId: "build-a",
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        maxAttempts: 1,
        plan: { loadingShellPaths: [], pagesDataPaths: [], paths: [], rscPaths: ["/slow"] },
        prerenderSecret: "build-secret",
        probeIntervalMs: 0,
        requiredConsecutiveSuccesses: 1,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toEqual({ ready: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "an application response",
      response: new Response("fallback", {
        headers: { [VINEXT_CDN_BUILD_ID_HEADER]: "build-a" },
      }),
    },
    {
      label: "a same-build 404",
      response: new Response("not found", {
        status: 404,
        headers: { [VINEXT_CDN_BUILD_ID_HEADER]: "build-a" },
      }),
    },
    {
      label: "an unmarked 204",
      response: new Response(null, {
        status: 204,
        headers: {
          "cache-control": "no-store",
          [VINEXT_CDN_BUILD_ID_HEADER]: "build-a",
        },
      }),
    },
    {
      label: "a cacheable marked 204",
      response: new Response(null, {
        status: 204,
        headers: {
          [VINEXT_CDN_BUILD_ID_HEADER]: "build-a",
          [VINEXT_PRERENDER_READINESS_HEADER]: "1",
        },
      }),
    },
  ])("does not accept $label from the dedicated readiness path", async ({ response }) => {
    const readiness = await waitForCdnWarmTargetReadiness({
      expectedBuildId: "build-a",
      fetchImpl: vi.fn(async () => response.clone()) as typeof fetch,
      maxAttempts: 1,
      plan: { loadingShellPaths: [], pagesDataPaths: [], paths: ["/slow"], rscPaths: [] },
      prerenderSecret: "build-secret",
      probeIntervalMs: 0,
      requiredConsecutiveSuccesses: 1,
      targetUrl: "https://app.example.com",
    });

    expect(readiness.ready).toBe(false);
  });

  it("uses a Pages data identity when it is the only staged readiness target", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      return cacheablePagesData();
    });

    await expect(
      waitForCdnWarmTargetReadiness({
        expectedBuildId: "build-a",
        fetchImpl: fetchImpl as typeof fetch,
        maxAttempts: 1,
        plan: {
          loadingShellPaths: [],
          pagesDataPaths: ["/_next/data/build-a/about.json"],
          paths: [],
          rscPaths: [],
        },
        probeIntervalMs: 0,
        requiredConsecutiveSuccesses: 1,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toEqual({ ready: true });
  });

  it("rejects an exact-build server error as staged-version readiness", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("version validation failed", {
          status: 503,
          headers: {
            "cache-control": "no-store",
            [VINEXT_CDN_BUILD_ID_HEADER]: "build-a",
          },
        }),
    );

    await expect(
      waitForCdnWarmTargetReadiness({
        expectedBuildId: "build-a",
        fetchImpl: fetchImpl as typeof fetch,
        maxAttempts: 1,
        plan: { loadingShellPaths: [], pagesDataPaths: [], paths: ["/"], rscPaths: [] },
        probeIntervalMs: 0,
        requiredConsecutiveSuccesses: 1,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toEqual({
      error: "HTTP 503; uploaded build was not stable for 1 consecutive probe(s)",
      ready: false,
    });
  });

  it("bounds readiness retries by an independent phase deadline", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("version validation failed", {
          status: 503,
          headers: { [VINEXT_CDN_BUILD_ID_HEADER]: "old-build" },
        }),
    );

    const readiness = waitForCdnWarmTargetReadiness({
      expectedBuildId: "build-a",
      fetchImpl: fetchImpl as typeof fetch,
      maxAttempts: 100,
      phaseTimeoutMs: 25,
      plan: { loadingShellPaths: [], pagesDataPaths: [], paths: ["/"], rscPaths: [] },
      probeIntervalMs: 10,
      requiredConsecutiveSuccesses: 1,
      targetUrl: "https://app.example.com",
    });

    await expect(readiness).resolves.toEqual({
      error:
        "staged readiness exceeded its 25ms phase deadline; uploaded build was not stable for 1 consecutive probe(s)",
      ready: false,
    });
    // The exact count depends on response/cancellation overhead inside this
    // real wall-clock window. Prove that the phase retried but stopped on its
    // own deadline instead of exhausting the configured attempt ceiling.
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    expect(fetchImpl.mock.calls.length).toBeLessThan(100);
  });

  it("keeps failed readiness bounded by the default phase deadline", async () => {
    let now = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchImpl = vi.fn(async () => {
      now += 10_000;
      throw new DOMException("timed out", "AbortError");
    });

    try {
      const readiness = await waitForCdnWarmTargetReadiness({
        expectedBuildId: "build-a",
        fetchImpl: fetchImpl as typeof fetch,
        plan: { loadingShellPaths: [], pagesDataPaths: [], paths: ["/"], rscPaths: [] },
        probeIntervalMs: 0,
        requiredConsecutiveSuccesses: 6,
        retries: 60,
        targetUrl: "https://app.example.com",
        timeoutMs: 10_000,
      });

      expect(readiness.ready).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(12);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("does not skip a non-success response from a different build", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("redirect", {
          status: 307,
          headers: {
            "cache-control": "no-store",
            "cf-cache-status": "BYPASS",
            [VINEXT_CDN_BUILD_ID_HEADER]: "old-build",
          },
        }),
    );

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/redirect"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow(`response ${VINEXT_CDN_BUILD_ID_HEADER} does not match build build-a`);
  });

  it("requires CDN admission evidence for HTML responses", async () => {
    const fetchImpl = vi.fn(async () => new Response("html"));

    await expect(
      warmCdnCache({
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/about"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow("response is missing CF-Cache-Status");
  });

  it("accepts HTML responses with custom Vary fields", async () => {
    const fetchImpl = vi.fn(async () => {
      const response = cacheableHtml();
      response.headers.set("vary", `${VINEXT_RSC_VARY_HEADER}, User-Agent`);
      return response;
    });

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/browser-specific-html"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ warmed: 1, skipped: 0, failed: 0 });
  });

  it("accepts HTML varied only by framework RSC selector headers", async () => {
    const fetchImpl = vi.fn(async () => {
      const response = cacheableHtml();
      response.headers.set("vary", VINEXT_RSC_VARY_HEADER);
      return response;
    });

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/shared-html"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ warmed: 1, failed: 0 });
  });

  it("rejects responses rendered by a different application build", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const response =
        new Headers(init?.headers).get("rsc") === "1" ? cacheableRsc() : cacheableHtml();
      response.headers.set(VINEXT_CDN_BUILD_ID_HEADER, "old-build");
      return response;
    });

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/about"],
        propagatingTarget: true,
        retries: 0,
        rscPaths: ["/about"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow(`response ${VINEXT_CDN_BUILD_ID_HEADER} does not match build build-a`);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries old-build BYPASS responses before accepting a staged skip", async () => {
    const attempts = new Map<string, number>();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const isRsc = new Headers(init?.headers).get("rsc") === "1";
      const kind = isRsc ? "rsc" : "html";
      const attempt = (attempts.get(kind) ?? 0) + 1;
      attempts.set(kind, attempt);
      if (attempt === 1) {
        return new Response(isRsc ? "old-flight" : "old-html", {
          headers: {
            "cache-control": "no-store",
            "cf-cache-status": "BYPASS",
            "content-type": isRsc ? "text/x-component" : "text/html",
            [VINEXT_CDN_BUILD_ID_HEADER]: "old-build",
            ...(isRsc ? { [VINEXT_RSC_BUILD_ID_HEADER]: "old-rsc-build" } : {}),
          },
        });
      }
      return isRsc ? cacheableRsc() : cacheableHtml();
    });

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/became-cacheable"],
        propagatingTarget: true,
        retries: 1,
        retryDelayMs: 0,
        rscPaths: ["/became-cacheable"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ warmed: 2, skipped: 0, failed: 0 });
    expect(attempts).toEqual(
      new Map([
        ["rsc", 2],
        ["html", 2],
      ]),
    );
  });

  it("does not retry permanent validation failures from the uploaded build", async () => {
    const fetchImpl = vi.fn(async () => {
      const response = cacheableRsc();
      response.headers.set("vary", "User-Agent");
      return response;
    });

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: [],
        propagatingTarget: true,
        retries: 60,
        retryDelayMs: 0,
        rscPaths: ["/invalid-current-build"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow("response Vary is missing rsc");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a deterministic failure when either build identity matches", async () => {
    const fetchImpl = vi.fn(async () => {
      const response = cacheableRsc();
      response.headers.delete(VINEXT_CDN_BUILD_ID_HEADER);
      response.headers.set("vary", `${VINEXT_RSC_VARY_HEADER}, User-Agent`);
      return response;
    });

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: [],
        propagatingTarget: true,
        retries: 60,
        retryDelayMs: 0,
        rscPaths: ["/invalid-current-rsc-build"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow(`response ${VINEXT_CDN_BUILD_ID_HEADER} does not match build build-a`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries first and later staged-target failures only after the initial queue", async () => {
    const attempts = new Map<string, number>();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestHref(input)!);
      const isRsc = new Headers(init?.headers).get("rsc") === "1";
      const key = `${url.pathname}:${isRsc ? "rsc" : "html"}`;
      calls.push(key);
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      if ((url.pathname === "/first" || url.pathname === "/later") && attempt === 1) {
        if (!isRsc) return new Response("not propagated", { status: 500 });
        const stale = cacheableRsc();
        stale.headers.set(VINEXT_RSC_BUILD_ID_HEADER, "stale-rsc-build");
        return stale;
      }
      return isRsc ? cacheableRsc() : cacheableHtml();
    });

    await expect(
      warmCdnCache({
        concurrency: 1,
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/first", "/later", "/tail"],
        propagatingTarget: true,
        retries: 2,
        retryDelayMs: 0,
        rscPaths: ["/first", "/later", "/tail"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ total: 6, warmed: 6, failed: 0 });
    expect(attempts.get("/first:rsc")).toBe(2);
    expect(attempts.get("/first:html")).toBe(2);
    expect(attempts.get("/later:rsc")).toBe(2);
    expect(attempts.get("/later:html")).toBe(2);
    expect(attempts.get("/tail:rsc")).toBe(1);
    expect(attempts.get("/tail:html")).toBe(1);
    const lastInitialRequest = Math.max(calls.indexOf("/tail:rsc"), calls.indexOf("/tail:html"));
    expect(calls.lastIndexOf("/first:rsc")).toBeGreaterThan(lastInitialRequest);
    expect(calls.lastIndexOf("/first:html")).toBeGreaterThan(lastInitialRequest);
    expect(calls.lastIndexOf("/later:rsc")).toBeGreaterThan(lastInitialRequest);
    expect(calls.lastIndexOf("/later:html")).toBeGreaterThan(lastInitialRequest);
  });

  it("bounds queued targets and retry delays by one propagation phase deadline", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const attempts = new Map<string, number>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestHref(input)!);
      const isRsc = new Headers(init?.headers).get("rsc") === "1";
      const key = `${url.pathname}:${isRsc ? "rsc" : "html"}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);

      // Exhaust the shared phase before the retry or any queued request can run.
      if (key === "/first:rsc") {
        now = 31_000;
        return new Response("not propagated", { status: 404 });
      }
      return isRsc ? cacheableRsc() : cacheableHtml();
    });

    await expect(
      warmCdnCache({
        concurrency: 1,
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        phaseTimeoutMs: 30_000,
        paths: ["/first", "/later"],
        propagatingTarget: true,
        retries: 2,
        retryDelayMs: 1_000,
        rscPaths: ["/first", "/later"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow("CDN warmup exceeded its 30000ms phase deadline");
    expect(attempts).toEqual(new Map([["/first:rsc", 1]]));
  });

  it("uses the remaining phase budget as the fetch deadline", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );

    await expect(
      warmCdnCache({
        fetchImpl: fetchImpl as typeof fetch,
        phaseTimeoutMs: 5,
        paths: ["/stalled"],
        propagatingTarget: true,
        retries: 2,
        strict: true,
        targetUrl: "https://app.example.com",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("CDN warmup exceeded its 5ms phase deadline");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps the staged propagation budget independent for each failed key", async () => {
    const attempts = new Map<string, number>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(requestHref(input)!).pathname;
      const attempt = (attempts.get(pathname) ?? 0) + 1;
      attempts.set(pathname, attempt);
      if (pathname === "/slow" && attempt <= 30) {
        return new Response("not propagated", { status: 404 });
      }
      return cacheableRsc();
    });

    await expect(
      warmCdnCache({
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: [],
        propagatingTarget: true,
        retryDelayMs: 0,
        rscPaths: ["/ready", "/slow"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ total: 2, warmed: 2, failed: 0 });
    expect(attempts.get("/ready")).toBe(1);
    expect(attempts.get("/slow")).toBe(31);
  });

  it("reports targeted retries with their own progress total", async () => {
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const attempts = new Map<string, number>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(requestHref(input)!).pathname;
      const attempt = (attempts.get(pathname) ?? 0) + 1;
      attempts.set(pathname, attempt);
      if (pathname === "/stale" && attempt === 1) {
        const stale = cacheableRsc();
        stale.headers.set(VINEXT_CDN_BUILD_ID_HEADER, "old-build");
        stale.headers.set(VINEXT_RSC_BUILD_ID_HEADER, "old-rsc-build");
        return stale;
      }
      return cacheableRsc();
    });

    let progressWrites: string[];
    try {
      await expect(
        warmCdnCache({
          concurrency: 1,
          expectedBuildId: "build-a",
          expectedRscBuildId: "rsc-build-a",
          fetchImpl: fetchImpl as typeof fetch,
          paths: [],
          propagatingTarget: true,
          retries: 1,
          retryDelayMs: 0,
          rscPaths: ["/ready", "/stale"],
          strict: true,
          targetUrl: "https://app.example.com",
        }),
      ).resolves.toMatchObject({ total: 2, warmed: 2, failed: 0 });
      progressWrites = stderrWrite.mock.calls.map(([chunk]) => String(chunk));
    } finally {
      stderrWrite.mockRestore();
      if (originalIsTTY) Object.defineProperty(process.stderr, "isTTY", originalIsTTY);
      else delete (process.stderr as unknown as { isTTY?: boolean }).isTTY;
    }

    expect(progressWrites).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Warming CDN cache... [████████████████████] 2/2 /stale"),
        expect.stringContaining(
          "Retrying CDN cache... [                    ] 0/1 starting retry pass",
        ),
        expect.stringContaining("Retrying CDN cache... [████████████████████] 1/1 /stale"),
      ]),
    );
  });

  it("retries isolated stale-build responses after a large successful staged pass", async () => {
    const rscPaths = Array.from({ length: 4_528 }, (_, index) => `/archive/${index}`);
    const stalePaths = new Set(rscPaths.slice(-12));
    const requestHeaders = new Map<string, Headers[]>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestHref(input)!);
      expect(url.search).toBe("?_rsc");
      const pathname = url.pathname;
      const headers = new Headers(init?.headers);
      const headersForPath = requestHeaders.get(pathname) ?? [];
      headersForPath.push(headers);
      requestHeaders.set(pathname, headersForPath);

      if (stalePaths.has(pathname) && headersForPath.length === 1) {
        const stale = cacheableRsc("stale flight");
        stale.headers.set(VINEXT_CDN_BUILD_ID_HEADER, "old-build");
        stale.headers.set(VINEXT_RSC_BUILD_ID_HEADER, "old-rsc-build");
        return stale;
      }
      return cacheableRsc();
    });

    await expect(
      warmCdnCache({
        concurrency: 25,
        expectedBuildId: "build-a",
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: [],
        propagatingTarget: true,
        retries: 1,
        retryDelayMs: 0,
        rscPaths,
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ total: 4_528, warmed: 4_528, failed: 0 });

    expect(fetchImpl).toHaveBeenCalledTimes(4_540);
    for (const pathname of rscPaths.slice(0, -12)) {
      expect(requestHeaders.get(pathname)).toHaveLength(1);
    }
    for (const pathname of stalePaths) {
      const [initialHeaders, retryHeaders] = requestHeaders.get(pathname)!;
      expect(initialHeaders.get("cache-control")).toBeNull();
      expect(initialHeaders.get("pragma")).toBeNull();
      expect(retryHeaders.get("cache-control")).toBeNull();
      expect(retryHeaders.get("pragma")).toBeNull();
      expect(retryHeaders.get("accept")).toBe("text/x-component");
      expect(retryHeaders.get("rsc")).toBe("1");
      expect([...retryHeaders]).toEqual([...initialHeaders]);
    }
  });

  it("still fails strict warmup when a targeted retry returns the stale build", async () => {
    const seenHeaders: Headers[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders.push(new Headers(init?.headers));
      const stale = cacheableRsc("stale flight");
      stale.headers.set(VINEXT_CDN_BUILD_ID_HEADER, "old-build");
      stale.headers.set(VINEXT_RSC_BUILD_ID_HEADER, "old-rsc-build");
      return stale;
    });

    await expect(
      warmCdnCache({
        expectedBuildId: "build-a",
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: [],
        propagatingTarget: true,
        retries: 1,
        retryDelayMs: 0,
        rscPaths: ["/persistently-stale"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow(`response ${VINEXT_CDN_BUILD_ID_HEADER} does not match build build-a`);

    expect(seenHeaders).toHaveLength(2);
    expect(seenHeaders[0].get("cache-control")).toBeNull();
    expect(seenHeaders[1].get("cache-control")).toBeNull();
    expect(seenHeaders[1].get("pragma")).toBeNull();
  });

  it("warms directly from the discovery manifest", async () => {
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({ buildId: "build-a", paths: ["/about"] }),
    );
    const fetchImpl = vi.fn(async () => cacheableHtml());

    await expect(
      warmCdnCacheFromPrerender({
        fetchImpl: fetchImpl as typeof fetch,
        root: tmpDir,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ total: 1, warmed: 1, skipped: 0, failed: 0 });
  });

  it("requires an explicit opt-out for adapters without a build identity header", async () => {
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({ buildId: "build-a", paths: ["/custom-adapter"] }),
    );
    const fetchImpl = vi.fn(
      async () =>
        new Response("html", {
          headers: {
            "cache-control": "public, max-age=0, must-revalidate",
            "cdn-cache-control": "public, max-age=60",
            "cf-cache-status": "MISS",
            "content-type": "text/html",
          },
        }),
    );

    await expect(
      warmCdnCacheFromPrerender({
        fetchImpl: fetchImpl as typeof fetch,
        root: tmpDir,
        strict: true,
        targetUrl: "https://app.example.com",
        validateBuildIdentity: false,
      }),
    ).resolves.toMatchObject({ total: 1, warmed: 1, failed: 0 });
  });

  it("uses the discovery manifest build identity by default", async () => {
    writeFile("dist/server/BUILD_ID", "pinned-build\n");
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "pinned-build",
        buildIdentity: "instance-a",
        paths: ["/wrong-build"],
      }),
    );
    const fetchImpl = vi.fn(async () => {
      const response = cacheableHtml();
      response.headers.set(VINEXT_CDN_BUILD_ID_HEADER, "old-instance");
      return response;
    });

    await expect(
      warmCdnCacheFromPrerender({
        fetchImpl: fetchImpl as typeof fetch,
        root: tmpDir,
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow(`response ${VINEXT_CDN_BUILD_ID_HEADER} does not match build instance-a`);
  });

  it("uses the discovery manifest RSC build identity by default", async () => {
    writeFile("dist/server/BUILD_ID", "pinned-build\n");
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        buildId: "pinned-build",
        buildIdentity: "instance-a",
        paths: [],
        responseVary: "verbatim",
        rscBuildId: "instance-a",
        rscPaths: ["/wrong-rsc-build"],
      }),
    );
    const fetchImpl = vi.fn(async () => {
      const response = cacheableRsc();
      response.headers.set(VINEXT_RSC_BUILD_ID_HEADER, "old-instance");
      return response;
    });

    await expect(
      warmCdnCacheFromPrerender({
        fetchImpl: fetchImpl as typeof fetch,
        root: tmpDir,
        strict: true,
        targetUrl: "https://app.example.com",
        validateBuildIdentity: false,
      }),
    ).rejects.toThrow(`response ${VINEXT_RSC_BUILD_ID_HEADER} does not match build instance-a`);
  });
});
