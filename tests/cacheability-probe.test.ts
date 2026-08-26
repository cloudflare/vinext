import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CloudflareCdnCacheAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.runtime.js";
import { probeStagedWorkerCacheability } from "../packages/cloudflare/src/cacheability-probe.js";
import { withEmbeddedCacheabilityManifest } from "../packages/cloudflare/src/cacheability-artifact.js";
import {
  CACHEABILITY_MANIFEST_PLACEHOLDER,
  cacheabilityManifestHasGeneratedPath,
  cacheabilityRouteKey,
  parseCacheabilityManifest,
  resetEmbeddedCacheabilityManifestForTests,
} from "../packages/vinext/src/server/cacheability-manifest.js";
import {
  beginRouteCacheability,
  CACHEABILITY_RESPONSE_BODY_LIMIT,
  CACHEABILITY_RESPONSE_CAPTURE_BUDGET,
  CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY,
  CACHEABILITY_RESPONSE_CAPTURE_MAX_IN_FLIGHT,
  CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS,
  captureResponseBodyBounded,
  createWorkerCacheabilityContext,
  deferRouteCacheability,
  finalizeWorkerCacheabilityResponse,
  markRequestCacheabilityUnsafe,
  markRouteCacheabilityPolicyProvisional,
  recordRouteCacheabilityCapturedBody,
  recordRouteCacheabilityClassificationFailure,
  recordRouteCacheability,
  type CapturedResponseBody,
} from "../packages/vinext/src/server/cacheability-request.js";
import { applyCdnResponseHeaders } from "../packages/vinext/src/server/cache-control.js";
import { finalizeAppPageHtmlCacheResponse } from "../packages/vinext/src/server/app-page-cache-finalizer.js";
import { executeAppRouteHandler } from "../packages/vinext/src/server/app-route-handler-execution.js";
import { applyConfigHeadersToResponse } from "../packages/vinext/src/server/config-headers.js";
import { configRoutesCanVaryResponse } from "../packages/vinext/src/server/config-cache-safety.js";
import { executeMiddleware } from "../packages/vinext/src/server/middleware-runtime.js";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";
import {
  DefaultCdnCacheAdapter,
  setCdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";
import {
  MemoryCacheHandler,
  setDataCacheHandler,
} from "../packages/vinext/src/shims/cache-handler.js";
import { revalidateTag } from "../packages/vinext/src/shims/cache.js";

const manifestGlobal = "__VINEXT_CACHEABILITY_MANIFEST__";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete globalThis.__VINEXT_onRequestErrorHandler__;
  resetEmbeddedCacheabilityManifestForTests();
  setCdnCacheAdapter(new DefaultCdnCacheAdapter());
  setDataCacheHandler(new MemoryCacheHandler());
});

function createContext() {
  return { hostRuntime: "worker" as const, waitUntil: vi.fn() };
}

function installManifest(
  state: "static-candidate" | "dynamic" | "runtime-check" = "static-candidate",
): void {
  vi.stubGlobal(
    manifestGlobal,
    JSON.stringify({
      routes: {
        "app-page:/products/:id": {
          kind: "app-page",
          pattern: "/products/:id",
          state,
        },
      },
      version: 1,
    }),
  );
  resetEmbeddedCacheabilityManifestForTests();
}

function installExactPathManifest(): void {
  vi.stubGlobal(
    manifestGlobal,
    JSON.stringify({
      routes: {
        "app-page:/products/:id": {
          kind: "app-page",
          pattern: "/products/:id",
          state: "runtime-check",
        },
        [cacheabilityRouteKey("app-page", "/products/:id", "/products/static")]: {
          kind: "app-page",
          path: "/products/static",
          pattern: "/products/:id",
          state: "static-candidate",
        },
        [cacheabilityRouteKey("app-page", "/products/:id", "/products/dynamic")]: {
          kind: "app-page",
          path: "/products/dynamic",
          pattern: "/products/:id",
          state: "dynamic",
        },
      },
      version: 1,
    }),
  );
  resetEmbeddedCacheabilityManifestForTests();
}

