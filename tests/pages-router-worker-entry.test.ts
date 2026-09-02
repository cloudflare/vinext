import path from "node:path";
import { createServer, type Plugin } from "vite";
import { describe, expect, it } from "vite-plus/test";

function pagesWorkerEntryVirtualModules(): Plugin {
  const modules = new Map([
    [
      "virtual:vinext-server-entry",
      `
export const prerenderSecret = "worker-prerender-secret";
export const vinextConfig = {};
`,
    ],
    [
      "virtual:vinext-pages-request-entry",
      `
export const authorizeOnDemandRevalidate = () => false;
export const buildId = "worker-build";
export const hasMiddleware = false;
export const matchApiRoute = () => null;
export const matchPageRoute = () => ({ route: { dataKind: "static", isDynamic: false, pattern: "/page" } });
export const normalizeDataRequest = (request) => ({ isDataReq: false, normalizedPathname: null, notFoundResponse: null, request });
export const prerenderSecret = "worker-prerender-secret";
export const publicFiles = new Set();
export const runMiddleware = null;
export const vinextConfig = {};
`,
    ],
    [
      "virtual:vinext-pages-response-entry",
      `
import { CACHEABILITY_REQUEST_STATE } from "vinext/shims/cacheability-classification";
export const buildId = "worker-build";
export const pageRoutes = [];
export const getRuntimePageDataKind = () => "static";
export async function renderPage(request, _resolvedUrl, _route, ctx) {
  const state = ctx[CACHEABILITY_REQUEST_STATE];
  if (state) {
    state.route = { kind: "pages-page", pattern: "/page" };
    state.outcome = request.headers.has("x-runtime-dynamic")
      ? { cacheable: false, dynamicUsage: true }
      : { cacheable: true, cacheControl: "s-maxage=60" };
  }
  return new Response("page");
}
`,
    ],
    ["virtual:vinext-cacheability-manifest", "export default null;"],
    [
      "virtual:vinext-cache-adapters",
      `
import { setCdnCacheAdapter } from "vinext/shims/cdn-cache";
export function registerConfiguredCacheAdapters() {
  setCdnCacheAdapter({
    buildResponseHeaders({ cacheControl }) { return { "Cache-Control": cacheControl }; },
    ownsBackgroundRevalidation: false,
    requiresCompletedResponseAdmission: true,
    async get() { return null; },
    async revalidateTag() {},
    async set() {},
  });
}
`,
    ],
    ["virtual:vinext-image-adapters", "export function registerConfiguredImageOptimizer() {}"],
  ]);

  return {
    name: "pages-router-worker-entry-test-virtual-modules",
    resolveId(id) {
      return modules.has(id) ? `\0${id}` : null;
    },
    load(id) {
      return id.startsWith("\0") ? (modules.get(id.slice(1)) ?? null) : null;
    },
  };
}

describe("Pages Router production Worker readiness", () => {
  it("answers authenticated staged readiness before routing or rendering", async () => {
    // No Next.js test port applies: this is a vinext Cloudflare deployment endpoint.
    const server = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      plugins: [pagesWorkerEntryVirtualModules()],
      resolve: {
        alias: {
          "vinext/shims": path.resolve(import.meta.dirname, "../packages/vinext/src/shims"),
        },
      },
      server: { middlewareMode: true },
    });

    try {
      const entry = (await server.ssrLoadModule(
        path.resolve(import.meta.dirname, "../packages/vinext/src/server/pages-router-entry.ts"),
      )) as {
        default: {
          fetch(request: Request, env?: unknown, ctx?: { waitUntil(): void }): Promise<Response>;
        };
      };

      const response = await entry.default.fetch(
        new Request("https://example.com/__vinext/prerender/readiness", {
          headers: {
            accept: "text/html",
            "x-vinext-expected-worker-version": "version-a",
            "x-vinext-prerender-secret": "worker-prerender-secret",
          },
        }),
        undefined,
        { waitUntil() {} },
      );
      const unauthorizedResponse = await entry.default.fetch(
        new Request("https://example.com/__vinext/prerender/readiness", {
          headers: {
            "x-vinext-expected-worker-version": "version-a",
            "x-vinext-prerender-secret": "wrong-secret",
          },
        }),
        undefined,
        { waitUntil() {} },
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-vinext-prerender-readiness")).toBe("1");
      expect(unauthorizedResponse.status).toBe(404);
      expect(unauthorizedResponse.headers.get("cache-control")).toBe("no-store");
    } finally {
      await server.close();
    }
  });

  it("finalizes completed-response admission around the whole single-stage Pages pipeline", async () => {
    const server = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      plugins: [pagesWorkerEntryVirtualModules()],
      resolve: {
        alias: {
          "vinext/shims": path.resolve(import.meta.dirname, "../packages/vinext/src/shims"),
        },
      },
      server: { middlewareMode: true },
    });

    try {
      const entry = (await server.ssrLoadModule(
        path.resolve(import.meta.dirname, "../packages/vinext/src/server/pages-router-entry.ts"),
      )) as {
        default: {
          fetch(request: Request, env?: unknown, ctx?: { waitUntil(): void }): Promise<Response>;
        };
      };

      const admitted = await entry.default.fetch(
        new Request("https://example.com/page", { headers: { Accept: "text/html" } }),
        undefined,
        { waitUntil() {} },
      );
      expect(admitted.headers.get("cache-control")).toBe("s-maxage=60");
      await expect(admitted.text()).resolves.toBe("page");

      const dynamic = await entry.default.fetch(
        new Request("https://example.com/page", {
          headers: { Accept: "text/html", "x-runtime-dynamic": "1" },
        }),
        undefined,
        { waitUntil() {} },
      );
      expect(dynamic.headers.get("cache-control")).toContain("no-store");
      await expect(dynamic.text()).resolves.toBe("page");
    } finally {
      await server.close();
    }
  });
});
