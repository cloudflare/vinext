// A path a `fallback: false` page does not list goes on to the next matching
// dynamic route, as in Next.js: the page throws `NoFallbackError` and the
// router handles the request again without the pages it already tried.
// Ported from Next.js: test/e2e/dynamic-optional-routing/dynamic-optional-routing.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/dynamic-optional-routing/dynamic-optional-routing.test.ts
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/router-server.ts
import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { build } from "vite-plus";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { buildPagesFixture, createIsolatedFixture, startFixtureServer } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/pages-fallback-false-next-route");
const REWRITE_FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "fixtures/pages-fallback-false-rewrite",
);
const STATIC_REWRITE_FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "fixtures/pages-fallback-false-static-rewrite",
);

async function buildPagesApp(root: string, outDir: string): Promise<void> {
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [vinext({ disableAppRouter: true })],
    build: {
      outDir: path.join(outDir, "server"),
      ssr: "virtual:vinext-server-entry",
      rolldownOptions: { output: { entryFileNames: "entry.js" } },
    },
  });
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [vinext({ disableAppRouter: true })],
    build: {
      outDir: path.join(outDir, "client"),
      manifest: true,
      ssrManifest: true,
      rolldownOptions: { input: "virtual:vinext-client-entry" },
    },
  });
}

function routeText(html: string): string | undefined {
  return html
    .match(/<div id="route">([\s\S]*?)<\/div>/)?.[1]
    .replaceAll("<!-- -->", "")
    .replace(/\s+/g, " ");
}

function buildIdOf(html: string): string {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]*)<\/script>/);
  if (!match) throw new Error("Missing __NEXT_DATA__");
  return JSON.parse(match[1]).buildId;
}

type Target = { baseUrl: string; close: () => Promise<void> };

const targetsFor = (fixtureDir: string): Array<[string, () => Promise<Target>]> => [
  [
    "dev",
    async () => {
      const { server, baseUrl } = await startFixtureServer(fixtureDir);
      return { baseUrl, close: () => server.close() };
    },
  ],
  [
    "production",
    async () => {
      const root = await createIsolatedFixture(fixtureDir, "vinext-pages-fallback-false-");
      const outDir = path.join(root, "dist");
      await buildPagesApp(root, outDir);
      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      const { server } = await startProdServer({ host: "127.0.0.1", port: 0, outDir });
      const address = (server as http.Server).address();
      if (!address || typeof address === "string") throw new Error("Server did not bind");
      return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        async close() {
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await fs.rm(root, { recursive: true, force: true });
        },
      };
    },
  ],
];

