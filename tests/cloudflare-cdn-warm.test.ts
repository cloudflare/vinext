import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildWarmupUrl,
  DEFAULT_CDN_WARM_CONCURRENCY,
  DEFAULT_CDN_WARM_TIMEOUT_MS,
  readPrerenderWarmPlan,
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
  });

  it("reads only build-discovered paths and does not require local prerender output", () => {
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({
        basePath: "/docs",
        buildId: "build-a",
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
      JSON.stringify({ buildId: "build-a", paths: ["/", "/cached/intro"] }),
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

    expect(readPrerenderWarmPlan(tmpDir, { includeFallbackShells: true }).paths).toEqual([
      "/",
      "/blog/[slug]",
    ]);
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
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile(
      "dist/server/vinext-prerender-paths.json",
      JSON.stringify({ buildId: "build-a", paths: ["/wrong-build"] }),
    );
    const fetchImpl = vi.fn(async () => {
      const response = cacheableHtml();
      response.headers.set(VINEXT_CDN_BUILD_ID_HEADER, "old-build");
      return response;
    });

    await expect(
      warmCdnCacheFromPrerender({
        fetchImpl: fetchImpl as typeof fetch,
        root: tmpDir,
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).rejects.toThrow(`response ${VINEXT_CDN_BUILD_ID_HEADER} does not match build build-a`);
  });
});
