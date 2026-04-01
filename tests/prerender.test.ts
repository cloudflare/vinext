/**
 * Prerender phase tests.
 *
 * Tests assert the **structural output** of prerendering — which routes were
 * rendered, which were skipped, which errored, and what files were produced.
 * Tests do NOT assert on raw HTML content (that belongs to E2E/Playwright).
 *
 * Both `prerenderPages()` and `prerenderApp()` are tested against the
 * `pages-basic` and `app-basic` fixtures respectively.
 */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPagesFixture, buildAppFixture, buildCloudflareAppFixture } from "./helpers.js";
import {
  resolveParentParams,
  type PrerenderRouteResult,
  type StaticParamsMap,
} from "../packages/vinext/src/build/prerender.js";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";

const PAGES_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/pages-basic");
const APP_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/app-basic");
const CF_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/cf-app-basic");

// ─── Helper ──────────────────────────────────────────────────────────────────

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function findRoute(
  results: PrerenderRouteResult[],
  route: string,
): PrerenderRouteResult | undefined {
  return results.find((r) => r.route === route || ("path" in r && r.path === route));
}

// ─── Pages Router ─────────────────────────────────────────────────────────────

describe("prerenderPages — default mode (pages-basic)", () => {
  let outDir: string;
  let results: PrerenderRouteResult[];

  beforeAll(async () => {
    const pagesBundlePath = await buildPagesFixture(PAGES_FIXTURE);
    outDir = tmpDir("vinext-prerender-pages-");

    const { prerenderPages } = await import("../packages/vinext/src/build/prerender.js");
    const { pagesRouter, apiRouter } =
      await import("../packages/vinext/src/routing/pages-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    const pagesDir = path.resolve(PAGES_FIXTURE, "pages");
    const pageRoutes = await pagesRouter(pagesDir);
    const apiRoutes = await apiRouter(pagesDir);
    const config = await resolveNextConfig({});

    const prerenderResult = await prerenderPages({
      mode: "default",
      pagesBundlePath,
      routes: pageRoutes,
      apiRoutes,
      pagesDir,
      outDir,
      config,
    });
    results = prerenderResult.routes;
  }, 60_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  // ── Static pages ───────────────────────────────────────────────────────────

  it("renders static index page", () => {
    const r = findRoute(results, "/");
    expect(r).toMatchObject({
      route: "/",
      status: "rendered",
      revalidate: false,
    });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("index.html");
    }
  });

  it("renders static about page", () => {
    const r = findRoute(results, "/about");
    expect(r).toMatchObject({ route: "/about", status: "rendered", revalidate: false });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("about.html");
    }
  });

  it("renders 404 page", () => {
    const r = findRoute(results, "/404");
    expect(r).toMatchObject({ route: "/404", status: "rendered", revalidate: false });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("404.html");
    }
  });

  // ── Dynamic routes with getStaticPaths ────────────────────────────────────

  it("renders static dynamic routes from getStaticPaths (fallback: false)", () => {
    const slugs = ["hello-world", "getting-started"];
    for (const slug of slugs) {
      const r = findRoute(results, `/blog/${slug}`);
      expect(r).toMatchObject({
        route: "/blog/:slug",
        path: `/blog/${slug}`,
        status: "rendered",
        revalidate: false,
      });
      if (r?.status === "rendered") {
        expect(r.outputFiles).toContain(`blog/${slug}.html`);
      }
    }
  });

  it("renders dynamic routes from getStaticPaths (fallback: 'blocking')", () => {
    const ids = ["1", "2"];
    for (const id of ids) {
      const r = findRoute(results, `/articles/${id}`);
      expect(r).toMatchObject({
        route: "/articles/:id",
        path: `/articles/${id}`,
        status: "rendered",
        revalidate: false,
      });
    }
  });

  // ── ISR page ───────────────────────────────────────────────────────────────

  it("renders ISR page with correct revalidate interval", () => {
    const r = findRoute(results, "/isr-test");
    expect(r).toMatchObject({ route: "/isr-test", status: "rendered", revalidate: 1 });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("isr-test.html");
    }
  });

  // ── SSR pages — skipped ────────────────────────────────────────────────────

  it("skips SSR pages (getServerSideProps) in default mode", () => {
    const ssrRoutes = ["/ssr", "/ssr-headers"];
    for (const route of ssrRoutes) {
      const r = findRoute(results, route);
      expect(r).toMatchObject({ route, status: "skipped", reason: "ssr" });
    }
  });

  it("skips getServerSideProps dynamic route in default mode", () => {
    // posts/[id] has getServerSideProps — pattern is /posts/:id
    const ssrRoute = results.find(
      (r) =>
        r.status === "skipped" &&
        "reason" in r &&
        r.reason === "ssr" &&
        r.route.startsWith("/posts"),
    );
    expect(ssrRoute).toBeDefined();
  });

  // ── API routes — always skipped ────────────────────────────────────────────

  it("skips all API routes", () => {
    const apiResults = results.filter(
      (r) => r.status === "skipped" && "reason" in r && r.reason === "api",
    );
    expect(apiResults.length).toBeGreaterThan(0);
    // hello API is a known API route
    const hello = findRoute(results, "/api/hello");
    expect(hello).toMatchObject({ route: "/api/hello", status: "skipped", reason: "api" });
  });

  // ── Written files ──────────────────────────────────────────────────────────

  it("writes HTML files to outDir", () => {
    expect(fs.existsSync(path.join(outDir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "about.html"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "isr-test.html"))).toBe(true);
  });

  // ── vinext-prerender.json ─────────────────────────────────────────────────

  it("writes vinext-prerender.json with correct structure", () => {
    const indexPath = path.join(outDir, "vinext-prerender.json");
    expect(fs.existsSync(indexPath)).toBe(true);

    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    expect(Array.isArray(index.routes)).toBe(true);

    // Check a rendered entry
    const home = index.routes.find((r: any) => r.route === "/");
    expect(home).toMatchObject({ route: "/", status: "rendered", revalidate: false });
    // outputFiles not in index (stripped)
    expect(home.outputFiles).toBeUndefined();

    // Check ISR entry
    const isr = index.routes.find((r: any) => r.route === "/isr-test");
    expect(isr).toMatchObject({ route: "/isr-test", status: "rendered", revalidate: 1 });

    // Check a skipped entry
    const ssr = index.routes.find((r: any) => r.route === "/ssr");
    expect(ssr).toMatchObject({ route: "/ssr", status: "skipped", reason: "ssr" });
  });
});