describe("cacheability manifests", () => {
  it.each(["1", "identity"])(
    "keeps %s staged observations side-effect free before route selection",
    async (mode) => {
      const revalidate = vi.fn(async () => {});
      setDataCacheHandler({
        async get() {
          return null;
        },
        async set() {},
        revalidateTag: revalidate,
      });
      const request = new Request("https://example.com/middleware", {
        headers: {
          "X-Vinext-Cacheability-Probe": mode,
          "X-Vinext-Prerender-Secret": "secret-a",
        },
      });
      const ctx = createWorkerCacheabilityContext(createContext(), request, "secret-a");

      await runWithExecutionContext(ctx, async () => {
        revalidateTag("middleware-tag");
        await Promise.resolve();
      });

      expect(revalidate).not.toHaveBeenCalled();
    },
  );

  it("treats request-varying config sources as unsafe independently of their conditions", () => {
    const base = {
      basePathState: { basePath: "", hadBasePath: true },
      pathname: "/account",
      redirects: [],
      rewrites: { afterFiles: [], beforeFiles: [], fallback: [] },
    };
    expect(
      configRoutesCanVaryResponse({
        ...base,
        headers: [
          {
            source: "/account",
            has: [{ type: "cookie", key: "session" }],
            headers: [{ key: "Cache-Control", value: "no-store" }],
          },
        ],
      }),
    ).toBe(true);
    expect(
      configRoutesCanVaryResponse({
        ...base,
        headers: [
          {
            source: "/account",
            headers: [{ key: "X-Static", value: "same-for-every-request" }],
          },
        ],
      }),
    ).toBe(false);
    expect(
      configRoutesCanVaryResponse({
        ...base,
        headers: [],
        rewrites: {
          afterFiles: [],
          beforeFiles: [{ source: "/account", destination: "https://origin.example/account" }],
          fallback: [],
        },
      }),
    ).toBe(true);
    expect(
      configRoutesCanVaryResponse({
        ...base,
        headers: [],
        rewrites: {
          afterFiles: [],
          beforeFiles: [{ source: "/account", destination: "/static-account" }],
          fallback: [],
        },
      }),
    ).toBe(false);
    expect(
      configRoutesCanVaryResponse({
        ...base,
        headers: [],
        rewrites: {
          afterFiles: [],
          beforeFiles: [
            {
              source: "/account",
              destination: "/members",
              has: [{ type: "cookie", key: "session" }],
            },
          ],
          fallback: [],
        },
      }),
    ).toBe(true);
  });

  it("rejects malformed and key-inconsistent route entries", () => {
    expect(parseCacheabilityManifest("not-json")).toBeNull();
    expect(
      parseCacheabilityManifest(
        JSON.stringify({
          routes: {
            "app-page:/wrong": {
              kind: "app-page",
              pattern: "/actual",
              state: "static-candidate",
            },
          },
          version: 1,
        }),
      ),
    ).toBeNull();
  });

  it("classifies each generated path independently and runtime-checks unprobed paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-probe-"));
    fs.mkdirSync(path.join(root, "dist/server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist/server/vinext-server.json"),
      JSON.stringify({ prerenderSecret: "secret-a" }),
    );
    const requests: Array<{ headers: Headers; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url =
          input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
        requests.push({ headers: new Headers(init?.headers), url });
        return Response.json({
          kind: "app-page",
          pattern: "/products/:id",
          state: url.endsWith("/products/static") ? "static-candidate" : "dynamic",
          status: 200,
          version: 1,
        });
      }),
    );

    const result = await probeStagedWorkerCacheability({
      concurrency: 1,
      headers: { "Cloudflare-Workers-Version-Overrides": 'shop="version-a"' },
      root,
      routes: [
        {
          kind: "app-page",
          path: "/products/static",
          pattern: "/products/:id",
          probePath: "/products/static",
        },
        {
          kind: "app-page",
          path: "/products/dynamic",
          pattern: "/products/:id",
          probePath: "/products/dynamic",
        },
        { kind: "pages-page", pattern: "/account" },
      ],
      targetUrl: "https://shop.example.com",
    });

    expect(result.failures).toEqual([]);
    expect(result.probed).toBe(2);
    expect(result.manifest.routes).toEqual({
      "app-page:/products/:id": {
        kind: "app-page",
        pattern: "/products/:id",
        state: "runtime-check",
      },
      [cacheabilityRouteKey("app-page", "/products/:id", "/products/static")]: {
        generatedPath: true,
        kind: "app-page",
        path: "/products/static",
        pattern: "/products/:id",
        state: "static-candidate",
      },
      [cacheabilityRouteKey("app-page", "/products/:id", "/products/dynamic")]: {
        generatedPath: true,
        kind: "app-page",
        path: "/products/dynamic",
        pattern: "/products/:id",
        state: "dynamic",
      },
      "pages-page:/account": {
        kind: "pages-page",
        pattern: "/account",
        state: "runtime-check",
      },
    });
    expect(requests[0].url).toBe("https://shop.example.com/products/static");
    expect(requests[0].headers.get("X-Vinext-Cacheability-Probe")).toBe("1");
    expect(requests[0].headers.get("X-Vinext-Prerender-Secret")).toBe("secret-a");
    expect(requests[1].url).toBe("https://shop.example.com/products/dynamic");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("certifies deterministic rewrites under their resolved route identity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-rewrite-"));
    fs.mkdirSync(path.join(root, "dist/server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist/server/vinext-server.json"),
      JSON.stringify({ prerenderSecret: "secret-a" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          kind: "app-route",
          pattern: "/api/target",
          state: "static-candidate",
          status: 200,
          version: 1,
        }),
      ),
    );

    const relatedPaths = Array.from({ length: 10_000 }, (_, index) => `/api/source-${index}`);
    const result = await probeStagedWorkerCacheability({
      root,
      routes: [
        {
          kind: "app-route",
          path: "/api/source",
          pattern: "/api/source",
          probePath: "/api/source",
          probeGroupPaths: relatedPaths,
        },
      ],
      targetUrl: "https://shop.example.com",
    });

    expect(result.failures).toEqual([]);
    expect(result.manifest.routes["app-route:/api/source"].state).toBe("static-candidate");
    expect(
      result.manifest.routes[cacheabilityRouteKey("app-route", "/api/target", "/api/source")],
    ).toEqual({
      generatedPath: true,
      kind: "app-route",
      path: "/api/source",
      pattern: "/api/target",
      state: "static-candidate",
    });
    expect(
      cacheabilityManifestHasGeneratedPath(
        result.manifest.routes["app-route:/api/target"].generatedPaths,
        "/api/source-9999",
      ),
    ).toBe(true);
    expect(result.resolutions).toHaveLength(1);
    expect(result.resolutions[0]).toMatchObject({
      exactPath: "/api/source",
      kind: "app-route",
      pattern: "/api/target",
      sourceKind: "app-route",
      sourcePattern: "/api/source",
      state: "static-candidate",
    });
    expect(result.resolutions[0].relatedPaths).toHaveLength(10_000);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps probe renders and the embedded manifest bounded by route patterns", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-sparse-probe-"));
    fs.mkdirSync(path.join(root, "dist/server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist/server/vinext-server.json"),
      JSON.stringify({ prerenderSecret: "secret-a" }),
    );
    const fetchMock = vi.fn(async () =>
      Response.json({
        kind: "app-page",
        pattern: "/catalog/:slug",
        state: "static-candidate",
        status: 200,
        version: 1,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const generatedPaths = Array.from({ length: 1_000 }, (_, index) => `/catalog/item-${index}`);
    const result = await probeStagedWorkerCacheability({
      root,
      routes: [
        {
          kind: "app-page",
          path: generatedPaths[0],
          pattern: "/catalog/:slug",
          probePath: generatedPaths[0],
          runtimeCheckWarmPaths: generatedPaths.slice(1),
          warmPaths: [generatedPaths[0]],
        },
      ],
      targetUrl: "https://shop.example.com",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.probed).toBe(1);
    expect(Object.keys(result.manifest.routes)).toHaveLength(2);
    expect(
      cacheabilityManifestHasGeneratedPath(
        result.manifest.routes["app-page:/catalog/:slug"].generatedPaths,
        generatedPaths.at(-1)!,
      ),
    ).toBe(true);
    expect(JSON.stringify(result.manifest).length).toBeLessThan(25_000);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps ungenerated Cache Components Route Handler paths eligible for runtime ISR", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-route-paths-"));
    fs.mkdirSync(path.join(root, "dist/server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist/server/vinext-server.json"),
      JSON.stringify({ prerenderSecret: "secret-a" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          kind: "app-route",
          pattern: "/api/products/:id",
          state: "static-candidate",
          status: 200,
          version: 1,
        }),
      ),
    );

    const result = await probeStagedWorkerCacheability({
      root,
      routes: [
        {
          kind: "app-route",
          path: "/api/products/a",
          pattern: "/api/products/:id",
          probePath: "/api/products/a",
          runtimeCheckWarmPaths: ["/api/products/b"],
          warmPaths: ["/api/products/a"],
        },
      ],
      targetUrl: "https://shop.example.com",
    });

    expect(result.probed).toBe(1);
    expect(result.manifest.routes["app-route:/api/products/:id"]).toMatchObject({
      kind: "app-route",
      pattern: "/api/products/:id",
      state: "runtime-check",
    });
    expect(
      cacheabilityManifestHasGeneratedPath(
        result.manifest.routes["app-route:/api/products/:id"].generatedPaths,
        "/api/products/b",
      ),
    ).toBe(true);

    vi.stubGlobal(manifestGlobal, JSON.stringify(result.manifest));
    resetEmbeddedCacheabilityManifestForTests();
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());

    const knownContext = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://shop.example.com/api/products/b"),
      "secret-a",
    );
    await runWithExecutionContext(knownContext, async () => {
      expect(beginRouteCacheability("app-route", "/api/products/:id")).toBe(true);
    });

    const unknownContext = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://shop.example.com/api/products/unknown"),
      "secret-a",
    );
    await runWithExecutionContext(unknownContext, async () => {
      expect(beginRouteCacheability("app-route", "/api/products/:id")).toBe(true);
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stores generated Route Handler membership without repeating route metadata", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-route-scale-"));
    fs.mkdirSync(path.join(root, "dist/server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist/server/vinext-server.json"),
      JSON.stringify({ prerenderSecret: "secret-a" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          kind: "app-route",
          pattern: "/api/products/:id",
          state: "static-candidate",
          status: 200,
          version: 1,
        }),
      ),
    );
    const generatedPaths = Array.from(
      { length: 100_000 },
      (_, index) => `/api/products/item-${index}`,
    );

    const result = await probeStagedWorkerCacheability({
      root,
      routes: [
        {
          kind: "app-route",
          path: generatedPaths[0],
          pattern: "/api/products/:id",
          probePath: generatedPaths[0],
          runtimeCheckWarmPaths: generatedPaths.slice(1),
          warmPaths: [generatedPaths[0]],
        },
      ],
      targetUrl: "https://shop.example.com",
    });

    expect(Object.keys(result.manifest.routes)).toHaveLength(2);
    const compactPaths = result.manifest.routes["app-route:/api/products/:id"].generatedPaths;
    expect(cacheabilityManifestHasGeneratedPath(compactPaths, "/api/products/item-99999")).toBe(
      true,
    );
    expect(cacheabilityManifestHasGeneratedPath(compactPaths, "/api/products/not-generated")).toBe(
      false,
    );
    expect(JSON.stringify(result.manifest).length).toBeLessThan(900_000);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stores one manifest entry rather than an exact duplicate for each fixed route", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-fixed-probes-"));
    fs.mkdirSync(path.join(root, "dist/server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist/server/vinext-server.json"),
      JSON.stringify({ prerenderSecret: "secret-a" }),
    );
    const fixedRoutes = Array.from({ length: 200 }, (_, index) => `/fixed-${index}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const pathname = new URL(
          input instanceof URL ? input : typeof input === "string" ? input : input.url,
        ).pathname;
        return Response.json({
          kind: "app-page",
          pattern: pathname,
          state: "static-candidate",
          status: 200,
          version: 1,
        });
      }),
    );

    const result = await probeStagedWorkerCacheability({
      root,
      routes: fixedRoutes.map((pattern) => ({
        kind: "app-page" as const,
        path: pattern,
        pattern,
        probePath: pattern,
      })),
      targetUrl: "https://shop.example.com",
    });

    expect(result.failures).toEqual([]);
    expect(result.probed).toBe(fixedRoutes.length);
    expect(Object.keys(result.manifest.routes)).toHaveLength(fixedRoutes.length);
    expect(result.manifest.routes["app-page:/fixed-199"]).toEqual({
      kind: "app-page",
      pattern: "/fixed-199",
      state: "static-candidate",
    });
    expect(JSON.stringify(result.manifest)).not.toContain('["app-page","/fixed-199"');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("bounds full probe concurrency to the Worker capture-reader limit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-concurrency-"));
    fs.mkdirSync(path.join(root, "dist/server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist/server/vinext-server.json"),
      JSON.stringify({ prerenderSecret: "secret-a" }),
    );
    let active = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        const pathname = new URL(
          input instanceof URL ? input : typeof input === "string" ? input : input.url,
        ).pathname;
        return Response.json({
          kind: "app-page",
          pattern: pathname,
          state: "static-candidate",
          status: 200,
          version: 1,
        });
      }),
    );
    const patterns = Array.from({ length: 50 }, (_, index) => `/fixed-${index}`);

    const result = await probeStagedWorkerCacheability({
      concurrency: 100,
      root,
      routes: patterns.map((pattern) => ({
        kind: "app-page" as const,
        path: pattern,
        pattern,
        probePath: pattern,
      })),
      targetUrl: "https://shop.example.com",
    });

    expect(result.failures).toEqual([]);
    expect(result.probed).toBe(patterns.length);
    expect(peak).toBe(CACHEABILITY_RESPONSE_CAPTURE_MAX_IN_FLIGHT);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("retries transient staged-version routing responses", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-retry-"));
    fs.mkdirSync(path.join(root, "dist/server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist/server/vinext-server.json"),
      JSON.stringify({ prerenderSecret: "secret-a" }),
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not propagated", { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          kind: "app-page",
          pattern: "/products/:id",
          state: "static-candidate",
          status: 200,
          version: 1,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeStagedWorkerCacheability({
      retries: 1,
      retryDelayMs: 0,
      root,
      routes: [
        {
          kind: "app-page",
          path: "/products/known",
          pattern: "/products/:id",
          probePath: "/products/known",
        },
      ],
      targetUrl: "https://shop.example.com",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.failures).toEqual([]);
    expect(
      result.manifest.routes[cacheabilityRouteKey("app-page", "/products/:id", "/products/known")]
        .state,
    ).toBe("static-candidate");
    expect(result.manifest.routes["app-page:/products/:id"].state).toBe("runtime-check");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("embeds a manifest into an isolated server artifact tree for one upload", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-artifact-"));
    const firstPath = path.join(root, "dist/server/entry.js");
    const secondPath = path.join(root, "dist/server/chunks/router.js");
    fs.mkdirSync(path.dirname(secondPath), { recursive: true });
    const source = `export const value = \`${CACHEABILITY_MANIFEST_PLACEHOLDER}\`;`;
    fs.writeFileSync(firstPath, source);
    fs.writeFileSync(secondPath, source);
    fs.writeFileSync(path.join(root, "dist/server/wrangler.json"), "{}");
    let isolatedConfigPath = "";

    expect(
      withEmbeddedCacheabilityManifest(
        root,
        undefined,
        {
          routes: {
            "app-page:/products/:id": {
              kind: "app-page",
              pattern: "/products/:id",
              state: "static-candidate",
            },
          },
          version: 1,
        },
        (configPath) => {
          isolatedConfigPath = path.join(root, configPath);
          const isolatedDirectory = path.dirname(isolatedConfigPath);
          const embedded = fs.readFileSync(path.join(isolatedDirectory, "entry.js"), "utf-8");
          const manifestModule = fs.readFileSync(
            path.join(isolatedDirectory, "__vinext_cacheability_manifest.js"),
            "utf-8",
          );
          expect(embedded).toContain("__vinext_cacheability_manifest.js");
          expect(manifestModule).toContain("app-page:/products/:id");
          expect(embedded).not.toContain(CACHEABILITY_MANIFEST_PLACEHOLDER);
          expect(
            fs.readFileSync(path.join(isolatedDirectory, "chunks/router.js"), "utf-8"),
          ).toContain("../__vinext_cacheability_manifest.js");
          expect(fs.readFileSync(firstPath, "utf-8")).toBe(source);
          return "uploaded";
        },
      ),
    ).toBe("uploaded");

    expect(fs.readFileSync(firstPath, "utf-8")).toBe(source);
    expect(fs.readFileSync(secondPath, "utf-8")).toBe(source);
    expect(fs.existsSync(isolatedConfigPath)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("preserves a selected generated Wrangler config during the isolated upload", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-custom-config-"));
    const serverDirectory = path.join(root, "dist/custom-server");
    fs.mkdirSync(serverDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(serverDirectory, "worker.mjs"),
      `export const value = ${JSON.stringify(CACHEABILITY_MANIFEST_PLACEHOLDER)};`,
    );
    fs.writeFileSync(
      path.join(serverDirectory, "wrangler.generated.json"),
      JSON.stringify({ main: "worker.mjs", name: "custom-name", preview_urls: true }),
    );

    withEmbeddedCacheabilityManifest(
      root,
      "dist/custom-server/wrangler.generated.json",
      { routes: {}, version: 1 },
      (configPath) => {
        const config = JSON.parse(fs.readFileSync(path.join(root, configPath), "utf-8"));
        expect(config).toEqual({
          main: "worker.mjs",
          name: "custom-name",
          preview_urls: true,
        });
        expect(
          fs.readFileSync(
            path.join(path.dirname(path.join(root, configPath)), "worker.mjs"),
            "utf-8",
          ),
        ).not.toContain(CACHEABILITY_MANIFEST_PLACEHOLDER);
      },
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("isolates a generated config at the dist root without recursive copying", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-dist-config-"));
    fs.mkdirSync(path.join(root, "dist/server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist/server/entry.js"),
      `export const value = ${JSON.stringify(CACHEABILITY_MANIFEST_PLACEHOLDER)};`,
    );
    fs.writeFileSync(
      path.join(root, "dist/wrangler.json"),
      JSON.stringify({ main: "server/entry.js" }),
    );

    expect(
      withEmbeddedCacheabilityManifest(
        root,
        "dist/wrangler.json",
        { routes: {}, version: 1 },
        (configPath) => {
          const isolated = path.join(root, configPath);
          expect(JSON.parse(fs.readFileSync(isolated, "utf-8"))).toEqual({
            main: "server/entry.js",
          });
          expect(
            fs.readFileSync(path.join(path.dirname(isolated), "server/entry.js"), "utf-8"),
          ).not.toContain(CACHEABILITY_MANIFEST_PLACEHOLDER);
          return "uploaded";
        },
      ),
    ).toBe("uploaded");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("restores server artifacts when the final upload throws", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-artifact-error-"));
    const filePath = path.join(root, "dist/server/entry.js");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const source = `export const value = ${JSON.stringify(CACHEABILITY_MANIFEST_PLACEHOLDER)};`;
    fs.writeFileSync(filePath, source);
    fs.writeFileSync(path.join(root, "dist/server/wrangler.json"), "{}");

    expect(() =>
      withEmbeddedCacheabilityManifest(root, undefined, { routes: {}, version: 1 }, () => {
        throw new Error("upload failed");
      }),
    ).toThrow("upload failed");
    expect(fs.readFileSync(filePath, "utf-8")).toBe(source);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("buffered cache admission", () => {
  // Next.js decides static eligibility from the completed render and throws on
  // static-to-dynamic transitions rather than caching request-specific output:
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/build/templates/app-page-runtime.ts
  it("uses an exact path classification before the route-pattern fallback", async () => {
    installExactPathManifest();
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());

    const dynamicContext = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/dynamic"),
      "secret-a",
    );
    await runWithExecutionContext(dynamicContext, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(false);
      const response = await finalizeWorkerCacheabilityResponse(
        new Response("personalized", {
          headers: { "Cache-Control": "public, s-maxage=60" },
        }),
        dynamicContext,
      );
      expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
      expect(response.headers.get("CDN-Cache-Control")).toBeNull();
      await expect(response.text()).resolves.toBe("personalized");
    });

    const staticContext = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/static"),
      "secret-a",
    );
    await runWithExecutionContext(staticContext, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
    });

    const fallbackContext = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/on-demand"),
      "secret-a",
    );
    await runWithExecutionContext(fallbackContext, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
    });
  });

  it("fails closed when an earlier request phase can vary the route", async () => {
    installManifest("runtime-check");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/conditional"),
      "secret-a",
    );

    const response = await runWithExecutionContext(ctx, async () => {
      markRequestCacheabilityUnsafe("request-conditional config can vary this pathname");
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      return finalizeWorkerCacheabilityResponse(
        new Response("public-looking", {
          headers: { "Cache-Control": "public, s-maxage=60" },
        }),
        ctx,
      );
    });

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    await expect(response.text()).resolves.toBe("public-looking");
  });

  it("keeps request-varying safety as a monotonic veto after App finalization", async () => {
    installManifest("runtime-check");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/conditional-finalizer"),
      "secret-a",
    );

    const response = await runWithExecutionContext(ctx, async () => {
      markRequestCacheabilityUnsafe("middleware can vary this pathname");
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      const pending = finalizeAppPageHtmlCacheResponse(new Response("completed static"), {
        capturedRscDataPromise: null,
        cleanPathname: "/products/conditional-finalizer",
        consumeDynamicUsage: () => false,
        getPageTags: () => ["/products/conditional-finalizer"],
        isrHtmlKey: (pathname) => `html:${pathname}`,
        isrRscKey: (pathname) => `rsc:${pathname}`,
        isrSet: vi.fn(async () => {}),
        linkHeader: null,
        revalidateSeconds: 60,
      });
      return finalizeWorkerCacheabilityResponse(pending, ctx);
    });

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    await expect(response.text()).resolves.toBe("completed static");
  });

  it.each([
    { dynamicFetches: ["https://api.example.com/uncached"], requestApis: [] },
    { dynamicFetches: [], requestApis: ["headers" as const] },
  ])("does not admit an App response whose completed render requires runtime", async (state) => {
    installManifest("runtime-check");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/cache-components"),
      "secret-a",
    );
    const isrSet = vi.fn(async () => {});

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id", { partialPrerender: true })).toBe(
        true,
      );
      const pending = finalizeAppPageHtmlCacheResponse(new Response("runtime hole"), {
        capturedRscDataPromise: null,
        cleanPathname: "/products/cache-components",
        consumeDynamicUsage: () => false,
        consumeRenderObservationState: () => state,
        getPageTags: () => ["/products/cache-components"],
        isrHtmlKey: (pathname) => `html:${pathname}`,
        isrRscKey: (pathname) => `rsc:${pathname}`,
        isrSet,
        linkHeader: null,
        revalidateSeconds: 60,
      });
      return finalizeWorkerCacheabilityResponse(pending, ctx);
    });

    expect(isrSet).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    await expect(response.text()).resolves.toBe("runtime hole");
  });

  it("admits force-static App responses whose request APIs were replaced with empty values", async () => {
    installManifest("runtime-check");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/force-static"),
      "secret-a",
    );
    const isrSet = vi.fn(async () => {});

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      const pending = finalizeAppPageHtmlCacheResponse(new Response("forced static"), {
        allowRequestApis: true,
        capturedRscDataPromise: null,
        cleanPathname: "/products/force-static",
        consumeDynamicUsage: () => false,
        consumeRenderObservationState: () => ({
          dynamicFetches: [],
          requestApis: ["headers", "cookies"],
        }),
        getPageTags: () => ["/products/force-static"],
        isrHtmlKey: (pathname) => `html:${pathname}`,
        isrRscKey: (pathname) => `rsc:${pathname}`,
        isrSet,
        linkHeader: null,
        revalidateSeconds: Infinity,
      });
      return finalizeWorkerCacheabilityResponse(pending, ctx);
    });

    expect(isrSet).toHaveBeenCalledTimes(1);
    expect(response.headers.get("CDN-Cache-Control")).toBe(
      "public, max-age=31536000, stale-while-revalidate=31536000",
    );
    await expect(response.text()).resolves.toBe("forced static");
  });

  it("forces an unsafe early response to no-store before route dispatch", async () => {
    installManifest("runtime-check");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/conditional-redirect"),
      "secret-a",
    );

    const response = await runWithExecutionContext(ctx, async () => {
      markRequestCacheabilityUnsafe("conditional redirect can vary this pathname");
      return finalizeWorkerCacheabilityResponse(
        new Response(null, {
          headers: { "Cache-Control": "public, s-maxage=60", Location: "/private" },
          status: 307,
        }),
        ctx,
      );
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/private");
    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
  });

  it("forces an externally rewritten response to no-store before route dispatch", async () => {
    installManifest("runtime-check");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/account"),
      "secret-a",
    );

    const response = await runWithExecutionContext(ctx, async () => {
      const unsafe = configRoutesCanVaryResponse({
        basePathState: { basePath: "", hadBasePath: true },
        headers: [],
        pathname: "/account",
        redirects: [],
        rewrites: {
          afterFiles: [],
          beforeFiles: [{ source: "/account", destination: "https://origin.example/profile" }],
          fallback: [],
        },
      });
      if (unsafe) markRequestCacheabilityUnsafe("config can proxy this pathname externally");
      return finalizeWorkerCacheabilityResponse(
        new Response("personalized upstream", {
          headers: { "CDN-Cache-Control": "public, max-age=60" },
        }),
        ctx,
      );
    });

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    await expect(response.text()).resolves.toBe("personalized upstream");
  });

  it("disables admission when a middleware source matches but its request condition does not", async () => {
    installManifest("runtime-check");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const request = new Request("https://example.com/products/conditional");
    const ctx = createWorkerCacheabilityContext(createContext(), request, "secret-a");
    const middleware = vi.fn(() => new Response(null));

    const response = await runWithExecutionContext(ctx, async () => {
      const middlewareResult = await executeMiddleware({
        isProxy: false,
        module: {
          config: {
            matcher: [
              {
                source: "/products/:id",
                has: [{ type: "header", key: "authorization" }],
              },
            ],
          },
          middleware,
        },
        request,
      });
      expect(middlewareResult.continue).toBe(true);
      expect(middleware).not.toHaveBeenCalled();
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      return finalizeWorkerCacheabilityResponse(
        new Response("public-looking", {
          headers: { "Cache-Control": "public, s-maxage=60" },
        }),
        ctx,
      );
    });

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
  });

  it("restores edge cache headers only after a candidate response completes static", async () => {
    installManifest();
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const base = createContext();
    const request = new Request("https://example.com/products/one");
    const ctx = createWorkerCacheabilityContext(base, request, "secret-a");

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      const complete = deferRouteCacheability();
      const headers = new Headers();
      applyCdnResponseHeaders(headers, {
        cacheControl: "s-maxage=60, stale-while-revalidate=300",
        pendingDynamicCheck: true,
      });
      markRouteCacheabilityPolicyProvisional(headers);
      const pending = new Response("complete body", { headers });
      queueMicrotask(() =>
        complete?.({
          cacheable: true,
          cacheControl: "s-maxage=60, stale-while-revalidate=300",
          tags: ["/products/one"],
        }),
      );
      return finalizeWorkerCacheabilityResponse(pending, ctx);
    });

    await expect(response.text()).resolves.toBe("complete body");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBe(
      "public, max-age=60, stale-while-revalidate=300",
    );
    expect(response.headers.get("Cache-Tag")).toBe("/products/one");
  });

  it.each([
    ["a manifest runtime-check entry", "runtime-check" as const, "/products/:id"],
    ["no manifest entry", "static-candidate" as const, "/new-route"],
  ])("admits a completed static response with %s", async (_label, manifestState, pattern) => {
    installManifest(manifestState);
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request(`https://example.com${pattern === "/new-route" ? pattern : "/products/new"}`),
      "secret-a",
    );

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", pattern)).toBe(true);
      const complete = deferRouteCacheability();
      const pending = new Response("runtime checked", {
        headers: { "Cache-Control": "no-store" },
      });
      markRouteCacheabilityPolicyProvisional(pending.headers);
      queueMicrotask(() =>
        complete?.({
          cacheable: true,
          cacheControl: "s-maxage=60, stale-while-revalidate=300",
        }),
      );
      return finalizeWorkerCacheabilityResponse(pending, ctx);
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("CDN-Cache-Control")).toBe(
      "public, max-age=60, stale-while-revalidate=300",
    );
  });

  it("keeps a candidate request uncacheable when the completed render uses a dynamic API", async () => {
    installManifest();
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const request = new Request("https://example.com/products/two");
    const ctx = createWorkerCacheabilityContext(createContext(), request, "secret-a");

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      const complete = deferRouteCacheability();
      const pending = new Response("personalized", {
        headers: { "Cache-Control": "no-store" },
      });
      queueMicrotask(() => complete?.({ cacheable: false, reason: "cookies()" }));
      return finalizeWorkerCacheabilityResponse(pending, ctx);
    });

    await expect(response.text()).resolves.toBe("personalized");
    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
  });

  it.each([
    ["middleware no-store", { "Cache-Control": "no-store" }],
    ["middleware Set-Cookie", { "Set-Cookie": "session=private; Path=/" }],
  ])("does not overwrite %s after the App render completes", async (_label, responseHeaders) => {
    installManifest();
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/policy"),
      "secret-a",
    );

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      const pending = finalizeAppPageHtmlCacheResponse(
        new Response("policy response", { headers: responseHeaders }),
        {
          capturedRscDataPromise: Promise.resolve({
            body: new TextEncoder().encode("flight").buffer,
            release() {},
          }),
          cleanPathname: "/products/policy",
          consumeDynamicUsage() {
            return false;
          },
          getPageTags() {
            return ["/products/policy"];
          },
          isrHtmlKey: (pathname) => `html:${pathname}`,
          isrRscKey: (pathname) => `rsc:${pathname}`,
          isrSet: vi.fn(async () => {}),
          linkHeader: null,
          revalidateSeconds: 60,
        },
      );
      return finalizeWorkerCacheabilityResponse(pending, ctx);
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    if ("Set-Cookie" in responseHeaders) {
      expect(response.headers.get("Set-Cookie")).toContain("session=private");
    }
  });

  it("does not mistake an identical next.config no-store policy for the provisional policy", async () => {
    installManifest();
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/configured"),
      "secret-a",
    );

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      const complete = deferRouteCacheability();
      const headers = new Headers();
      applyCdnResponseHeaders(headers, {
        cacheControl: "s-maxage=60, stale-while-revalidate=300",
        pendingDynamicCheck: true,
      });
      markRouteCacheabilityPolicyProvisional(headers);
      applyConfigHeadersToResponse(headers, {
        configHeaders: [
          {
            source: "/products/:id",
            headers: [{ key: "Cache-Control", value: "no-store" }],
          },
        ],
        pathname: "/products/configured",
        requestContext: {
          cookies: {},
          headers: new Headers(),
          host: "example.com",
          query: new URLSearchParams(),
        },
      });
      queueMicrotask(() =>
        complete?.({
          cacheable: true,
          cacheControl: "s-maxage=60, stale-while-revalidate=300",
        }),
      );
      return finalizeWorkerCacheabilityResponse(new Response("configured", { headers }), ctx);
    });

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
  });

  it.each(["no-store", "private, max-age=0", "no-cache"])(
    "honors a final generic %s policy even alongside a cacheable provider policy",
    async (cacheControl) => {
      installManifest("runtime-check");
      setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
      const ctx = createWorkerCacheabilityContext(
        createContext(),
        new Request("https://example.com/products/final-policy"),
        "secret-a",
      );

      const response = await runWithExecutionContext(ctx, async () => {
        expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
        return finalizeWorkerCacheabilityResponse(
          new Response("private", {
            headers: {
              "Cache-Control": cacheControl,
              "CDN-Cache-Control": "public, max-age=60",
            },
          }),
          ctx,
        );
      });

      expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
      expect(response.headers.get("CDN-Cache-Control")).toBeNull();
      await expect(response.text()).resolves.toBe("private");
    },
  );

  it("does not treat a policy without a positive cache lifetime as cacheable", async () => {
    installManifest("runtime-check");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/no-lifetime"),
      "secret-a",
    );

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      return finalizeWorkerCacheabilityResponse(
        new Response("uncertified", {
          headers: { "CDN-Cache-Control": "public, no-transform" },
        }),
        ctx,
      );
    });

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    await expect(response.text()).resolves.toBe("uncertified");
  });

  it("preserves an explicit Cloudflare CDN cache policy through final admission", async () => {
    installManifest("runtime-check");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/cloudflare-policy"),
      "secret-a",
    );

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      return finalizeWorkerCacheabilityResponse(
        new Response("provider policy", {
          headers: { "Cloudflare-CDN-Cache-Control": "public, max-age=60" },
        }),
        ctx,
      );
    });

    expect(response.headers.get("CDN-Cache-Control")).toBe("public, max-age=60");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    await expect(response.text()).resolves.toBe("provider policy");
  });

  it.each([400, 401, 403, 405, 410, 429, 500])(
    "does not admit status %i even when the completed render is cacheable",
    async (status) => {
      installManifest();
      setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
      const ctx = createWorkerCacheabilityContext(
        createContext(),
        new Request("https://example.com/products/status"),
        "secret-a",
      );

      const response = await runWithExecutionContext(ctx, async () => {
        expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
        const complete = deferRouteCacheability();
        queueMicrotask(() =>
          complete?.({ cacheable: true, cacheControl: "s-maxage=60, stale-while-revalidate=300" }),
        );
        return finalizeWorkerCacheabilityResponse(new Response("status", { status }), ctx);
      });

      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
      expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    },
  );

  it.each([201, 307])(
    "admits cacheable framework status %i after completed-render validation",
    async (status) => {
      installManifest();
      setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
      const ctx = createWorkerCacheabilityContext(
        createContext(),
        new Request("https://example.com/products/cacheable-status"),
        "secret-a",
      );

      const response = await runWithExecutionContext(ctx, async () => {
        expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
        const complete = deferRouteCacheability();
        queueMicrotask(() => complete?.({ cacheable: true, cacheControl: "s-maxage=60" }));
        return finalizeWorkerCacheabilityResponse(
          new Response(status === 307 ? null : "created", { status }),
          ctx,
        );
      });

      expect(response.status).toBe(status);
      expect(response.headers.get("CDN-Cache-Control")).toBe("public, max-age=60");
    },
  );

  it("reports and returns 500 when a proven static route becomes dynamic", async () => {
    installManifest();
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const reportRequestError = vi.fn();
    globalThis.__VINEXT_onRequestErrorHandler__ = reportRequestError;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/changed", { headers: { "x-test": "value" } }),
      "secret-a",
    );

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      const complete = deferRouteCacheability();
      queueMicrotask(() =>
        complete?.({ cacheable: false, dynamicUsage: true, reason: "cookies()" }),
      );
      return finalizeWorkerCacheabilityResponse(new Response("personalized"), ctx);
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    await expect(response.text()).resolves.toBe("Internal Server Error");
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Page changed from static to dynamic at runtime /products/changed, reason: cookies()\n" +
          "see more here https://nextjs.org/docs/messages/app-static-to-dynamic-error",
      }),
    );
    expect(reportRequestError).toHaveBeenCalledWith(
      expect.any(Error),
      { headers: { "x-test": "value" }, method: "GET", path: "/products/changed" },
      { routerKind: "App Router", routePath: "/products/:id", routeType: "render" },
    );
  });

  it("runtime-checks RSC independently from an HTML static-candidate", async () => {
    installManifest();
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/changed?_rsc=1", { headers: { RSC: "1" } }),
      "secret-a",
    );

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      recordRouteCacheability({ cacheable: false, dynamicUsage: true, reason: "cookies()" });
      return finalizeWorkerCacheabilityResponse(new Response("dynamic RSC"), ctx);
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    await expect(response.text()).resolves.toBe("dynamic RSC");
  });

  it("does not raise the static-to-dynamic invariant for a PPR route", async () => {
    installManifest();
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/ppr"),
      "secret-a",
    );

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id", { partialPrerender: true })).toBe(
        true,
      );
      const complete = deferRouteCacheability();
      queueMicrotask(() =>
        complete?.({ cacheable: false, dynamicUsage: true, reason: "cookies()" }),
      );
      return finalizeWorkerCacheabilityResponse(new Response("PPR dynamic portion"), ctx);
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    await expect(response.text()).resolves.toBe("PPR dynamic portion");
  });

  it("keeps event streams streaming and explicitly uncacheable", async () => {
    installManifest();
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/events"),
      "secret-a",
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: ready\n\n"));
      },
    });

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      return finalizeWorkerCacheabilityResponse(
        new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
        ctx,
      );
    });

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: ready\n\n");
    await reader.cancel();
  });

  it("preserves a WebSocket/upgrade response object without reconstruction", async () => {
    installManifest("runtime-check");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/socket"),
      "secret-a",
    );
    const response = new Response(null, { headers: { Upgrade: "websocket" } });
    const socket = {};
    Object.defineProperty(response, "webSocket", { value: socket });

    const finalized = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      return finalizeWorkerCacheabilityResponse(response, ctx);
    });

    expect(finalized).toBe(response);
    expect(Reflect.get(finalized, "webSocket")).toBe(socket);
  });

  it("fails closed without losing bytes when capture exceeds the memory bound", async () => {
    installManifest("runtime-check");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/large"),
      "secret-a",
    );
    const bytes = new Uint8Array(CACHEABILITY_RESPONSE_BODY_LIMIT + 1);
    bytes[0] = 1;
    bytes[bytes.length - 1] = 2;

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      return finalizeWorkerCacheabilityResponse(
        new Response(bytes, { headers: { "CDN-Cache-Control": "public, max-age=60" } }),
        ctx,
      );
    });

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    const returned = new Uint8Array(await response.arrayBuffer());
    expect(returned.byteLength).toBe(bytes.byteLength);
    expect(returned[0]).toBe(1);
    expect(returned[returned.length - 1]).toBe(2);
  });

  it("queues excess concurrent captures before teeing another body", async () => {
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const context = createWorkerCacheabilityContext(
      { hostRuntime: "worker", isCloudflareWorker: true, waitUntil() {} },
      new Request("https://example.com/capture-budget"),
      "secret-a",
    );
    await runWithExecutionContext(context, async () => {
      const captureCount = CACHEABILITY_RESPONSE_CAPTURE_BUDGET / CACHEABILITY_RESPONSE_BODY_LIMIT;
      const bytesPerCapture = CACHEABILITY_RESPONSE_CAPTURE_BUDGET / captureCount / 2;
      const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
      const pending = Array.from({ length: captureCount }, () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
            controller.enqueue(new Uint8Array(bytesPerCapture));
          },
        });
        return captureResponseBodyBounded(new Response(stream));
      });
      await vi.waitFor(() => expect(controllers).toHaveLength(captureCount));

      const fallbackStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([9]));
          controller.close();
        },
      });
      let excessSettled = false;
      const excessPromise = captureResponseBodyBounded(new Response(fallbackStream), {
        waitForCapacity: true,
      }).then((capture) => {
        excessSettled = true;
        return capture;
      });
      await Promise.resolve();
      expect(excessSettled).toBe(false);

      for (const controller of controllers) controller.close();
      const completed = await Promise.all(pending);
      for (const capture of completed) {
        await capture.fallback?.cancel();
        if (!capture.failClosed) capture.release();
      }

      const excess = await excessPromise;
      expect(excess.failClosed).toBe(false);
      if (!excess.failClosed) {
        expect(new Uint8Array(excess.body ?? new ArrayBuffer(0))).toEqual(new Uint8Array([9]));
        await excess.fallback?.cancel();
        excess.release();
      }
    });
  });

  it("lets an authenticated final warm request wait for capture capacity", async () => {
    installManifest("runtime-check");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const occupancyContext = createWorkerCacheabilityContext(
      { hostRuntime: "worker", isCloudflareWorker: true, waitUntil() {} },
      new Request("https://example.com/capture-occupancy"),
      "secret-a",
    );
    await runWithExecutionContext(occupancyContext, async () => {
      const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
      const occupied = Array.from({ length: CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY }, () =>
        captureResponseBodyBounded(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controllers.push(controller);
                controller.enqueue(new Uint8Array([1]));
              },
            }),
          ),
        ),
      );
      await vi.waitFor(() =>
        expect(controllers).toHaveLength(CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY),
      );

      const warmRequest = new Request("https://example.com/products/warm", {
        headers: {
          "X-Vinext-Cacheability-Probe": "warm",
          "X-Vinext-Prerender-Secret": "secret-a",
        },
      });
      const warmContext = createWorkerCacheabilityContext(createContext(), warmRequest, "secret-a");
      let settled = false;
      const warmResponsePromise = runWithExecutionContext(warmContext, async () => {
        expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
        return finalizeWorkerCacheabilityResponse(
          new Response("warm", { headers: { "CDN-Cache-Control": "public, max-age=60" } }),
          warmContext,
        );
      }).then((response) => {
        settled = true;
        return response;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      controllers[0].close();
      const first = await occupied[0];
      await first.fallback?.cancel();
      if (!first.failClosed) first.release();

      const warmResponse = await warmResponsePromise;
      expect(warmResponse.status).toBe(200);
      expect(await warmResponse.text()).toBe("warm");

      for (const controller of controllers.slice(1)) controller.close();
      const remaining = await Promise.all(occupied.slice(1));
      for (const capture of remaining) {
        await capture.fallback?.cancel();
        if (!capture.failClosed) capture.release();
      }
    });
  });

  it("does not misclassify an App Page probe while its cache owner waits for capacity", async () => {
    installManifest("runtime-check");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const occupancyContext = createWorkerCacheabilityContext(
      { hostRuntime: "worker", isCloudflareWorker: true, waitUntil() {} },
      new Request("https://example.com/capture-occupancy"),
      "secret-a",
    );
    await runWithExecutionContext(occupancyContext, async () => {
      const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
      const occupied = Array.from({ length: CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY }, () =>
        captureResponseBodyBounded(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controllers.push(controller);
                controller.enqueue(new Uint8Array([1]));
              },
            }),
          ),
        ),
      );
      await vi.waitFor(() =>
        expect(controllers).toHaveLength(CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY),
      );

      const probeRequest = new Request("https://example.com/products/page-owner", {
        headers: {
          "X-Vinext-Cacheability-Probe": "1",
          "X-Vinext-Prerender-Secret": "secret-a",
        },
      });
      const probeContext = createWorkerCacheabilityContext(
        createContext(),
        probeRequest,
        "secret-a",
      );
      let settled = false;
      const probeResponsePromise = runWithExecutionContext(probeContext, async () => {
        expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
        const response = finalizeAppPageHtmlCacheResponse(new Response("page-owner"), {
          capturedRscDataPromise: null,
          cleanPathname: "/products/page-owner",
          consumeDynamicUsage: () => false,
          getPageTags: () => ["/products/page-owner"],
          isrHtmlKey: (pathname) => `html:${pathname}`,
          isrRscKey: (pathname) => `rsc:${pathname}`,
          isrSet: vi.fn(async () => {}),
          linkHeader: null,
          revalidateSeconds: 60,
        });
        return finalizeWorkerCacheabilityResponse(response, probeContext);
      }).then((response) => {
        settled = true;
        return response;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      controllers[0].close();
      const first = await occupied[0];
      await first.fallback?.cancel();
      if (!first.failClosed) first.release();

      const probeResponse = await probeResponsePromise;
      expect(await probeResponse.json()).toMatchObject({ state: "static-candidate" });

      for (const controller of controllers.slice(1)) controller.close();
      const remaining = await Promise.all(occupied.slice(1));
      for (const capture of remaining) {
        await capture.fallback?.cancel();
        if (!capture.failClosed) capture.release();
      }
    });
  });

  it("starts an App Route probe's task-boundary clock after capture capacity is acquired", async () => {
    installManifest("runtime-check");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const occupancyContext = createWorkerCacheabilityContext(
      { hostRuntime: "worker", isCloudflareWorker: true, waitUntil() {} },
      new Request("https://example.com/capture-occupancy"),
      "secret-a",
    );
    await runWithExecutionContext(occupancyContext, async () => {
      const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
      const occupied = Array.from({ length: CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY }, () =>
        captureResponseBodyBounded(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controllers.push(controller);
                controller.enqueue(new Uint8Array([1]));
              },
            }),
          ),
        ),
      );
      await vi.waitFor(() =>
        expect(controllers).toHaveLength(CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY),
      );

      const probeRequest = new Request("https://example.com/api/route-owner", {
        headers: {
          "X-Vinext-Cacheability-Probe": "1",
          "X-Vinext-Prerender-Secret": "secret-a",
        },
      });
      const probeContext = createWorkerCacheabilityContext(
        createContext(),
        probeRequest,
        "secret-a",
      );
      let settled = false;
      const probeResponsePromise = runWithExecutionContext(probeContext, async () => {
        expect(beginRouteCacheability("app-route", "/api/route-owner")).toBe(true);
        const response = await executeAppRouteHandler({
          buildPageCacheTags: () => [],
          cleanPathname: "/api/route-owner",
          clearRequestContext() {},
          consumeDynamicUsage: () => false,
          executionContext: null,
          getAndClearPendingCookies: () => [],
          getCollectedFetchTags: () => [],
          getDraftModeCookieHeader: () => null,
          handler: {},
          handlerFn: () => new Response("route-owner"),
          isAutoHead: false,
          isProduction: true,
          isrRouteKey: (pathname) => `route:${pathname}`,
          isrSet: vi.fn(async () => {}),
          markDynamicUsage() {},
          method: "GET",
          middlewareContext: { headers: null, status: null },
          observeCompletedBody: true,
          params: null,
          reportRequestError() {},
          request: probeRequest,
          revalidateSeconds: 60,
          routePattern: "/api/route-owner",
          setHeadersAccessPhase: () => "render",
        });
        return finalizeWorkerCacheabilityResponse(response, probeContext);
      }).then((response) => {
        settled = true;
        return response;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      controllers[0].close();
      const first = await occupied[0];
      await first.fallback?.cancel();
      if (!first.failClosed) first.release();

      const probeResponse = await probeResponsePromise;
      expect(await probeResponse.json()).toMatchObject({ state: "static-candidate" });

      for (const controller of controllers.slice(1)) controller.close();
      const remaining = await Promise.all(occupied.slice(1));
      for (const capture of remaining) {
        await capture.fallback?.cancel();
        if (!capture.failClosed) capture.release();
      }
    });
  });

  it("keeps completed captures in the aggregate budget until their owners release them", async () => {
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const context = createWorkerCacheabilityContext(
      { hostRuntime: "worker", isCloudflareWorker: true, waitUntil() {} },
      new Request("https://example.com/retained-capture-budget"),
      "secret-a",
    );
    await runWithExecutionContext(context, async () => {
      const retained: CapturedResponseBody[] = [];
      for (let index = 0; index < 2; index++) {
        const capture = await captureResponseBodyBounded(
          new Response(new Uint8Array(CACHEABILITY_RESPONSE_BODY_LIMIT)),
        );
        await capture.fallback?.cancel();
        retained.push(capture);
      }
      expect(retained.every((capture) => !capture.failClosed)).toBe(true);

      const excess = await captureResponseBodyBounded(
        new Response(new Uint8Array(CACHEABILITY_RESPONSE_BODY_LIMIT)),
      );
      expect(excess).toMatchObject({
        failClosed: true,
        reason: expect.stringContaining("isolate budget"),
      });

      for (const capture of retained) {
        if (!capture.failClosed) {
          await capture.fallback?.cancel();
          capture.release();
        }
      }
      await excess.fallback?.cancel();
      const afterRelease = await captureResponseBodyBounded(new Response(new Uint8Array([3])));
      expect(afterRelease.failClosed).toBe(false);
      if (!afterRelease.failClosed) {
        await afterRelease.fallback?.cancel();
        afterRelease.release();
      }
    });
  });

  it("releases captures that finish after request admission has closed", async () => {
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/late-capture"),
      "secret-a",
    );
    const release = vi.fn();

    await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/late-capture")).toBe(true);
      recordRouteCacheability({ cacheable: false, dynamicUsage: true });
      await finalizeWorkerCacheabilityResponse(new Response("dynamic"), ctx);

      expect(recordRouteCacheabilityCapturedBody(new ArrayBuffer(1), release)).toBe(true);
    });

    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves ordinary bodies when classification infrastructure fails", async () => {
    installManifest("static-candidate");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const context = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/infrastructure-pressure"),
      "secret-a",
    );

    const response = await runWithExecutionContext(context, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      recordRouteCacheabilityClassificationFailure("capture capacity unavailable");
      return finalizeWorkerCacheabilityResponse(new Response("still-streamed"), context);
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    await expect(response.text()).resolves.toBe("still-streamed");
  });

  it("makes authenticated warm classification failures retryable", async () => {
    installManifest("static-candidate");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const request = new Request("https://example.com/products/infrastructure-pressure", {
      headers: {
        "X-Vinext-Cacheability-Probe": "warm",
        "X-Vinext-Prerender-Secret": "secret-a",
      },
    });
    const context = createWorkerCacheabilityContext(createContext(), request, "secret-a");

    const response = await runWithExecutionContext(context, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      recordRouteCacheabilityClassificationFailure("capture capacity unavailable");
      return finalizeWorkerCacheabilityResponse(new Response("discarded-warm-body"), context);
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
  });

  it("bounds overflow retention while ordinary excess captures fail closed immediately", async () => {
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const context = createWorkerCacheabilityContext(
      { hostRuntime: "worker", isCloudflareWorker: true, waitUntil() {} },
      new Request("https://example.com/failed-capture-budget"),
      "secret-a",
    );
    await runWithExecutionContext(context, async () => {
      const captureCount = CACHEABILITY_RESPONSE_CAPTURE_BUDGET / CACHEABILITY_RESPONSE_BODY_LIMIT;
      const failed = [];
      for (let index = 0; index < captureCount; index++) {
        failed.push(
          await captureResponseBodyBounded(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array([index]));
                  controller.enqueue(new Uint8Array(CACHEABILITY_RESPONSE_BODY_LIMIT));
                  controller.close();
                },
              }),
            ),
          ),
        );
      }
      expect(failed.every((capture) => capture.failClosed)).toBe(true);

      const readers = failed.map((capture) => {
        if (!capture.failClosed) throw new Error("expected failed capture");
        return capture.fallback.getReader();
      });
      for (const [index, reader] of readers.entries()) {
        const prefix = await reader.read();
        expect(prefix.done).toBe(false);
        expect(prefix.value).toEqual(new Uint8Array([index]));
      }

      const immediate = await captureResponseBodyBounded(new Response(new Uint8Array([8])));
      expect(immediate).toMatchObject({ failClosed: true, failure: "capacity" });
      if (immediate.failClosed) {
        await expect(immediate.fallback.getReader().read()).resolves.toMatchObject({
          done: false,
          value: new Uint8Array([8]),
        });
      }

      let excessSettled = false;
      const excessPromise = captureResponseBodyBounded(
        new Response(new Uint8Array(CACHEABILITY_RESPONSE_BODY_LIMIT)),
        { waitForCapacity: true },
      ).then((capture) => {
        excessSettled = true;
        return capture;
      });
      await Promise.resolve();
      expect(excessSettled).toBe(false);

      const overflow = await readers[0].read();
      expect(overflow.done).toBe(false);
      expect(overflow.value?.byteLength).toBe(CACHEABILITY_RESPONSE_BODY_LIMIT);
      const excess = await excessPromise;
      expect(excess.failClosed).toBe(false);
      await excess.fallback?.cancel();
      if (!excess.failClosed) excess.release();
      await Promise.all(readers.map((reader) => reader.cancel()));
      const afterCancellation = await captureResponseBodyBounded(new Response(new Uint8Array([3])));
      expect(afterCancellation.failClosed).toBe(false);
      if (!afterCancellation.failClosed) {
        await afterCancellation.fallback?.cancel();
        afterCancellation.release();
      }
    });
  });

  it("streams no-store when a manifest-certified response exceeds the capture bound", async () => {
    installManifest();
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/large"),
      "secret-a",
    );

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      return finalizeWorkerCacheabilityResponse(
        new Response(new Uint8Array(CACHEABILITY_RESPONSE_BODY_LIMIT + 1), {
          headers: { "CDN-Cache-Control": "public, max-age=60" },
        }),
        ctx,
      );
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect((await response.arrayBuffer()).byteLength).toBe(CACHEABILITY_RESPONSE_BODY_LIMIT + 1);
  });

  it("fails closed on a stream that does not finish before the capture deadline", async () => {
    vi.useFakeTimers();
    installManifest("runtime-check");
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/slow"),
      "secret-a",
    );
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        controller.enqueue(new TextEncoder().encode("first"));
      },
    });

    const pending = runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      return finalizeWorkerCacheabilityResponse(
        new Response(stream, { headers: { "CDN-Cache-Control": "public, max-age=60" } }),
        ctx,
      );
    });
    await vi.advanceTimersByTimeAsync(CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS);
    const response = await pending;

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe("first");
    controller.close();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("returns a failed probe envelope before the outer probe deadline", async () => {
    vi.useFakeTimers();
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const request = new Request("https://example.com/products/slow-probe", {
      headers: {
        "X-Vinext-Cacheability-Probe": "1",
        "X-Vinext-Prerender-Secret": "secret-a",
      },
    });
    const ctx = createWorkerCacheabilityContext(createContext(), request, "secret-a");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
      },
    });

    const pending = runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      return finalizeWorkerCacheabilityResponse(
        new Response(stream, { headers: { "CDN-Cache-Control": "public, max-age=60" } }),
        ctx,
      );
    });
    await vi.advanceTimersByTimeAsync(CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS);
    const response = await pending;

    expect(CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS).toBeLessThan(30_000);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      kind: "app-page",
      pattern: "/products/:id",
      state: "probe-failed",
    });
  });

  it("reports route 500 responses as probe failures", async () => {
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const request = new Request("https://example.com/products/failing", {
      headers: {
        "X-Vinext-Cacheability-Probe": "1",
        "X-Vinext-Prerender-Secret": "secret-a",
      },
    });
    const ctx = createWorkerCacheabilityContext(createContext(), request, "secret-a");

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      return finalizeWorkerCacheabilityResponse(new Response("failed", { status: 500 }), ctx);
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "probe-failed",
      status: 500,
    });
  });

  it("allows a cacheable ISR not-found response", async () => {
    installManifest();
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/missing"),
      "secret-a",
    );

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      const complete = deferRouteCacheability();
      queueMicrotask(() =>
        complete?.({ cacheable: true, cacheControl: "s-maxage=60, stale-while-revalidate=300" }),
      );
      return finalizeWorkerCacheabilityResponse(new Response("not found", { status: 404 }), ctx);
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("CDN-Cache-Control")).toBe(
      "public, max-age=60, stale-while-revalidate=300",
    );
  });

  it("does not buffer the default origin-managed data-cache path", async () => {
    installManifest();
    setCdnCacheAdapter(new DefaultCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/three"),
      "secret-a",
    );
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streaming"));
      },
    });

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(false);
      return finalizeWorkerCacheabilityResponse(new Response(source), ctx);
    });

    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("streaming");
    await reader.cancel();
  });

  it("returns an uncacheable 500 when the candidate stream fails while being captured", async () => {
    installManifest();
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const ctx = createWorkerCacheabilityContext(
      createContext(),
      new Request("https://example.com/products/broken"),
      "secret-a",
    );

    const response = await runWithExecutionContext(ctx, async () => {
      expect(beginRouteCacheability("app-page", "/products/:id")).toBe(true);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("render exploded"));
        },
      });
      return finalizeWorkerCacheabilityResponse(
        new Response(stream, {
          headers: { "CDN-Cache-Control": "public, max-age=60" },
        }),
        ctx,
      );
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    await expect(response.text()).resolves.toBe("Internal Server Error");
  });
});