describe.each(targetsFor(FIXTURE_DIR))("Pages fallback: false miss (%s)", (_name, start) => {
  let target: Target;

  beforeAll(async () => {
    target = await start();
  }, 120_000);

  afterAll(async () => {
    await target?.close();
  });

  async function render(pathname: string): Promise<{ status: number; html: string }> {
    const response = await fetch(`${target.baseUrl}${pathname}`);
    return { status: response.status, html: await response.text() };
  }

  it("renders the top-level optional catch-all for a path the page does not list", async () => {
    const { status, html } = await render("/get-static-paths/hello/world");
    expect(status).toBe(200);
    expect(routeText(html)).toBe("top level route param: [get-static-paths|hello|world]");
    expect(html).toContain('<div id="asPath">/get-static-paths/hello/world</div>');
  });

  it("routes past the rejecting page before rendering any error page", async () => {
    // The fixture's 404 page throws for any path but its own.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const pathname of ["/get-static-paths/hello/world", "/chain/unlisted"]) {
        expect((await render(pathname)).status).toBe(200);
      }
      expect(errors.mock.calls.flat().join("\n")).not.toContain("404 page rendered");
    } finally {
      errors.mockRestore();
    }
  });

  it("sends the middleware headers once on the resumed response", async () => {
    const response = await fetch(`${target.baseUrl}/chain/unlisted`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-fixture-middleware")).toBe("1");
    expect(response.headers.getSetCookie()).toEqual(["mw=1; Path=/"]);
  });

  it("still renders a listed path from the fallback: false page", async () => {
    const root = await render("/get-static-paths");
    expect(root.status).toBe(200);
    expect(routeText(root.html)).toBe("gsp route: undefined");

    const listed = await render("/get-static-paths/p2/p3");
    expect(listed.status).toBe(200);
    expect(routeText(listed.html)).toBe("gsp route: [p2|p3]");
  });

  it("skips every fallback: false route that rejects the path", async () => {
    const miss = await render("/chain/unlisted");
    expect(miss.status).toBe(200);
    expect(routeText(miss.html)).toBe("top level route param: [chain|unlisted]");

    const slug = await render("/chain/slug-listed");
    expect(routeText(slug.html)).toBe("chain slug: slug-listed");

    const rest = await render("/chain/rest-listed");
    expect(routeText(rest.html)).toBe("chain rest: [rest-listed]");
  });

  it("keeps the next route's getStaticProps render out of the pathname ISR entry", async () => {
    // vinext keys Pages ISR entries by pathname, while Next.js keys them by the
    // owning route. Storing this render would let `isr/[slug]` admit the path
    // from that entry and regenerate it as its own page.
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${target.baseUrl}/isr/unlisted`);
      expect(response.status).toBe(200);
      expect(routeText(await response.text())).toBe("isr rest: [unlisted]");
      expect(response.headers.get("x-vinext-cache")).not.toBe("HIT");
    }

    const listed = await render("/isr/slug-listed");
    expect(routeText(listed.html)).toBe("isr slug: slug-listed");
  });

  it("answers a data request with the next matching route's props", async () => {
    const { html } = await render("/");
    const response = await fetch(
      `${target.baseUrl}/_next/data/${buildIdOf(html)}/get-static-paths/hello/world.json`,
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { pageProps: { query: { optionalName?: string[] } } };
    expect(data.pageProps.query.optionalName).toEqual(["get-static-paths", "hello", "world"]);
  });
});

describe("Pages fallback: false miss (dev, after other connect middleware)", () => {
  let target: Target;

  beforeAll(async () => {
    const { server, baseUrl } = await startFixtureServer(FIXTURE_DIR, {
      prependPlugins: [
        {
          name: "outer-set-cookie",
          configureServer(server) {
            server.middlewares.use((_req, res, next) => {
              res.setHeader("set-cookie", ["outer=1; Path=/"]);
              next();
            });
          },
        },
      ],
    });
    target = { baseUrl, close: () => server.close() };
  }, 120_000);

  afterAll(async () => {
    await target?.close();
  });

  it("keeps header values set before the middleware headers", async () => {
    const response = await fetch(`${target.baseUrl}/chain/unlisted`);
    expect(response.status).toBe(200);
    expect(routeText(await response.text())).toBe("top level route param: [chain|unlisted]");
    expect(response.headers.getSetCookie()).toEqual(["outer=1; Path=/", "mw=1; Path=/"]);
  });
});

// Ported from Next.js: test/e2e/fallback-false-rewrite/fallback-false-rewrite.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/fallback-false-rewrite/fallback-false-rewrite.test.ts
// The rewritten cases leave out Next.js's `query.path` array: vinext merges a
// `:path*` rewrite param into the query as one string, a separate gap.
describe.each(targetsFor(REWRITE_FIXTURE_DIR))(
  "Pages fallback: false rewrite (%s)",
  (_name, start) => {
    let target: Target;

    beforeAll(async () => {
      target = await start();
    }, 120_000);

    afterAll(async () => {
      await target?.close();
    });

    async function render(pathname: string) {
      const response = await fetch(`${target.baseUrl}${pathname}`, { redirect: "manual" });
      const html = await response.text();
      const text = (id: string) =>
        html.match(new RegExp(`<p id="${id}">([\\s\\S]*?)</p>`))?.[1].replaceAll("<!-- -->", "");
      const query = text("query");
      return {
        status: response.status,
        another: text("another"),
        slug: text("slug"),
        query: query === undefined ? undefined : JSON.parse(query.replaceAll("&quot;", '"')),
      };
    }

    it("should rewrite correctly for path at same level as fallback: false SSR", async () => {
      expect(await render("/hello")).toMatchObject({ status: 200, another: "another" });
    });

    it("should rewrite correctly for path above fallback: false SSR", async () => {
      expect(await render("/hello/world")).toMatchObject({ status: 200, another: "another" });
    });

    it("should not rewrite for path from fallback: false SSR", async () => {
      const page = await render("/first");
      expect(page.status).toBe(200);
      expect(page.slug).toContain("hello");
      expect(page.query).toEqual({ slug: "first" });
    });

    it("should behave properly when accessing the dynamic param directly", async () => {
      expect(await render("/[slug]")).toMatchObject({ status: 200, another: "another" });
    });
  },
);

// After the catch-all rejects the path, the fallback rewrite reaches a missing
// build asset, which gets the static-file 404 rather than a page 404.
describe.each(targetsFor(STATIC_REWRITE_FIXTURE_DIR))(
  "Pages fallback: false rewrite to a missing build asset (%s)",
  (_name, start) => {
    let target: Target;

    beforeAll(async () => {
      target = await start();
    }, 120_000);

    afterAll(async () => {
      await target?.close();
    });

    it("serves the static-file 404", async () => {
      const response = await fetch(`${target.baseUrl}/unlisted`, { redirect: "manual" });

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("text/plain");
      await expect(response.text()).resolves.toBe("Not Found");
    });

    it("still renders a listed path", async () => {
      const response = await fetch(`${target.baseUrl}/listed`);

      expect(response.status).toBe(200);
      expect(routeText(await response.text())).toBe("catch-all: listed");
    });
  },
);

describe("Pages fallback: false miss during build prerender", () => {
  let pagesBundlePath: string;
  const pagesDir = path.join(FIXTURE_DIR, "pages");

  beforeAll(async () => {
    pagesBundlePath = await buildPagesFixture(FIXTURE_DIR);
  }, 120_000);

  afterAll(async () => {
    if (pagesBundlePath) {
      await fs.rm(path.dirname(path.dirname(pagesBundlePath)), { recursive: true, force: true });
    }
  });

  it("leaves a path the next route lists to runtime instead of packaging it", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-fallback-false-out-"));
    try {
      const { prerenderPages } = await import("../packages/vinext/src/build/prerender.js");
      const { pagesRouter, apiRouter } =
        await import("../packages/vinext/src/routing/pages-router.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const result = await prerenderPages({
        mode: "default",
        pagesBundlePath,
        routes: await pagesRouter(pagesDir),
        apiRoutes: await apiRouter(pagesDir),
        pagesDir,
        outDir,
        config: await resolveNextConfig({}),
      });

      const byPath = (urlPath: string) =>
        result.routes.find((route) => "path" in route && route.path === urlPath);
      expect(byPath("/isr/slug-listed")).toMatchObject({ status: "rendered" });
      expect(byPath("/get-static-paths/p1")).toMatchObject({ status: "rendered" });
      // `/isr/rest-listed` reaches `isr/[...rest]` only past `isr/[slug]`,
      // as do its redirect and `notFound` paths.
      expect(byPath("/isr/rest-listed")).toBeUndefined();
      expect(byPath("/isr/rest-redirect")).toBeUndefined();
      expect(byPath("/isr/rest-not-found")).toBeUndefined();
      // Error results carry no path, so check none was recorded.
      expect(result.routes.filter((route) => route.status === "error")).toEqual([]);
      expect(result.routes).toContainEqual({
        route: "/isr/:rest+",
        status: "skipped",
        reason: "dynamic",
      });
      await expect(fs.access(path.join(outDir, "isr/rest-listed.html"))).rejects.toThrow();
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("assigns a warm path to the route that answers it past a rejecting page", async () => {
    // Cache warming probes each path as the route recorded for it, so a path
    // `isr/[slug]` hands to `isr/[...rest]` belongs to `isr/[...rest]`.
    const { discoverPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
    const manifest = await discoverPrerenderPathManifest({
      root: FIXTURE_DIR,
      appDir: null,
      pagesDir,
      pagesBundlePath,
      nextConfig: await resolveNextConfig({}),
      // Another spelling of a listed path, which `isr/[slug]` admits at runtime.
      candidatePaths: ["/isr/%73lug-listed"],
    });

    expect(manifest?.routePatterns?.["/isr/rest-listed"]).toMatchObject({
      kind: "pages-page",
      pattern: "/isr/:rest+",
    });
    expect(manifest?.routePatterns?.["/isr/slug-listed"]).toMatchObject({
      kind: "pages-page",
      pattern: "/isr/:slug",
    });
    expect(manifest?.routePatterns?.["/isr/%73lug-listed"]).toMatchObject({
      pattern: "/isr/:slug",
    });
    expect(manifest?.routePatterns?.["/chain/rest-listed"]).toMatchObject({
      pattern: "/chain/:rest+",
    });
  }, 120_000);

  it("reads an unprefixed warm path in the default locale of the host warm-up targets", async () => {
    // Runtime reads an unprefixed request on `fr.example` as French, while a
    // listed path without a locale is in the global default (`en`).
    const { pagesListingKey, resolvePagesWarmRouteMetadata } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const i18n = {
      locales: ["en", "fr"],
      defaultLocale: "en",
      domains: [{ domain: "fr.example", defaultLocale: "fr" }],
    };
    const noFallbackListings = new Map([
      ["/isr/:slug", new Set([pagesListingKey("/isr/slug-listed", i18n)])],
    ]);
    const resolve = (requestHostname?: string) =>
      resolvePagesWarmRouteMetadata({
        i18n,
        requestHostname,
        pagesDir,
        pageExtensions: ["tsx", "ts", "jsx", "js"],
        paths: ["/isr/slug-listed", "/en/isr/slug-listed"],
        noFallbackListings,
      });

    const onFrench = await resolve("fr.example");
    expect(onFrench.routePatterns["/isr/slug-listed"]?.pattern).toBe("/isr/:rest+");
    expect(onFrench.routePatterns["/en/isr/slug-listed"]?.pattern).toBe("/isr/:slug");
    // Its data target carries `/en`, which `isr/[slug]` admits.
    expect([...onFrench.localeDependentPaths]).toEqual(["/isr/slug-listed"]);
    // Its probe then classifies `isr/[slug]`, not the HTML owner.
    expect(onFrench.dataRoutePatterns).toEqual({
      "/isr/slug-listed": { kind: "pages-page", pattern: "/isr/:slug" },
    });
    const onDefault = await resolve("staged.example.workers.dev");
    expect(onDefault.routePatterns["/isr/slug-listed"]?.pattern).toBe("/isr/:slug");
    expect(onDefault.localeDependentPaths.size).toBe(0);
    expect(onDefault.dataRoutePatterns).toEqual({});
  });

  it("matches warm paths against listings in the locale space runtime admission uses", async () => {
    const { discoverPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
    const manifest = await discoverPrerenderPathManifest({
      root: FIXTURE_DIR,
      appDir: null,
      pagesDir,
      pagesBundlePath,
      nextConfig: await resolveNextConfig({ i18n: { locales: ["en", "fr"], defaultLocale: "en" } }),
      candidatePaths: ["/en/isr/slug-listed", "/fr/isr/slug-listed"],
    });

    // `isr/[slug]` lists `slug-listed` in the default locale, which runtime
    // admits with or without the `/en` prefix, but not as French.
    expect(manifest?.routePatterns?.["/en/isr/slug-listed"]).toMatchObject({
      pattern: "/isr/:slug",
    });
    expect(manifest?.routePatterns?.["/fr/isr/slug-listed"]).toMatchObject({
      pattern: "/isr/:rest+",
    });
  }, 120_000);
});

describe("Pages fallback: false rewrite during warm-path discovery", () => {
  let pagesBundlePath: string;
  const pagesDir = path.join(REWRITE_FIXTURE_DIR, "pages");

  beforeAll(async () => {
    pagesBundlePath = await buildPagesFixture(REWRITE_FIXTURE_DIR);
  }, 120_000);

  afterAll(async () => {
    if (pagesBundlePath) {
      await fs.rm(path.dirname(path.dirname(pagesBundlePath)), { recursive: true, force: true });
    }
  });

  async function discover(options: {
    requestRouting?: "uncached-stage";
    responseVary?: "verbatim";
  }) {
    const { discoverPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
    return discoverPrerenderPathManifest({
      root: REWRITE_FIXTURE_DIR,
      appDir: null,
      pagesDir,
      pagesBundlePath,
      nextConfig: await resolveNextConfig({
        rewrites: async () => ({
          beforeFiles: [],
          afterFiles: [{ source: "/start/here", destination: "/hello" }],
          fallback: [{ source: "/:path*", destination: "/another" }],
        }),
      }),
      // `[slug]` rejects `/hello`, so the fallback rewrite answers it, also
      // when an afterFiles rewrite of `/start/here` leads there.
      candidatePaths: ["/hello", "/start/here"],
      ...options,
    });
  }

  it("lets the request stage resolve a path every route rejects to a fallback rewrite", async () => {
    const manifest = await discover({ requestRouting: "uncached-stage" });

    expect(manifest?.routePatterns?.["/hello"]?.cacheabilityProbe).toMatchObject({
      routeMayResolve: true,
      // The rewrite may also land on a public file, served by request routing.
      requestStageMayTerminate: true,
    });
    expect(manifest?.routePatterns?.["/start/here"]?.cacheabilityProbe).toMatchObject({
      routeMayResolve: true,
      requestStageMayTerminate: true,
    });
    expect(manifest?.routePatterns?.["/first"]?.cacheabilityProbe?.routeMayResolve).toBeFalsy();
    expect(
      manifest?.routePatterns?.["/first"]?.cacheabilityProbe?.requestStageMayTerminate,
    ).toBeFalsy();
  }, 120_000);

  it("treats a path one locale exhausts as resolvable for both representations", async () => {
    // On `fr.example`, `[slug]` rejects the French `/first` and nothing else
    // matches, while it admits the data target, which carries `/en`.
    const { pagesListingKey, resolvePagesWarmRouteMetadata } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const i18n = {
      locales: ["en", "fr"],
      defaultLocale: "en",
      domains: [{ domain: "fr.example", defaultLocale: "fr" }],
    };
    const metadata = await resolvePagesWarmRouteMetadata({
      i18n,
      requestHostname: "fr.example",
      pagesDir,
      pageExtensions: ["tsx", "ts", "jsx", "js"],
      paths: ["/first"],
      noFallbackListings: new Map([["/:slug", new Set([pagesListingKey("/first", i18n)])]]),
    });

    expect(metadata.routePatterns["/first"]?.pattern).toBe("/:slug");
    expect([...metadata.exhaustedPaths]).toEqual(["/first"]);
    expect([...metadata.localeDependentPaths]).toEqual(["/first"]);
    // The data target reaches `[slug]`, a getStaticProps page.
    expect(metadata.dataPaths).toEqual(["/first"]);
  });

  it("drops a path a fallback rewrite answers when responses vary verbatim", async () => {
    const manifest = await discover({ responseVary: "verbatim" });

    expect(manifest?.routePatterns?.["/hello"]).toBeUndefined();
    expect(manifest?.routePatterns?.["/first"]).toMatchObject({ pattern: "/:slug" });
  }, 120_000);
});
