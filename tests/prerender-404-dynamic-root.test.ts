// Issue #3680: the prerendered 404 page must not render through a top-level
// dynamic route. Next.js builds it from its own entry (`/_not-found` in the App
// Router, `/_error` in the Pages Router), so a route like `app/[lang]` or
// `pages/[slug]` never receives the request vinext makes for it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { buildAppFixture, buildPagesFixture } from "./helpers.js";

const APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-root-params-export");
const PAGES_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/pages-dynamic-root-404");

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