describe("prerenderPages — export mode (pages-basic)", () => {
  let outDir: string;
  let results: PrerenderRouteResult[];

  beforeAll(async () => {
    const pagesBundlePath = await buildPagesFixture(PAGES_FIXTURE);
    outDir = tmpDir("vinext-prerender-pages-export-");

    const { prerenderPages } = await import("../packages/vinext/src/build/prerender.js");
    const { pagesRouter, apiRouter } =
      await import("../packages/vinext/src/routing/pages-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    const pagesDir = path.resolve(PAGES_FIXTURE, "pages");
    const pageRoutes = await pagesRouter(pagesDir);
    const apiRoutes = await apiRouter(pagesDir);
    const config = await resolveNextConfig({ output: "export" });

    const prerenderResult = await prerenderPages({
      mode: "export",
      pagesBundlePath,
      routes: pageRoutes,
      apiRoutes,
      pagesDir,
      outDir,
      config,
    });
    results = prerenderResult.routes;
  }, 60_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("renders static and ISR routes (ISR treated as static)", () => {
    expect(findRoute(results, "/")).toMatchObject({ status: "rendered", revalidate: false });
    expect(findRoute(results, "/about")).toMatchObject({ status: "rendered", revalidate: false });
    // ISR route in export mode: revalidate ignored → false
    expect(findRoute(results, "/isr-test")).toMatchObject({
      status: "rendered",
      revalidate: false,
    });
  });

  it("errors on SSR pages in export mode", () => {
    const ssr = findRoute(results, "/ssr");
    expect(ssr).toMatchObject({ status: "error" });
    if (ssr?.status === "error") {
      expect(ssr.error).toMatch(/getServerSideProps/);
    }
  });
});

// ─── App Router ───────────────────────────────────────────────────────────────

describe("prerenderApp — default mode (app-basic)", () => {
  let outDir: string;
  let results: PrerenderRouteResult[];

  beforeAll(async () => {
    const rscBundlePath = await buildAppFixture(APP_FIXTURE);
    outDir = tmpDir("vinext-prerender-app-");

    const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
    const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    const appDir = path.resolve(APP_FIXTURE, "app");
    const routes = await appRouter(appDir);
    const config = await resolveNextConfig({});

    const prerenderResult = await prerenderApp({
      mode: "default",
      rscBundlePath,
      routes,
      outDir,
      config,
    });
    results = prerenderResult.routes;
  }, 120_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  // ── Static routes with explicit config ────────────────────────────────────

  it("renders force-static page", () => {
    const r = findRoute(results, "/static-test");
    expect(r).toMatchObject({ route: "/static-test", status: "rendered", revalidate: false });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("static-test.html");
      expect(r.outputFiles).toContain("static-test.rsc");
    }
  });

  it("renders revalidate=Infinity page as static", () => {
    const r = findRoute(results, "/revalidate-infinity-test");
    expect(r).toMatchObject({ status: "rendered", revalidate: false });
  });

  // ── ISR routes ─────────────────────────────────────────────────────────────

  it("renders ISR page with revalidate=1", () => {
    const r = findRoute(results, "/isr-test");
    expect(r).toMatchObject({ route: "/isr-test", status: "rendered", revalidate: 1 });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("isr-test.html");
      expect(r.outputFiles).toContain("isr-test.rsc");
    }
  });

  it("renders ISR page with revalidate=60", () => {
    const r = findRoute(results, "/revalidate-test");
    expect(r).toMatchObject({ route: "/revalidate-test", status: "rendered", revalidate: 60 });
  });

  // ── Dynamic routes — skipped ───────────────────────────────────────────────

  it("skips force-dynamic page", () => {
    const r = findRoute(results, "/dynamic-test");
    expect(r).toMatchObject({ route: "/dynamic-test", status: "skipped", reason: "dynamic" });
  });

  it("skips revalidate=0 page", () => {
    const r = findRoute(results, "/revalidate-zero-test");
    expect(r).toMatchObject({ status: "skipped", reason: "dynamic" });
  });

  // ── Dynamic routes with generateStaticParams ───────────────────────────────

  it("renders /blog/[slug] expanded paths", () => {
    const slugs = ["hello-world", "getting-started", "advanced-guide"];
    for (const slug of slugs) {
      const r = findRoute(results, `/blog/${slug}`);
      expect(r).toMatchObject({
        route: "/blog/:slug",
        path: `/blog/${slug}`,
        status: "rendered",
        revalidate: false,
      });
      if (r?.status === "rendered") {
        expect(r.outputFiles).toContain(`blog/${slug}.html`);
        expect(r.outputFiles).toContain(`blog/${slug}.rsc`);
      }
    }
  });

  it("renders /products/[id] expanded paths", () => {
    for (const id of ["1", "2", "3"]) {
      const r = findRoute(results, `/products/${id}`);
      expect(r).toMatchObject({
        route: "/products/:id",
        path: `/products/${id}`,
        status: "rendered",
        revalidate: false,
      });
    }
  });

  it("renders /shop/[category] expanded paths", () => {
    for (const category of ["electronics", "clothing"]) {
      const r = findRoute(results, `/shop/${category}`);
      expect(r).toMatchObject({
        route: "/shop/:category",
        path: `/shop/${category}`,
        status: "rendered",
        revalidate: false,
      });
    }
  });

  it("renders /shop/[category]/[item] top-down params (nested generateStaticParams)", () => {
    const paths = [
      "/shop/electronics/phone",
      "/shop/electronics/laptop",
      "/shop/clothing/shirt",
      "/shop/clothing/pants",
    ];
    for (const urlPath of paths) {
      const r = findRoute(results, urlPath);
      expect(r).toMatchObject({
        route: "/shop/:category/:item",
        path: urlPath,
        status: "rendered",
        revalidate: false,
      });
    }
  });

  it("skips dynamic routes without generateStaticParams", () => {
    // /photos/[id] has no generateStaticParams
    const r = results.find(
      (r) =>
        r.status === "skipped" &&
        "reason" in r &&
        r.reason === "no-static-params" &&
        r.route.startsWith("/photos"),
    );
    expect(r).toBeDefined();
  });

  // ── Speculative rendering: unknown routes ──────────────────────────────────

  it("renders / speculatively (unknown route with no dynamic APIs)", () => {
    const r = findRoute(results, "/");
    expect(r).toMatchObject({ route: "/", status: "rendered", revalidate: false });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("index.html");
      expect(r.outputFiles).toContain("index.rsc");
    }
  });

  it("renders /about speculatively", () => {
    const r = findRoute(results, "/about");
    expect(r).toMatchObject({ route: "/about", status: "rendered", revalidate: false });
  });

  it("renders /dashboard speculatively", () => {
    const r = findRoute(results, "/dashboard");
    expect(r).toMatchObject({ route: "/dashboard", status: "rendered", revalidate: false });
  });

  it("skips /headers-test (unknown route that calls headers())", () => {
    const r = findRoute(results, "/headers-test");
    // headers-test calls headers() — should be skipped as dynamic
    expect(r).toBeDefined();
    expect(r?.status).toBe("skipped");
  });

  // ── API routes — always skipped ────────────────────────────────────────────

  it("skips all API route handlers", () => {
    const apiSkipped = results.filter(
      (r) => r.status === "skipped" && "reason" in r && r.reason === "api",
    );
    expect(apiSkipped.length).toBeGreaterThan(0);

    // Known API routes
    const hello = findRoute(results, "/api/hello");
    expect(hello).toMatchObject({ status: "skipped", reason: "api" });
  });

  // ── Written files ──────────────────────────────────────────────────────────

  it("writes HTML and RSC files to outDir", () => {
    expect(fs.existsSync(path.join(outDir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "index.rsc"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "static-test.html"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "static-test.rsc"))).toBe(true);
  });

  it("writes blog expanded pages to correct paths", () => {
    expect(fs.existsSync(path.join(outDir, "blog/hello-world.html"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "blog/hello-world.rsc"))).toBe(true);
  });

  // ── vinext-prerender.json ─────────────────────────────────────────────────

  it("writes vinext-prerender.json with correct structure", () => {
    const indexPath = path.join(outDir, "vinext-prerender.json");
    expect(fs.existsSync(indexPath)).toBe(true);

    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    expect(Array.isArray(index.routes)).toBe(true);

    // Rendered routes present — for dynamic routes the manifest has both route (pattern) and path (concrete URL)
    const rendered = index.routes
      .filter((r: any) => r.status === "rendered")
      .map((r: any) => r.path ?? r.route);
    expect(rendered).toContain("/");
    expect(rendered).toContain("/blog/hello-world");
    expect(rendered).toContain("/blog/getting-started");
    expect(rendered).toContain("/blog/advanced-guide");
    expect(rendered).toContain("/products/1");
    expect(rendered).toContain("/products/2");
    expect(rendered).toContain("/products/3");
    expect(rendered).toContain("/shop/electronics");
    expect(rendered).toContain("/shop/clothing");
    expect(rendered).toContain("/shop/electronics/phone");

    // ISR route has correct revalidate
    const isrTest = index.routes.find((r: any) => r.route === "/isr-test");
    expect(isrTest).toMatchObject({ route: "/isr-test", status: "rendered", revalidate: 1 });

    // outputFiles not in index
    expect(isrTest?.outputFiles).toBeUndefined();

    // Skipped route present
    const dynamic = index.routes.find((r: any) => r.route === "/dynamic-test");
    expect(dynamic).toMatchObject({ route: "/dynamic-test", status: "skipped", reason: "dynamic" });
  });
});

