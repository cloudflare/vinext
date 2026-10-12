import path from "node:path";
import { createServer, type Plugin } from "vite";
import { describe, expect, it } from "vite-plus/test";

function pagesWorkerEntryVirtualModules(overrides: Record<string, string> = {}): Plugin {
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
export const hasRequestAwareDocument = false;
export const matchApiRoute = () => null;
export const matchPageRoute = () => ({ route: { dataKind: "static", isDynamic: false, pattern: "/page" } });
export const normalizeDataRequest = (request) => ({ isDataReq: false, normalizedPathname: null, notFoundResponse: null, request });
export const prerenderSecret = "worker-prerender-secret";
export let instrumentationCalls = 0;
export function __ensureInstrumentation() {
  instrumentationCalls++;
}
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
export let instrumentationCalls = 0;
export function __ensureInstrumentation() {
  instrumentationCalls++;
}
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
    [
      "virtual:vinext-cdn-cache-adapter",
      `export { registerConfiguredCacheAdapters } from "virtual:vinext-cache-adapters";`,
    ],
    ["virtual:vinext-image-adapters", "export function registerConfiguredImageOptimizer() {}"],
    ...Object.entries(overrides),
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
      const requestEntry = (await server.ssrLoadModule("virtual:vinext-pages-request-entry")) as {
        instrumentationCalls: number;
      };
      const responseEntry = (await server.ssrLoadModule("virtual:vinext-pages-response-entry")) as {
        instrumentationCalls: number;
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
      expect(response.status).toBe(204);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-vinext-prerender-readiness")).toBe("1");
      expect(requestEntry.instrumentationCalls).toBe(1);
      expect(responseEntry.instrumentationCalls).toBe(1);

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
      expect(unauthorizedResponse.status).toBe(404);
      expect(unauthorizedResponse.headers.get("cache-control")).toBe("no-store");
      expect(requestEntry.instrumentationCalls).toBe(1);
      expect(responseEntry.instrumentationCalls).toBe(1);
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

  // A basePath Pages Worker with middleware denying /protected/ and
  // host-conditioned rewrites. ASSETS serves `assetPaths` with their pathname
  // as the body.
  async function loadImageWorker(assetPrefix: string, assetPaths: string[]) {
    const config = `{
  assetPrefix: ${JSON.stringify(assetPrefix)},
  basePath: "/docs",
  rewrites: {
    beforeFiles: [
      { source: "/host-avatar", has: [{ type: "host", value: "example.com" }], destination: "/open.png" },
      { source: "/any-host-avatar", has: [{ type: "host", value: ".*" }], destination: "/open.png" },
      { source: "/no-host-avatar", missing: [{ type: "host", value: ".*" }], destination: "/open.png" },
      { source: "/override-host-avatar", has: [{ type: "host", value: "images.internal" }], destination: "/open.png" },
    ],
    afterFiles: [],
    fallback: [],
  },
}`;
    const server = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      plugins: [
        pagesWorkerEntryVirtualModules({
          "virtual:vinext-server-entry": `
export const prerenderSecret = "worker-prerender-secret";
export const vinextConfig = ${config};
`,
          "virtual:vinext-pages-request-entry": `
export const authorizeOnDemandRevalidate = () => false;
export const buildId = "worker-build";
export const hasMiddleware = true;
export const hasRequestAwareDocument = false;
export const matchApiRoute = () => null;
export const matchPageRoute = () => null;
export const normalizeDataRequest = (request) => ({ isDataReq: false, normalizedPathname: null, notFoundResponse: null, request });
export const prerenderSecret = "worker-prerender-secret";
export function __ensureInstrumentation() {}
export const publicFiles = new Set(["/open.png", "/protected/private.png", "/cdn/photo.png"]);
export const middlewareRequests = [];
export async function runMiddleware(request) {
  const url = new URL(request.url);
  middlewareRequests.push({ hasHost: request.headers.has("host"), hostname: url.hostname, pathname: url.pathname, protocol: url.protocol });
  if (url.pathname.startsWith("/docs/protected/")) {
    return { continue: false, response: new Response("blocked", { status: 403 }) };
  }
  if (url.pathname === "/docs/override-host-avatar") {
    return {
      continue: true,
      responseHeaders: [
        ["x-middleware-override-headers", "host"],
        ["x-middleware-request-host", "images.internal"],
      ],
    };
  }
  return { continue: true };
}
export const vinextConfig = ${config};
`,
        }),
      ],
      resolve: {
        alias: {
          "vinext/shims": path.resolve(import.meta.dirname, "../packages/vinext/src/shims"),
        },
      },
      server: { middlewareMode: true },
    });
    const entry = (await server.ssrLoadModule(
      path.resolve(import.meta.dirname, "../packages/vinext/src/server/pages-router-entry.ts"),
    )) as {
      default: {
        fetch(request: Request, env?: unknown, ctx?: { waitUntil(): void }): Promise<Response>;
      };
    };
    const requestEntry = (await server.ssrLoadModule("virtual:vinext-pages-request-entry")) as {
      middlewareRequests: {
        hasHost: boolean;
        hostname: string;
        pathname: string;
        protocol: string;
      }[];
    };
    const env = {
      ASSETS: {
        fetch(request: Request) {
          const { pathname } = new URL(request.url);
          return assetPaths.includes(pathname)
            ? new Response(pathname, { headers: { "content-type": "image/png" } })
            : new Response(null, { status: 404 });
        },
      },
    };
    const get = (url: string) =>
      entry.default.fetch(
        new Request(`https://example.com${url}`, { headers: { host: "example.com" } }),
        env,
        {
          waitUntil() {},
        },
      );
    return { get, middlewareRequests: requestEntry.middlewareRequests, server };
  }

  it("resolves image sources through middleware, under basePath for the unprefixed endpoint", async () => {
    // Next.js' fetchInternalImage runs a local source through the router as a
    // relative URL without headers (packages/next/src/server/image-optimizer.ts).
    // vinext's next/image emits the endpoint without basePath, so that form
    // resolves its source under basePath.
    const { get, middlewareRequests, server } = await loadImageWorker("/cdn", [
      "/open.png",
      "/protected/private.png",
      "/cdn/photo.png",
      "/cdn/_next/static/media/built.png",
    ]);
    try {
      expect((await get("/docs/protected/private.png")).status).toBe(403);
      // The caller's host matches a host-conditioned rewrite of a direct request
      // only, and middleware sees neither its Host header nor its hostname, but
      // its protocol.
      await expect((await get("/docs/host-avatar")).text()).resolves.toBe("/open.png");
      middlewareRequests.length = 0;
      expect((await get("/docs/_next/image?url=%2Fdocs%2Fhost-avatar&w=640&q=75")).status).toBe(
        404,
      );
      const sourceRequest = middlewareRequests.find(
        ({ pathname }) => pathname === "/docs/host-avatar",
      );
      expect(sourceRequest?.hasHost).toBe(false);
      expect(sourceRequest?.hostname).not.toBe("example.com");
      expect(sourceRequest?.protocol).toBe("https:");
      // Without a Host header the source matches no host condition, as in
      // Next.js' matchHas.
      expect((await get("/docs/any-host-avatar")).status).toBe(200);
      // A direct request carries a host, so it renders the page instead.
      await expect((await get("/docs/no-host-avatar")).text()).resolves.toBe("page");
      expect((await get("/docs/_next/image?url=%2Fdocs%2Fany-host-avatar&w=640&q=75")).status).toBe(
        404,
      );
      const noHost = await get("/docs/_next/image?url=%2Fdocs%2Fno-host-avatar&w=640&q=75");
      expect(noHost.status).toBe(200);
      await expect(noHost.text()).resolves.toBe("/open.png");
      // A Host header middleware sets for the source matches later rewrites.
      const overrideHost = await get(
        "/docs/_next/image?url=%2Fdocs%2Foverride-host-avatar&w=640&q=75",
      );
      expect(overrideHost.status).toBe(200);
      await expect(overrideHost.text()).resolves.toBe("/open.png");
      // Build assets under a distinct assetPrefix path are not under the
      // basePath; other files there are.
      for (const [url, body] of [
        [
          "/_next/image?url=%2Fcdn%2F_next%2Fstatic%2Fmedia%2Fbuilt.png&w=640&q=75",
          "/cdn/_next/static/media/built.png",
        ],
        ["/_next/image?url=%2Fcdn%2Fphoto.png&w=640&q=75", "/cdn/photo.png"],
      ]) {
        const image = await get(url);
        expect(image.status, url).toBe(200);
        await expect(image.text(), url).resolves.toBe(body);
      }
      for (const url of [
        "/_next/image?url=%2Fopen.png&w=640&q=75",
        "/docs/_next/image?url=%2Fdocs%2Fopen.png&w=640&q=75",
      ]) {
        const image = await get(url);
        expect(image.status, url).toBe(200);
        expect(image.headers.get("content-type"), url).toBe("image/png");
        await expect(image.text(), url).resolves.toBe("/open.png");
      }
      for (const url of [
        "/_next/image?url=%2Fprotected%2Fprivate.png&w=640&q=75",
        "/docs/_next/image?url=%2Fdocs%2Fprotected%2Fprivate.png&w=640&q=75",
      ]) {
        const image = await get(url);
        expect(image.status, url).toBe(404);
        await expect(image.text(), url).resolves.not.toContain("/protected/private.png");
      }
    } finally {
      await server.close();
    }
  });

  it("serves a build-asset image source under an assetPrefix inside the basePath", async () => {
    const { get, server } = await loadImageWorker("/docs/cdn", [
      "/docs/cdn/_next/static/media/built.png",
    ]);
    try {
      const image = await get(
        "/docs/_next/image?url=%2Fdocs%2Fcdn%2F_next%2Fstatic%2Fmedia%2Fbuilt.png&w=640&q=75",
      );
      expect(image.status).toBe(200);
      await expect(image.text()).resolves.toBe("/docs/cdn/_next/static/media/built.png");
    } finally {
      await server.close();
    }
  });
});
