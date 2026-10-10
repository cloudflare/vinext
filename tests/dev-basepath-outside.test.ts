/**
 * Dev-server coverage for requests at the bare basePath and outside it.
 *
 * Vite's base middleware answers `/base` with a 302 to `/base/` and every
 * other out-of-base request with its "public base URL" 404 page before vinext
 * sees it, so `basePath: false` rules never fired in dev. These cases port
 * Next.js test/e2e/basepath/basepath.test.ts and
 * test/e2e/basepath/redirect-and-rewrite.test.ts.
 * https://github.com/vercel/next.js/blob/canary/test/e2e/basepath/
 */
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createServer, type ViteDevServer } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, startFixtureServer, testCacheDir } from "./helpers.js";

const FIXTURES = [
  {
    name: "App Router",
    dir: path.resolve(import.meta.dirname, "./fixtures/app-basepath-outside"),
    appRouter: true,
  },
  {
    name: "Pages Router",
    dir: path.resolve(import.meta.dirname, "./fixtures/pages-basepath-outside"),
    appRouter: false,
  },
] as const;

let upstream: http.Server;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`upstream ${req.url}`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("upstream did not bind");
  process.env.TEST_BASEPATH_OUTSIDE_UPSTREAM = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  delete process.env.TEST_BASEPATH_OUTSIDE_UPSTREAM;
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
});