// ─── Hybrid: runPrerender with app/ + pages/ ──────────────────────────────────

describe("runPrerender — hybrid app+pages (app-basic)", () => {
  let manifestDir: string;
  let results: PrerenderRouteResult[];

  beforeAll(async () => {
    const pagesBundlePath = await buildPagesFixture(APP_FIXTURE);
    manifestDir = tmpDir("vinext-prerender-hybrid-");

    // runPrerender writes files to real paths derived from root, but we
    // override by calling prerenderPages/prerenderApp directly with a tmp
    // manifestDir. Instead, call runPrerender which needs a real-looking root.
    // We test it indirectly: call prerenderPages on app-basic's pages/ dir
    // with a manifestDir so we can check hybrid manifest merging.
    const { prerenderPages } = await import("../packages/vinext/src/build/prerender.js");
    const { pagesRouter, apiRouter } =
      await import("../packages/vinext/src/routing/pages-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    const pagesDir = path.resolve(APP_FIXTURE, "pages");
    const pageRoutes = await pagesRouter(pagesDir);
    const apiRoutes = await apiRouter(pagesDir);
    const config = await resolveNextConfig({});

    const prerenderResult = await prerenderPages({
      mode: "default",
      pagesBundlePath,
      routes: pageRoutes,
      apiRoutes,
      pagesDir,
      outDir: manifestDir,
      config,
    });
    results = prerenderResult.routes;
  }, 60_000);

  afterAll(() => {
    fs.rmSync(manifestDir, { recursive: true, force: true });
  });

  it("renders old-school static page from pages/ in app-basic fixture", () => {
    const r = findRoute(results, "/old-school");
    expect(r).toMatchObject({ route: "/old-school", status: "rendered", revalidate: false });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("old-school.html");
    }
  });

  it("skips pages-header-override-delete (getServerSideProps) in default mode", () => {
    const r = findRoute(results, "/pages-header-override-delete");
    expect(r).toMatchObject({
      route: "/pages-header-override-delete",
      status: "skipped",
      reason: "ssr",
    });
  });
});

