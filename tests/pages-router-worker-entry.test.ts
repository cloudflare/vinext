import path from "node:path";
import { createServer, type Plugin } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { CloudflareCdnCacheAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.runtime.js";
import {
  resetCdnCacheAdapter,
  setCdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";

const REGISTER_ADAPTER = "__vinextRegisterPagesWorkerAdapter";

function workerEntryVirtualModules(): Plugin {
  const modules = new Map([
    [
      "virtual:vinext-server-entry",
      `
export const authorizeOnDemandRevalidate = undefined;
export const handleApiRoute = undefined;
export const hasMiddleware = false;
export const matchApiRoute = null;
export const matchPageRoute = null;
export function normalizeDataRequest(request) {
  return {
    isDataReq: false,
    normalizedPathname: null,
    notFoundResponse: new Response("{}", {
      status: 404,
      headers: { "content-type": "application/json" },
    }),
    request,
  };
}
export const publicFiles = [];
export const renderPage = undefined;
export const runMiddleware = undefined;
export const vinextConfig = {
  basePath: "",
  headers: [],
  redirects: [],
  rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
  trailingSlash: false,
};
`,
    ],
    [
      "virtual:vinext-cache-adapters",
      `export function registerConfiguredCacheAdapters() {
  globalThis.${REGISTER_ADAPTER}();
}`,
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

afterEach(() => {
  resetCdnCacheAdapter();
  Reflect.deleteProperty(globalThis, REGISTER_ADAPTER);
});

describe("Pages Router Worker entry cache boundary", () => {
  it("fails an early stale data response closed through the configured adapter", async () => {
    Reflect.set(globalThis, REGISTER_ADAPTER, () => {
      setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    });

    const server = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      plugins: [workerEntryVirtualModules()],
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
          fetch(request: Request): Promise<Response>;
        };
      };

      const response = await entry.default.fetch(
        new Request("https://example.test/_next/data/stale/about.json"),
      );

      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    } finally {
      await server.close();
    }
  });
});
