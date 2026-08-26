import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CloudflareCdnCacheAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.runtime.js";
import { probeStagedWorkerCacheability } from "../packages/cloudflare/src/cacheability-probe.js";
import { withEmbeddedCacheabilityManifest } from "../packages/cloudflare/src/cacheability-artifact.js";
import {
  parseCacheabilityManifest,
  resetEmbeddedCacheabilityManifestForTests,
} from "../packages/vinext/src/server/cacheability-manifest.js";
import {
  beginRouteCacheability,
  createWorkerCacheabilityContext,
  deferRouteCacheability,
  finalizeWorkerCacheabilityResponse,
} from "../packages/vinext/src/server/cacheability-request.js";
import { applyCdnResponseHeaders } from "../packages/vinext/src/server/cache-control.js";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";
import {
  DefaultCdnCacheAdapter,
  setCdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";

const manifestGlobal = "__VINEXT_CACHEABILITY_MANIFEST__";

afterEach(() => {
  vi.unstubAllGlobals();
  resetEmbeddedCacheabilityManifestForTests();
  setCdnCacheAdapter(new DefaultCdnCacheAdapter());
});

function createContext() {
  return { hostRuntime: "worker" as const, waitUntil: vi.fn() };
}

function installManifest(state: "static-candidate" | "dynamic" = "static-candidate"): void {
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

describe("cacheability manifests", () => {
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

  it("probes one representative path per pattern and explicitly marks unprobed routes dynamic", async () => {
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
          state: "static-candidate",
          status: 200,
          version: 1,
        });
      }),
    );

    const result = await probeStagedWorkerCacheability({
      headers: { "Cloudflare-Workers-Version-Overrides": 'shop="version-a"' },
      root,
      routes: [
        { kind: "app-page", pattern: "/products/:id", probePath: "/products/known" },
        { kind: "pages-page", pattern: "/account" },
      ],
      targetUrl: "https://shop.example.com",
    });

    expect(result.failures).toEqual([]);
    expect(result.probed).toBe(1);
    expect(result.manifest.routes).toEqual({
      "app-page:/products/:id": {
        kind: "app-page",
        pattern: "/products/:id",
        state: "static-candidate",
      },
      "pages-page:/account": {
        kind: "pages-page",
        pattern: "/account",
        state: "dynamic",
      },
    });
    expect(requests[0].url).toBe("https://shop.example.com/products/known");
    expect(requests[0].headers.get("X-Vinext-Cacheability-Probe")).toBe("1");
    expect(requests[0].headers.get("X-Vinext-Prerender-Secret")).toBe("secret-a");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("embeds a manifest into an isolated server artifact tree for one upload", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-artifact-"));
    const firstPath = path.join(root, "dist/server/entry.js");
    const secondPath = path.join(root, "dist/server/chunks/router.js");
    fs.mkdirSync(path.dirname(secondPath), { recursive: true });
    const source = "export const value = __VINEXT_CACHEABILITY_MANIFEST__;";
    fs.writeFileSync(firstPath, source);
    fs.writeFileSync(secondPath, source);
    fs.writeFileSync(path.join(root, "dist/server/wrangler.json"), "{}");
    let isolatedConfigPath = "";

    expect(
      withEmbeddedCacheabilityManifest(
        root,
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
          expect(embedded).toContain("app-page:/products/:id");
          expect(embedded).not.toContain(manifestGlobal);
          expect(fs.readFileSync(path.join(isolatedDirectory, "chunks/router.js"), "utf-8")).toBe(
            embedded,
          );
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

  it("restores server artifacts when the final upload throws", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-artifact-error-"));
    const filePath = path.join(root, "dist/server/entry.js");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const source = "export const value = __VINEXT_CACHEABILITY_MANIFEST__;";
    fs.writeFileSync(filePath, source);
    fs.writeFileSync(path.join(root, "dist/server/wrangler.json"), "{}");

    expect(() =>
      withEmbeddedCacheabilityManifest(root, { routes: {}, version: 1 }, () => {
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