// ─── runPrerender — output: 'export' wiring ───────────────────────────────────

describe("runPrerender — output: 'export' wiring", () => {
  let pagesBundlePath: string;

  beforeAll(async () => {
    // Build pages-basic to a fresh tmpdir — no fixture copying needed.
    // Pass the bundle path and a nextConfigOverride to runPrerender so it
    // exercises output: 'export' without touching the real next.config.mjs.
    pagesBundlePath = await buildPagesFixture(PAGES_FIXTURE);
  }, 120_000);

  it("throws when next.config output: 'export' and SSR routes exist", async () => {
    const { runPrerender } = await import("../packages/vinext/src/build/run-prerender.js");
    await expect(
      runPrerender({
        root: PAGES_FIXTURE,
        nextConfigOverride: { output: "export" },
        pagesBundlePath,
      }),
    ).rejects.toThrow(/Static export failed/);
  });

  it("error message names the offending SSR route", async () => {
    const { runPrerender } = await import("../packages/vinext/src/build/run-prerender.js");
    await expect(
      runPrerender({
        root: PAGES_FIXTURE,
        nextConfigOverride: { output: "export" },
        pagesBundlePath,
      }),
    ).rejects.toThrow(/\/ssr/);
  });
});

// ─── App Router — Cloudflare Workers build ────────────────────────────────────
//
// Verifies that prerenderApp() works correctly when the production bundle is a
// Cloudflare Workers build (dist/server/index.js). Prerendering goes through a
// locally-spawned prod server over HTTP — same path as plain Node builds.

