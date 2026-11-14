// Issue #3680: the prerendered 404 page must not render through a top-level
// dynamic route. Next.js builds it from its own entry (`/_not-found` in the App
// Router, `/_error` in the Pages Router), so a route like `app/[lang]` or
// `pages/[slug]` never receives the request vinext makes for it. A route that
// generates that request's path itself still renders it as a page.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { VINEXT_PRERENDER_NOT_FOUND_HEADER } from "../packages/vinext/src/server/headers.js";
import { buildAppFixture, buildPagesFixture } from "./helpers.js";

const APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-root-params-export");
const APP_GENERATED_PATH_FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/app-dynamic-root-404-path",
);
const PAGES_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/pages-dynamic-root-404");
const PAGES_MIDDLEWARE_FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/pages-dynamic-root-404-middleware",
);
const NOT_FOUND_PATH_SLUG = "__vinext_nonexistent_for_404__";

describe("static export 404 with a dynamic root layout", () => {
  let rscBundlePath: string;
  let outDir: string;

  beforeAll(async () => {
    rscBundlePath = await buildAppFixture(APP_FIXTURE_DIR, { output: "export" });
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-dynamic-root-404-app-"));
  }, 120_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("writes 404.html from the default document without running the [lang] layout", async () => {
    const { staticExportApp } = await import("../packages/vinext/src/build/static-export.js");
    const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    const appDir = path.join(APP_FIXTURE_DIR, "app");
    const result = await staticExportApp({
      routes: await appRouter(appDir),
      appDir,
      rscBundlePath,
      outDir,
      config: await resolveNextConfig({ output: "export" }),
    });

    expect(result.errors).toEqual([]);
    expect(result.files).toContain("lv.html");
    expect(result.files).toContain("en.html");
    expect(fs.readFileSync(path.join(outDir, "lv.html"), "utf-8")).toContain('<html lang="lv">');

    expect(result.files).toContain("404.html");
    const html404 = fs.readFileSync(path.join(outDir, "404.html"), "utf-8");
    expect(html404).toContain("This page could not be found.");
    // The [lang] layout is the only one that sets <html lang>.
    expect(html404).not.toMatch(/<html lang=/);
    expect(html404).not.toContain("localized home");
  }, 60_000);
});

describe("static export 404 with a dynamic root route that generates the 404 path", () => {
  let rscBundlePath: string;
  let outDir: string;

  beforeAll(async () => {
    rscBundlePath = await buildAppFixture(APP_GENERATED_PATH_FIXTURE_DIR, { output: "export" });
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-dynamic-root-404-app-path-"));
  }, 120_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("exports the generated path as a page and 404.html as the not-found page", async () => {
    const { staticExportApp } = await import("../packages/vinext/src/build/static-export.js");
    const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    const appDir = path.join(APP_GENERATED_PATH_FIXTURE_DIR, "app");
    const result = await staticExportApp({
      routes: await appRouter(appDir),
      appDir,
      rscBundlePath,
      outDir,
      config: await resolveNextConfig({ output: "export" }),
    });

    expect(result.errors).toEqual([]);
    expect(result.files).toContain("hello.html");
    expect(result.files).toContain(`${NOT_FOUND_PATH_SLUG}.html`);
    expect(fs.readFileSync(path.join(outDir, `${NOT_FOUND_PATH_SLUG}.html`), "utf-8")).toContain(
      `slug page: <!-- -->${NOT_FOUND_PATH_SLUG}`,
    );

    expect(result.files).toContain("404.html");
    const html404 = fs.readFileSync(path.join(outDir, "404.html"), "utf-8");
    expect(html404).toContain("This page could not be found.");
    expect(html404).not.toContain("slug page");
  }, 60_000);
});

describe("prerender server with the 404 marker on another path", () => {
  let server: { port: number; close: () => Promise<void> } | undefined;
  let restorePrerenderPhase: (() => void) | undefined;

  beforeAll(async () => {
    const rscBundlePath = await buildAppFixture(APP_GENERATED_PATH_FIXTURE_DIR);
    const { enterPrerenderPhase } = await import("../packages/vinext/src/build/prerender-phase.js");
    const { startPrerenderProdServer } =
      await import("../packages/vinext/src/build/prerender-server-pool.js");
    restorePrerenderPhase = enterPrerenderPhase();
    const serverDir = path.dirname(rscBundlePath);
    server = await startPrerenderProdServer(path.dirname(serverDir), {
      rscEntryPath: rscBundlePath,
      serverDir,
    });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    restorePrerenderPhase?.();
  });

  it("matches the route of a subrequest that forwards the marker", async () => {
    // As a middleware subrequest that forwards the 404 request's headers does.
    const res = await fetch(`http://127.0.0.1:${server!.port}/hello`, {
      headers: { [VINEXT_PRERENDER_NOT_FOUND_HEADER]: "1" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("slug page: <!-- -->hello");
  }, 60_000);
});

describe("Pages Router 404 with a dynamic root page", () => {
  let pagesBundlePath: string;
  let outDir: string;

  beforeAll(async () => {
    pagesBundlePath = await buildPagesFixture(PAGES_FIXTURE_DIR);
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-dynamic-root-404-pages-"));
  }, 120_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("renders the 404 page from pages/_error, not pages/[slug]", async () => {
    const { prerenderPages } = await import("../packages/vinext/src/build/prerender.js");
    const { pagesRouter, apiRouter } =
      await import("../packages/vinext/src/routing/pages-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    const pagesDir = path.join(PAGES_FIXTURE_DIR, "pages");
    const { routes } = await prerenderPages({
      mode: "default",
      pagesBundlePath,
      routes: await pagesRouter(pagesDir),
      apiRoutes: await apiRouter(pagesDir),
      pagesDir,
      outDir,
      config: await resolveNextConfig({}),
    });

    // pages/[slug] generates the 404 request's path, which still renders it.
    expect(
      routes.find(
        (r) =>
          r.route === "/:slug" && r.status === "rendered" && r.path === `/${NOT_FOUND_PATH_SLUG}`,
      ),
    ).toBeDefined();
    expect(fs.readFileSync(path.join(outDir, `${NOT_FOUND_PATH_SLUG}.html`), "utf-8")).toContain(
      NOT_FOUND_PATH_SLUG,
    );

    expect(routes.find((r) => r.route === "/404")).toMatchObject({
      route: "/404",
      status: "rendered",
      router: "pages",
    });
    const html404 = fs.readFileSync(path.join(outDir, "404.html"), "utf-8");
    expect(html404).toContain("Custom Pages error");
    expect(html404).not.toContain("slug page");
  }, 60_000);
});

describe("Pages Router 404 with a dynamic root page and a fallback rewrite", () => {
  let pagesBundlePath: string;
  let outDir: string;

  beforeAll(async () => {
    pagesBundlePath = await buildPagesFixture(PAGES_FIXTURE_DIR, {
      async rewrites() {
        return {
          beforeFiles: [],
          afterFiles: [],
          fallback: [{ source: `/${NOT_FOUND_PATH_SLUG}`, destination: "/" }],
        };
      },
    });
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-dynamic-root-404-pages-rewrite-"));
  }, 120_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("lets the fallback rewrite claim the 404 request, as for any route miss", async () => {
    const { prerenderPages } = await import("../packages/vinext/src/build/prerender.js");
    const { pagesRouter, apiRouter } =
      await import("../packages/vinext/src/routing/pages-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    const pagesDir = path.join(PAGES_FIXTURE_DIR, "pages");
    const { routes } = await prerenderPages({
      mode: "default",
      pagesBundlePath,
      routes: await pagesRouter(pagesDir),
      apiRoutes: await apiRouter(pagesDir),
      pagesDir,
      outDir,
      config: await resolveNextConfig({}),
    });

    // The route that generates the path matches before fallback rewrites run.
    expect(
      routes.find(
        (r) =>
          r.route === "/:slug" && r.status === "rendered" && r.path === `/${NOT_FOUND_PATH_SLUG}`,
      ),
    ).toBeDefined();
    // The 404 request is a miss, so the fallback rewrite takes it, and a
    // rewritten render never becomes the deployment's 404 page.
    expect(routes.find((r) => r.route === "/404")).toBeUndefined();
  }, 60_000);
});

describe("Pages Router 404 with a dynamic root page and request-header middleware", () => {
  let pagesBundlePath: string;
  let outDir: string;

  beforeAll(async () => {
    pagesBundlePath = await buildPagesFixture(PAGES_MIDDLEWARE_FIXTURE_DIR);
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-dynamic-root-404-pages-mw-"));
  }, 120_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("ignores a middleware request-header override for the 404 marker", async () => {
    const { prerenderPages } = await import("../packages/vinext/src/build/prerender.js");
    const { pagesRouter, apiRouter } =
      await import("../packages/vinext/src/routing/pages-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    const pagesDir = path.join(PAGES_MIDDLEWARE_FIXTURE_DIR, "pages");
    const { routes } = await prerenderPages({
      mode: "default",
      pagesBundlePath,
      routes: await pagesRouter(pagesDir),
      apiRoutes: await apiRouter(pagesDir),
      pagesDir,
      outDir,
      config: await resolveNextConfig({}),
    });

    // Middleware adds the marker to the generated page's request: it still
    // renders as the [slug] page.
    expect(
      routes.find(
        (r) =>
          r.route === "/:slug" && r.status === "rendered" && r.path === `/${NOT_FOUND_PATH_SLUG}`,
      ),
    ).toBeDefined();
    const generatedHtml = fs.readFileSync(
      path.join(outDir, `${NOT_FOUND_PATH_SLUG}.html`),
      "utf-8",
    );
    expect(generatedHtml).toContain("slug page");
    expect(generatedHtml).not.toContain("Custom Pages error");

    // Middleware drops the marker from the 404 request: it is still a miss.
    expect(routes.find((r) => r.route === "/404")).toMatchObject({
      route: "/404",
      status: "rendered",
      router: "pages",
    });
    const html404 = fs.readFileSync(path.join(outDir, "404.html"), "utf-8");
    expect(html404).toContain("Custom Pages error");
    expect(html404).not.toContain("slug page");
  }, 60_000);
});
