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
        loadingShellPaths: ["/dashboard"],
        paths: ["/dashboard", "/dynamic", "/pages"],
        responseVary: "verbatim",
        rscBuildId: "rsc-build-a",
        rscPaths: ["/dashboard", "/dynamic"],
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
      loadingShellPaths: ["/docs/dashboard/"],
      paths: ["/docs/dashboard/", "/docs/dynamic/", "/docs/pages/"],
      rscBuildId: "rsc-build-a",
      rscPaths: ["/docs/dashboard/", "/docs/dynamic/"],
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

  it("warms canonical full RSC, loading shell, and HTML with browser-identical requests", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      return headers.get("rsc") === "1" ? cacheableRsc() : cacheableHtml();
    });

    const result = await warmCdnCache({
      deploymentId: "dpl_123",
      expectedBuildId: "build-a",
      expectedRscBuildId: "rsc-build-a",
      fetchImpl: fetchImpl as typeof fetch,
      loadingShellPaths: ["/search?q=x"],
      paths: ["/search?q=x"],
      rscPaths: ["/search?q=x"],
      targetUrl: "https://app.example.com",
    });

    expect(result).toEqual({
      total: 3,
      warmed: 3,
      skipped: 0,
      failed: 0,
      failures: [],
      retryPlan: { loadingShellPaths: [], paths: [], rscPaths: [] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const fullCall = fetchImpl.mock.calls.find((call) => {
      const headers = new Headers(call[1]?.headers);
      return headers.get("rsc") === "1" && !headers.has("next-router-prefetch");
    });
    const shellCall = fetchImpl.mock.calls.find((call) => {
      const headers = new Headers(call[1]?.headers);
      return headers.get("rsc") === "1" && headers.get("next-router-prefetch") === "1";
    });
    const htmlCall = fetchImpl.mock.calls.find(
      (call) => new Headers(call[1]?.headers).get("rsc") !== "1",
    );
    expect(requestHref(fullCall?.[0])).toBe("https://app.example.com/search?q=x&_rsc");
    expect(requestHref(shellCall?.[0])).toBe(
      "https://app.example.com/search?q=x&_rsc=9qLBDIU2NgN178cB",
    );
    expect(requestHref(htmlCall?.[0])).toBe("https://app.example.com/search?q=x");

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
    for (const call of fetchImpl.mock.calls) {
      expect(new Headers(call[1]?.headers).get("user-agent")).toBe("vinext-cloudflare-cdn-warm");
    }
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

    await expect(
      warmCdnCache({
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/dynamic"],
        rscPaths: ["/dynamic"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toEqual({
      total: 2,
      warmed: 0,
      skipped: 2,
      failed: 0,
      failures: [],
      retryPlan: { loadingShellPaths: [], paths: [], rscPaths: [] },
    });
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

  it("requires browser-reusable variance for cacheable terminal responses", async () => {
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
    ).rejects.toThrow("response Vary has unsupported field user-agent");
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
        plan: { loadingShellPaths: [], paths: [], rscPaths: ["/not-found"] },
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
        plan: { loadingShellPaths: [], paths: ["/"], rscPaths: [] },
        probeIntervalMs: 0,
        requiredConsecutiveSuccesses: 1,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toEqual({
      error: "HTTP 503; uploaded build was not stable for 1 consecutive probe(s)",
      ready: false,
    });
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

  it("rejects HTML variants that the warmer request cannot share with browsers", async () => {
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
    ).rejects.toThrow("response Vary has unsupported field user-agent");
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
        rscPaths: ["/invalid-current-build"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow("response Vary has unsupported field user-agent");
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

  it("does not expire propagation retries while requests wait in the queue", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const attempts = new Map<string, number>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestHref(input)!);
      const isRsc = new Headers(init?.headers).get("rsc") === "1";
      const key = `${url.pathname}:${isRsc ? "rsc" : "html"}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);

      // Move beyond the former 30-second wall-clock deadline before the
      // concurrency-1 worker can dequeue any of the remaining requests.
      if (key === "/first:rsc") {
        now = 31_000;
      } else if (url.pathname === "/later" && attempt === 1) {
        return new Response("not propagated", { status: isRsc ? 404 : 500 });
      }
      return isRsc ? cacheableRsc() : cacheableHtml();
    });

    await expect(
      warmCdnCache({
        concurrency: 1,
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/first", "/later"],
        propagatingTarget: true,
        retryDelayMs: 0,
        rscPaths: ["/first", "/later"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ total: 4, warmed: 4, failed: 0 });
    expect(attempts.get("/later:rsc")).toBe(2);
    expect(attempts.get("/later:html")).toBe(2);
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