// ─── Cloudflare Workers hybrid build (app/ + pages/) ─────────────────────────
//
// Verifies that both prerenderApp() and prerenderPages() work correctly when
// the build is a Cloudflare Workers bundle. Both phases render via HTTP through
// a shared local prod server started by runPrerender().

describe("Cloudflare Workers hybrid build (cf-app-basic)", () => {
  let outDir: string;
  let allResults: PrerenderRouteResult[];

  beforeAll(async () => {
    const { root, rscBundlePath } = await buildCloudflareAppFixture(CF_FIXTURE);
    outDir = path.join(root, "dist", "server", "prerendered-routes");

    const { runPrerender } = await import("../packages/vinext/src/build/run-prerender.js");

    const result = await runPrerender({ root, rscBundlePath });
    allResults = result?.routes ?? [];
  }, 180_000);

  // ── App Router ──────────────────────────────────────────────────────────────

  describe("prerenderApp — app router via prod server HTTP", () => {
    it("renders / speculatively", () => {
      const r = findRoute(allResults, "/");
      expect(r).toMatchObject({ route: "/", status: "rendered", revalidate: false });
      if (r?.status === "rendered") {
        expect(r.outputFiles).toContain("index.html");
        expect(r.outputFiles).toContain("index.rsc");
      }
    });

    it("renders /about speculatively", () => {
      const r = findRoute(allResults, "/about");
      expect(r).toMatchObject({ route: "/about", status: "rendered", revalidate: false });
      if (r?.status === "rendered") {
        expect(r.outputFiles).toContain("about.html");
      }
    });

    it("renders /blog/[slug] expanded from generateStaticParams", () => {
      for (const slug of ["hello-world", "getting-started"]) {
        const r = findRoute(allResults, `/blog/${slug}`);
        expect(r).toMatchObject({
          route: "/blog/:slug",
          path: `/blog/${slug}`,
          status: "rendered",
          revalidate: false,
        });
        if (r?.status === "rendered") {
          expect(r.outputFiles).toContain(`blog/${slug}.html`);
          expect(r.outputFiles).toContain(`blog/${slug}.rsc`);
        }
      }
    });

    it("skips API routes", () => {
      const apiSkipped = allResults.filter(
        (r) => r.status === "skipped" && "reason" in r && r.reason === "api",
      );
      expect(apiSkipped.length).toBeGreaterThan(0);
    });

    it("writes HTML and RSC files to outDir", () => {
      expect(fs.existsSync(path.join(outDir, "index.html"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "index.rsc"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "about.html"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "blog/hello-world.html"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "blog/hello-world.rsc"))).toBe(true);
    });
  });

  // ── Pages Router ────────────────────────────────────────────────────────────

  describe("prerenderPages — pages router via prod server HTTP", () => {
    it("renders static index page", () => {
      const r = findRoute(allResults, "/");
      expect(r).toMatchObject({ route: "/", status: "rendered", revalidate: false });
      if (r?.status === "rendered") {
        expect(r.outputFiles).toContain("index.html");
      }
    });

    it("renders static about page", () => {
      const r = findRoute(allResults, "/about");
      expect(r).toMatchObject({ route: "/about", status: "rendered", revalidate: false });
      if (r?.status === "rendered") {
        expect(r.outputFiles).toContain("about.html");
      }
    });

    it("renders /posts/[id] expanded from getStaticPaths", () => {
      for (const id of ["first", "second"]) {
        const r = findRoute(allResults, `/posts/${id}`);
        expect(r).toMatchObject({
          route: "/posts/:id",
          path: `/posts/${id}`,
          status: "rendered",
          revalidate: false,
        });
        if (r?.status === "rendered") {
          expect(r.outputFiles).toContain(`posts/${id}.html`);
        }
      }
    });

    it("skips API routes", () => {
      const apiSkipped = allResults.filter(
        (r) => r.status === "skipped" && "reason" in r && r.reason === "api",
      );
      expect(apiSkipped.length).toBeGreaterThan(0);
    });

    it("writes HTML files to outDir", () => {
      expect(fs.existsSync(path.join(outDir, "posts/first.html"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "posts/second.html"))).toBe(true);
    });
  });
});

