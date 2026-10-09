import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { NextConfig } from "../packages/vinext/src/config/next-config.js";
import { APP_FIXTURE_DIR, buildAppFixture } from "./helpers.js";

describe("App Router Static export", () => {
  let rscBundlePath: string;
  let trailingConfig: NextConfig;
  let trailingRscBundlePath: string;
  const exportDir = path.resolve(APP_FIXTURE_DIR, "out");

  beforeAll(async () => {
    rscBundlePath = await buildAppFixture(APP_FIXTURE_DIR);
    const { loadNextConfig } = await import("../packages/vinext/src/config/next-config.js");
    trailingConfig = {
      ...(await loadNextConfig(APP_FIXTURE_DIR)),
      trailingSlash: true,
    };
    trailingRscBundlePath = await buildAppFixture(APP_FIXTURE_DIR, trailingConfig);
  }, 120_000);

  afterAll(() => {
    fs.rmSync(exportDir, { recursive: true, force: true });
  });

  it("exports static App Router pages to HTML files", async () => {
    const { staticExportApp } = await import("../packages/vinext/src/build/static-export.js");
    const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    const appDir = path.resolve(APP_FIXTURE_DIR, "app");
    const routes = await appRouter(appDir);
    const config = await resolveNextConfig({ output: "export" });

    const result = await staticExportApp({
      routes,
      appDir,
      rscBundlePath,
      outDir: exportDir,
      config,
    });

    // Should have generated HTML files
    expect(result.pageCount).toBeGreaterThan(0);

    // Index page
    expect(result.files).toContain("index.html");
    const indexHtml = fs.readFileSync(path.join(exportDir, "index.html"), "utf-8");
    expect(indexHtml).toContain("Welcome to App Router");

    // About page
    expect(result.files).toContain("about.html");
    const aboutHtml = fs.readFileSync(path.join(exportDir, "about.html"), "utf-8");
    expect(aboutHtml).toContain("About");

    // Explicit appDir enables static metadata asset export for App Router apps.
    expect(result.files).toContain("metadata-dynamic-static/-/apple-icon.png");
  }, 60_000);

  it("pre-renders dynamic routes from generateStaticParams", async () => {
    // blog/[slug] has generateStaticParams returning hello-world and getting-started
    expect(fs.existsSync(path.join(exportDir, "blog", "hello-world.html"))).toBe(true);
    expect(fs.existsSync(path.join(exportDir, "blog", "getting-started.html"))).toBe(true);

    const blogHtml = fs.readFileSync(path.join(exportDir, "blog", "hello-world.html"), "utf-8");
    expect(blogHtml).toContain("hello-world");
  });

  it("generates 404.html for App Router", async () => {
    expect(fs.existsSync(path.join(exportDir, "404.html"))).toBe(true);
    const html404 = fs.readFileSync(path.join(exportDir, "404.html"), "utf-8");
    // Custom not-found.tsx should be rendered
    expect(html404).toContain("Page Not Found");
  });

  it("generates 404/index.html when trailingSlash is enabled", async () => {
    const { staticExportApp } = await import("../packages/vinext/src/build/static-export.js");
    const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    const appDir = path.resolve(APP_FIXTURE_DIR, "app");
    const routes = await appRouter(appDir);
    const config = await resolveNextConfig({ ...trailingConfig, output: "export" });
    const trailingDir = path.resolve(APP_FIXTURE_DIR, "out-trailing-app");

    try {
      const result = await staticExportApp({
        routes,
        appDir,
        rscBundlePath: trailingRscBundlePath,
        outDir: trailingDir,
        config,
      });

      // Ported from Next.js: test/e2e/app-dir-export/test/utils.ts
      // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir-export/test/utils.ts
      expect(result.files).toContain("404.html");
      expect(result.files).toContain("404/index.html");
      expect(fs.readFileSync(path.join(trailingDir, "404.html"), "utf-8")).toBe(
        fs.readFileSync(path.join(trailingDir, "404", "index.html"), "utf-8"),
      );
    } finally {
      fs.rmSync(trailingDir, { recursive: true, force: true });
    }
  });

  it("reports errors for dynamic routes without generateStaticParams", async () => {
    const { staticExportApp } = await import("../packages/vinext/src/build/static-export.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    // Create a fake route with isDynamic but no generateStaticParams
    const fakeRoutes = [
      {
        pattern: "/fake/:id",
        pagePath: path.resolve(APP_FIXTURE_DIR, "app", "page.tsx"),
        routePath: null,
        layouts: [],
        templates: [],
        parallelSlots: [],
        routeSegments: ["fake", "[id]"],
        layoutTreePositions: [],
        loadingPath: null,
        errorPath: null,
        layoutErrorPaths: [],
        notFoundPath: null,
        notFoundPaths: [],
        forbiddenPaths: [],
        forbiddenPath: null,
        unauthorizedPaths: [],
        unauthorizedPath: null,
        isDynamic: true,
        params: ["id"],
        patternParts: ["fake", ":id"],
        siblingIntercepts: [],
      },
    ];
    const config = await resolveNextConfig({ output: "export" });
    const tempDir = path.resolve(APP_FIXTURE_DIR, "out-temp-app");

    try {
      const result = await staticExportApp({
        routes: fakeRoutes,
        rscBundlePath,
        outDir: tempDir,
        config,
      });

      // Should have an error about missing generateStaticParams
      expect(result.errors.some((e) => e.error.includes("generateStaticParams"))).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips route handlers with warning", async () => {
    const { staticExportApp } = await import("../packages/vinext/src/build/static-export.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    // Create a fake API route
    const fakeRoutes = [
      {
        pattern: "/api/test",
        pagePath: null,
        routePath: path.resolve(APP_FIXTURE_DIR, "app", "api", "hello", "route.ts"),
        layouts: [],
        templates: [],
        parallelSlots: [],
        routeSegments: ["api", "hello"],
        layoutTreePositions: [],
        loadingPath: null,
        errorPath: null,
        layoutErrorPaths: [],
        notFoundPath: null,
        notFoundPaths: [],
        forbiddenPaths: [],
        forbiddenPath: null,
        unauthorizedPaths: [],
        unauthorizedPath: null,
        isDynamic: false,
        params: [],
        patternParts: ["api", "test"],
        siblingIntercepts: [],
      },
    ];
    const config = await resolveNextConfig({ output: "export" });
    const tempDir = path.resolve(APP_FIXTURE_DIR, "out-temp-api");

    try {
      const result = await staticExportApp({
        routes: fakeRoutes,
        rscBundlePath,
        outDir: tempDir,
        config,
      });

      expect(result.warnings.some((w) => w.includes("API route"))).toBe(true);
      // Only the 404 page should be generated, no regular pages
      expect(result.files.filter((f) => f !== "404.html")).toHaveLength(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// Adapted from Next.js: test/e2e/app-dir/app-root-params-getters/simple.test.ts
// ("should render the not found page without errors")
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-root-params-getters/simple.test.ts
// Upstream checks the runtime route miss; this checks the exported 404.html
// of the #3680 app, whose root layout throws for an unknown root param.
describe("App Router static export with a dynamic root layout", () => {
  it("renders 404.html without a root layout under a dynamic segment (#3680)", async () => {
    const { staticExportApp } = await import("../packages/vinext/src/build/static-export.js");
    const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-dynamic-root-export-"));
    try {
      const langDir = path.join(fixtureDir, "app", "[lang]");
      fs.mkdirSync(langDir, { recursive: true });
      fs.writeFileSync(
        path.join(langDir, "layout.tsx"),
        `import { lang } from "next/root-params";
export function generateStaticParams() {
  return [{ lang: "en" }];
}
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await lang();
  if (locale !== "en") throw new Error(\`Unknown locale: \${locale}\`);
  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
`,
      );
      fs.writeFileSync(
        path.join(langDir, "page.tsx"),
        `export default function Page() {
  return <h1>Localized home</h1>;
}
`,
      );
      fs.writeFileSync(path.join(fixtureDir, "package.json"), JSON.stringify({ type: "module" }));
      fs.symlinkSync(
        path.resolve(import.meta.dirname, "../node_modules"),
        path.join(fixtureDir, "node_modules"),
        "junction",
      );

      const rscBundlePath = await buildAppFixture(fixtureDir, { output: "export" });
      const appDir = path.join(fixtureDir, "app");
      const outDir = path.join(fixtureDir, "out");
      const result = await staticExportApp({
        routes: await appRouter(appDir),
        appDir,
        rscBundlePath,
        outDir,
        config: await resolveNextConfig({ output: "export" }),
      });

      expect(result.errors).toEqual([]);
      expect(result.files).toContain("en.html");
      expect(result.files).toContain("404.html");
      const html404 = fs.readFileSync(path.join(outDir, "404.html"), "utf-8");
      expect(html404).toMatch(/^<!DOCTYPE html><html><head>/);
      expect(html404).toContain("This page could not be found.");
      expect(html404).not.toContain("Unknown locale");
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 120_000);
});