describe.each(FIXTURES)("dev basePath boundary ($name)", ({ dir, appRouter }) => {
  let root: string;
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    root = await createIsolatedFixture(dir, "vinext-basepath-outside-");
    ({ server, baseUrl } = await startFixtureServer(root, {
      appDir: appRouter ? root : null,
    }));
  }, 60000);

  afterAll(async () => {
    await server?.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  // basepath.test.ts: "should have correct router paths on first load of /"
  it("serves the index at the bare basePath without a redirect", async () => {
    for (const pathname of ["/base", "/base?x=1"]) {
      const res = await fetch(`${baseUrl}${pathname}`, { redirect: "manual" });
      expect(res.status, pathname).toBe(200);
      expect(await res.text()).toContain("Home page");
    }
  });

  it("serves pages under the basePath", async () => {
    const res = await fetch(`${baseUrl}/base/hello`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Hello World");
  });

  // basepath.test.ts: "should show 404 for page not under the /docs prefix"
  it("renders the framework 404 for a page outside the basePath", async () => {
    const res = await fetch(`${baseUrl}/hello`);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("Hello World");
    expect(text).not.toContain("public base URL");
  });

  // basepath.test.ts: "should serve public file with basePath correctly" and
  // "should 404 for public file without basePath"
  it("serves public files only under the basePath", async () => {
    const inside = await fetch(`${baseUrl}/base/data.txt`);
    expect(inside.status).toBe(200);
    expect(await inside.text()).toBe("hello world");

    const outside = await fetch(`${baseUrl}/data.txt`);
    expect(outside.status).toBe(404);
  });

  it("does not serve Vite modules outside the basePath", async () => {
    const res = await fetch(`${baseUrl}/@vite/client`);
    expect(res.status).toBe(404);
  });

  // redirect-and-rewrite.test.ts: "should rewrite with basePath by default",
  // "should not rewrite without basePath without disabling",
  // "should not rewrite with basePath when set to false" and
  // "should rewrite without basePath when set to false". Next.js only accepts
  // external destinations for `basePath: false` rewrites.
  it("applies rewrites on the matching side of the basePath", async () => {
    const inside = await fetch(`${baseUrl}/base/rewrite-1`);
    expect(inside.status).toBe(200);
    expect(await inside.text()).toContain("Hello World");

    const outsideDefault = await fetch(`${baseUrl}/rewrite-1`);
    expect(outsideDefault.status).toBe(404);

    const insideDisabled = await fetch(`${baseUrl}/base/proxy-no-basepath/api/items`);
    expect(insideDisabled.status).toBe(404);
    expect(await insideDisabled.text()).not.toContain("upstream");

    const outside = await fetch(`${baseUrl}/proxy-no-basepath/api/items?id=1`);
    expect(outside.status).toBe(200);
    expect(await outside.text()).toBe("upstream /api/items?id=1");
  });

  // redirect-and-rewrite.test.ts: "should redirect with basePath by default",
  // "should not redirect without basePath without disabling" and
  // "should redirect without basePath when set to false"
  it("applies redirects on the matching side of the basePath", async () => {
    const inside = await fetch(`${baseUrl}/base/redirect-1`, { redirect: "manual" });
    expect(inside.status).toBe(307);
    expect(new URL(inside.headers.get("location") ?? "", baseUrl).pathname).toBe(
      "/base/somewhere-else",
    );

    const outsideDefault = await fetch(`${baseUrl}/redirect-1`, { redirect: "manual" });
    expect(outsideDefault.status).toBe(404);

    const outside = await fetch(`${baseUrl}/redirect-no-basepath`, { redirect: "manual" });
    expect(outside.status).toBe(307);
    expect(new URL(outside.headers.get("location") ?? "", baseUrl).pathname).toBe(
      "/another-destination",
    );
  });

  // basepath.test.ts: "should add header with basePath by default",
  // "should not add header without basePath without disabling",
  // "should not add header with basePath when set to false" and
  // "should add header without basePath when set to false". Paths without a
  // page are 404s, which still carry the matched headers.
  it("applies headers on the matching side of the basePath", async () => {
    const cases: Array<[string, string | null]> = [
      ["/base/add-header", "world"],
      ["/add-header", null],
      ["/base/add-header-no-basepath", null],
      ["/add-header-no-basepath", "world"],
    ];
    for (const [pathname, expected] of cases) {
      const res = await fetch(`${baseUrl}${pathname}`);
      expect(res.status, pathname).toBe(404);
      expect(res.headers.get("x-hello"), pathname).toBe(expected);
    }
  });

  // Matches next@16.2.7: matcher-less middleware runs outside basePath with an
  // empty nextUrl.basePath, and its headers reach the 404.
  it("runs middleware on both sides of the basePath", async () => {
    const inside = await fetch(`${baseUrl}/base/hello`);
    expect(inside.headers.get("x-mw")).toBe("/base|/hello");

    for (const pathname of ["/hello", "/hello.json"]) {
      const outside = await fetch(`${baseUrl}${pathname}`);
      expect(outside.status, pathname).toBe(404);
      expect(outside.headers.get("x-mw"), pathname).toBe(`(none)|${pathname}`);
    }
  });

  // Matches next@16.2.7: a middleware rewrite claims a request outside basePath.
  it("serves a middleware rewrite from outside the basePath", async () => {
    const res = await fetch(`${baseUrl}/mw-rewrite-outside`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Hello World");
  });

  it.skipIf(appRouter)(
    "keeps a middleware-rewritten edge API request outside the basePath",
    async () => {
      const res = await fetch(`${baseUrl}/mw-rewrite-edge-outside`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ basePath: "", pathname: "/mw-rewrite-edge-outside" });
    },
  );

  // Routing classifies the canonical pathname, so dot segments that resolve
  // into the basePath are inside it. fetch() and URL strings canonicalize the
  // path client-side, so send it raw.
  it("classifies a dot-segment path by where it resolves", async () => {
    const { status, body } = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const { hostname, port } = new URL(baseUrl);
        const req = http.get({ hostname, port, path: "/outside/%2e%2e/base/hello" }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
      },
    );
    expect(status).toBe(200);
    expect(body).toContain("Hello World");
  });

  // Matches next@16.2.7: the trailing-slash redirect outside basePath keeps
  // the request outside it.
  it("redirects trailing slashes outside the basePath without adding it", async () => {
    const res = await fetch(`${baseUrl}/hello/`, { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(new URL(res.headers.get("location") ?? "", baseUrl).pathname).toBe("/hello");
  });
});

// Connect strips a mount prefix from req.url and keeps the full URL in
// req.originalUrl. Pages Router routing must use the mount-relative URL. App
// Router requests are dispatched by @vitejs/plugin-rsc, which restores
// req.originalUrl, so mounting below a route does not apply to them.
describe("dev basePath boundary mounted in middleware mode (Pages Router)", () => {
  const dir = FIXTURES[1].dir;
  let root: string;
  let server: ViteDevServer;
  let httpServer: http.Server;
  let mountUrl: string;

  beforeAll(async () => {
    root = await createIsolatedFixture(dir, "vinext-basepath-outside-mounted-");
    server = await createServer({
      root,
      cacheDir: testCacheDir(root),
      configFile: false,
      appType: "custom",
      plugins: [
        {
          // A plugin ordered before vinext whose post middleware must keep
          // running for requests outside basePath.
          name: "test-post-middleware",
          configureServer(viteServer) {
            return () => {
              // Named like Vite's own middlewares, which vinext must not
              // mistake it for.
              viteServer.middlewares.use(function viteAuditMiddleware(_req, res, next) {
                res.setHeader("x-plugin-post", "1");
                next();
              });
            };
          },
        },
        vinext({ appDir: root }),
      ],
      optimizeDeps: { holdUntilCrawlEnd: true },
      server: { middlewareMode: true },
      logLevel: "silent",
    });
    httpServer = http.createServer((req, res) => {
      const url = req.url ?? "/";
      if (!url.startsWith("/mount/")) {
        res.writeHead(418).end();
        return;
      }
      Object.assign(req, { originalUrl: url, url: url.slice("/mount".length) });
      server.middlewares(req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    mountUrl = `http://127.0.0.1:${address.port}/mount`;
  }, 60000);

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    await server?.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("routes requests outside the basePath by their mount-relative URL", async () => {
    const page = await fetch(`${mountUrl}/base/hello`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Hello World");

    const rewrite = await fetch(`${mountUrl}/proxy-no-basepath/api/items?id=1`);
    expect(rewrite.status).toBe(200);
    expect(await rewrite.text()).toBe("upstream /api/items?id=1");

    const header = await fetch(`${mountUrl}/add-header-no-basepath`);
    expect(header.status).toBe(404);
    expect(header.headers.get("x-hello")).toBe("world");
    expect(header.headers.get("x-mw")).toBe("(none)|/add-header-no-basepath");
  });

  it("keeps running post middlewares of plugins ordered before vinext", async () => {
    for (const pathname of ["/base/hello", "/hello"]) {
      const res = await fetch(`${mountUrl}${pathname}`);
      expect(res.headers.get("x-plugin-post"), pathname).toBe("1");
    }
  });
});