// ─── resolveParentParams unit tests ─────────────────────────────────────────

function mockRoute(pattern: string, opts: { pagePath?: string | null } = {}): AppRoute {
  const parts = pattern.split("/").filter(Boolean);
  return {
    pattern,
    pagePath: opts.pagePath ?? `/app${pattern}/page.tsx`,
    routePath: null,
    layouts: [],
    templates: [],
    parallelSlots: [],
    loadingPath: null,
    errorPath: null,
    layoutErrorPaths: [],
    notFoundPath: null,
    notFoundPaths: [],
    forbiddenPath: null,
    unauthorizedPath: null,
    routeSegments: [],
    layoutTreePositions: [],
    isDynamic: parts.some((p) => p.startsWith(":")),
    params: parts
      .filter((p) => p.startsWith(":"))
      .map((p) => p.replace(/^:/, "").replace(/[+*]$/, "")),
    patternParts: parts,
  };
}

describe("resolveParentParams", () => {
  it("returns empty array when route has no parent dynamic segments", async () => {
    const route = mockRoute("/blog/:slug");
    const result = await resolveParentParams(route, {});
    expect(result).toEqual([]);
  });

  it("returns empty array when parent route has no pagePath and no map entry", async () => {
    const child = mockRoute("/shop/:category/:item");
    const result = await resolveParentParams(child, {});
    expect(result).toEqual([]);
  });

  it("returns empty array when parent has no generateStaticParams", async () => {
    const child = mockRoute("/shop/:category/:item");
    const staticParamsMap: StaticParamsMap = {};
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([]);
  });

  it("resolves single parent dynamic segment", async () => {
    const child = mockRoute("/shop/:category/:item");
    const staticParamsMap: StaticParamsMap = {
      "/shop/:category": async () => [{ category: "electronics" }, { category: "clothing" }],
    };
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([{ category: "electronics" }, { category: "clothing" }]);
  });

  it("resolves two levels of parent dynamic segments", async () => {
    const child = mockRoute("/a/:b/c/:d/:e");
    const staticParamsMap: StaticParamsMap = {
      "/a/:b": async () => [{ b: "1" }, { b: "2" }],
      "/a/:b/c/:d": async ({ params }) => {
        if (params.b === "1") return [{ d: "x" }];
        return [{ d: "y" }, { d: "z" }];
      },
    };
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([
      { b: "1", d: "x" },
      { b: "2", d: "y" },
      { b: "2", d: "z" },
    ]);
  });

  it("skips static segments between dynamic parents", async () => {
    const child = mockRoute("/shop/:category/details/:item");
    const staticParamsMap: StaticParamsMap = {
      "/shop/:category": async () => [{ category: "shoes" }],
    };
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([{ category: "shoes" }]);
  });

  it("returns empty array for a fully static route", async () => {
    const route = mockRoute("/about/contact");
    const result = await resolveParentParams(route, {});
    expect(result).toEqual([]);
  });

  it("returns empty array for a single-segment dynamic route", async () => {
    const route = mockRoute("/:id");
    const result = await resolveParentParams(route, {});
    expect(result).toEqual([]);
  });

  it("resolves parent with catch-all child segment", async () => {
    const child = mockRoute("/shop/:category/:rest+");
    const staticParamsMap: StaticParamsMap = {
      "/shop/:category": async () => [{ category: "electronics" }],
    };
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([{ category: "electronics" }]);
  });

  it("resolves parent params from layout-level generateStaticParams (no pagePath)", async () => {
    const child = mockRoute("/shop/:category/:item");
    const staticParamsMap: StaticParamsMap = {
      "/shop/:category": async () => [{ category: "electronics" }, { category: "clothing" }],
    };
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([{ category: "electronics" }, { category: "clothing" }]);
  });

  it("resolves two levels of layout-only parent segments", async () => {
    const child = mockRoute("/a/:b/c/:d/:e");
    const staticParamsMap: StaticParamsMap = {
      "/a/:b": async () => [{ b: "1" }, { b: "2" }],
      "/a/:b/c/:d": async ({ params }) => {
        if (params.b === "1") return [{ d: "x" }];
        return [{ d: "y" }, { d: "z" }];
      },
    };
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([
      { b: "1", d: "x" },
      { b: "2", d: "y" },
      { b: "2", d: "z" },
    ]);
  });

  it("resolves mixed page-level and layout-level parent segments", async () => {
    const child = mockRoute("/shop/:category/brand/:brand/:item");
    const staticParamsMap: StaticParamsMap = {
      "/shop/:category": async () => [{ category: "shoes" }],
      "/shop/:category/brand/:brand": async () => [{ brand: "nike" }, { brand: "adidas" }],
    };
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([
      { category: "shoes", brand: "nike" },
      { category: "shoes", brand: "adidas" },
    ]);
  });

  it("passes through parent params when intermediate prefix returns null (CF Workers Proxy)", async () => {
    const child = mockRoute("/a/:b/c/:d/:e");
    const staticParamsMap: StaticParamsMap = {
      // /a/:b has no generateStaticParams — simulates CF Workers Proxy returning null
      "/a/:b": async () => null as unknown as Record<string, string | string[]>[],
      "/a/:b/c/:d": async () => [{ d: "x" }],
    };
    const result = await resolveParentParams(child, staticParamsMap);
    // null from /a/:b should pass through, allowing /a/:b/c/:d to still resolve
    expect(result).toEqual([{ d: "x" }]);
  });

  it("returns empty array when parent generateStaticParams returns []", async () => {
    const child = mockRoute("/shop/:category/:item");
    const staticParamsMap: StaticParamsMap = {
      "/shop/:category": async () => [],
    };
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([]);
  });

  it("propagates errors thrown by parent generateStaticParams", async () => {
    const child = mockRoute("/shop/:category/:item");
    const staticParamsMap: StaticParamsMap = {
      "/shop/:category": async () => {
        throw new Error("DB unavailable");
      },
    };
    await expect(resolveParentParams(child, staticParamsMap)).rejects.toThrow("DB unavailable");
  });

  it("passes through params from real parent when intermediate parent returns null", async () => {
    const child = mockRoute("/a/:b/c/:d/:e");
    const staticParamsMap: StaticParamsMap = {
      "/a/:b": async () => [{ b: "x" }],
      // /a/:b/c/:d returns null — simulates no generateStaticParams at this level
      "/a/:b/c/:d": async () => null as unknown as Record<string, string | string[]>[],
    };
    const result = await resolveParentParams(child, staticParamsMap);
    // null from /a/:b/c/:d should pass through the already-resolved {b: "x"} unchanged
    expect(result).toEqual([{ b: "x" }]);
  });

  it("handles double null pass-through from two intermediate parents", async () => {
    const child = mockRoute("/a/:b/c/:d/e/:f/:g");
    const staticParamsMap: StaticParamsMap = {
      "/a/:b": async () => null as unknown as Record<string, string | string[]>[],
      "/a/:b/c/:d": async () => null as unknown as Record<string, string | string[]>[],
      "/a/:b/c/:d/e/:f": async () => [{ f: "val" }],
    };
    const result = await resolveParentParams(child, staticParamsMap);
    // Both /a/:b and /a/:b/c/:d return null, so {} passes through to /a/:b/c/:d/e/:f
    expect(result).toEqual([{ f: "val" }]);
  });

  it("resolves three levels of nested parent dynamic segments", async () => {
    const child = mockRoute("/a/:b/c/:d/e/:f/:g");
    const staticParamsMap: StaticParamsMap = {
      "/a/:b": async () => [{ b: "1" }, { b: "2" }],
      "/a/:b/c/:d": async ({ params }) => {
        if (params.b === "1") return [{ d: "alpha" }];
        return [{ d: "beta" }, { d: "gamma" }];
      },
      "/a/:b/c/:d/e/:f": async ({ params }) => {
        if (params.d === "alpha") return [{ f: "deep1" }];
        return [{ f: "deep2" }];
      },
    };
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([
      { b: "1", d: "alpha", f: "deep1" },
      { b: "2", d: "beta", f: "deep2" },
      { b: "2", d: "gamma", f: "deep2" },
    ]);
  });

  it("resolves parent params when parent is a catch-all segment", async () => {
    const child = mockRoute("/:slug+/details/:id");
    const staticParamsMap: StaticParamsMap = {
      "/:slug+": async () => [{ slug: ["a", "b"] }, { slug: ["c"] }],
    };
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([{ slug: ["a", "b"] }, { slug: ["c"] }]);
  });

  it("resolves parent params when parent is an optional catch-all segment", async () => {
    const child = mockRoute("/:slug*/details/:id");
    const staticParamsMap: StaticParamsMap = {
      "/:slug*": async () => [{ slug: [] }, { slug: ["a", "b"] }],
    };
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([{ slug: [] }, { slug: ["a", "b"] }]);
  });
});
