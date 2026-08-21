import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildWarmupUrl,
  DEFAULT_CDN_WARM_TIMEOUT_MS,
  readPrerenderWarmPlan,
  warmCdnCache,
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

function cacheableRsc(body = "flight"): Response {
  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=0, must-revalidate",
      "cdn-cache-control": "public, max-age=60",
      "cf-cache-status": "MISS",
      "content-type": "text/x-component",
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
  it("uses a 5 second default timeout and preserves query strings", () => {
    expect(DEFAULT_CDN_WARM_TIMEOUT_MS).toBe(5_000);
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
      expectedRscBuildId: "rsc-build-a",
      fetchImpl: fetchImpl as typeof fetch,
      loadingShellPaths: ["/search?q=x"],
      paths: ["/search?q=x"],
      rscPaths: ["/search?q=x"],
      targetUrl: "https://app.example.com",
    });

    expect(result).toEqual({ total: 3, warmed: 3, skipped: 0, failed: 0, failures: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(requestHref(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://app.example.com/search?q=x&_rsc",
    );
    expect(requestHref(fetchImpl.mock.calls[1]?.[0])).toBe(
      "https://app.example.com/search?q=x&_rsc",
    );
    expect(requestHref(fetchImpl.mock.calls[2]?.[0])).toBe("https://app.example.com/search?q=x");

    const full = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(Object.fromEntries(full)).toMatchObject({
      accept: "text/x-component",
      rsc: "1",
      "x-deployment-id": "dpl_123",
    });
    expect(full.get("next-router-prefetch")).toBeNull();
    expect(full.get("next-router-state-tree")).toBeNull();
    expect(full.get("next-url")).toBeNull();

    const shell = new Headers(fetchImpl.mock.calls[1]?.[1]?.headers);
    expect(shell.get("next-router-prefetch")).toBe("1");
    expect(shell.get("next-router-segment-prefetch")).toBe("1");
    expect(shell.get("x-vinext-rsc-render-mode")).toBe("prefetch-loading-shell");
    expect(shell.get("next-router-state-tree")).toBeNull();
    expect(shell.get("next-url")).toBeNull();

    const html = new Headers(fetchImpl.mock.calls[2]?.[1]?.headers);
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
    ).resolves.toEqual({ total: 2, warmed: 0, skipped: 2, failed: 0, failures: [] });
  });

  it("fails contradictory cache policy instead of claiming a warm", async () => {
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
    ).rejects.toThrow("opts out of caching, but CF-Cache-Status is MISS");
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

  it("retries every staged-target request until its cache key reaches the uploaded build", async () => {
    const attempts = new Map<string, number>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestHref(input)!);
      const isRsc = new Headers(init?.headers).get("rsc") === "1";
      const key = `${url.pathname}:${isRsc ? "rsc" : "html"}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      if (url.pathname === "/later" && attempt === 1) {
        return new Response("not propagated", { status: isRsc ? 404 : 500 });
      }
      return isRsc ? cacheableRsc() : cacheableHtml();
    });

    await expect(
      warmCdnCache({
        expectedRscBuildId: "rsc-build-a",
        fetchImpl: fetchImpl as typeof fetch,
        paths: ["/first", "/later"],
        propagatingTarget: true,
        retries: 2,
        retryDelayMs: 0,
        rscPaths: ["/first", "/later"],
        strict: true,
        targetUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ total: 4, warmed: 4, failed: 0 });
    expect(attempts.get("/later:rsc")).toBe(2);
    expect(attempts.get("/later:html")).toBe(2);
  });

  it("starts propagation deadlines when queued requests actually begin", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const attempts = new Map<string, number>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestHref(input)!);
      const isRsc = new Headers(init?.headers).get("rsc") === "1";
      const key = `${url.pathname}:${isRsc ? "rsc" : "html"}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);

      // Move beyond the first request's 30-second propagation deadline before
      // the concurrency-1 worker can dequeue any of the remaining requests.
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
});
