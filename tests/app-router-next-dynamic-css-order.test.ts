/**
 * Production CSS-order parity for next/dynamic and nested App Router segments.
 *
 * Ported from Next.js:
 * test/e2e/app-dir/next-dynamic-css/next-dynamic-css.test.ts
 * https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/next-dynamic-css/next-dynamic-css.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import { createBuilder, preview } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { chromium, type Browser } from "playwright";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/next-dynamic-css");
const DIST_DIR = path.join(FIXTURE_DIR, "dist");
const GLOBAL_CSS_ALIAS = "fixture-global-css";
const HAS_CHROMIUM = fs.existsSync(chromium.executablePath());
const browserIt = it.runIf(HAS_CHROMIUM);

function fixtureConfig() {
  return {
    root: FIXTURE_DIR,
    configFile: false as const,
    resolve: {
      alias: {
        [GLOBAL_CSS_ALIAS]: path.join(FIXTURE_DIR, "app/page/global2.css"),
        "fixture-alias-only-css": path.join(FIXTURE_DIR, "app/alias-only.css"),
        "fixture-module-alias": path.join(FIXTURE_DIR, "app/alias-module.module.css"),
      },
    },
    plugins: [vinext({ appDir: FIXTURE_DIR })],
    logLevel: "silent" as const,
  };
}

describe("App Router: next/dynamic CSS order (production)", () => {
  let server: Awaited<ReturnType<typeof preview>>;
  let browser: Browser | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    const builder = await createBuilder(fixtureConfig());
    await builder.buildApp();

    server = await preview({
      ...fixtureConfig(),
      preview: { port: 0 },
    });
    const address = server.httpServer.address();
    baseUrl = address && typeof address === "object" ? `http://localhost:${address.port}` : "";
    expect(baseUrl).not.toBe("");
    if (HAS_CHROMIUM) browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.httpServer.close();
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  });

  browserIt("keeps Next.js cascade order across an SSR bailout and next/dynamic", async () => {
    const page = await browser!.newPage();
    await page.goto(`${baseUrl}/page`, { waitUntil: "networkidle" });

    await expect.poll(() => page.locator("#component").count()).toBe(1);
    await expect
      .poll(() =>
        page.locator("#server").evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .toBe("rgb(0, 128, 0)");
    await expect
      .poll(() =>
        page.locator("#inner2").evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .toBe("rgb(0, 128, 0)");
    await expect
      .poll(() =>
        page.locator("#component").evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .toBe("rgb(0, 128, 0)");
    await expect
      .poll(() =>
        page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .toBe("rgb(255, 255, 255)");

    await page.close();
  });

  browserIt(
    "preserves declaration order when a global stylesheet follows a CSS module",
    async () => {
      const page = await browser!.newPage();
      await page.goto(`${baseUrl}/reverse`, { waitUntil: "networkidle" });

      await expect
        .poll(() =>
          page.locator("#reverse-order").evaluate((element) => getComputedStyle(element).color),
        )
        .toBe("rgb(255, 0, 0)");

      await page.close();
    },
  );

  browserIt("preserves a CSS module imported after a global owner boundary", async () => {
    const page = await browser!.newPage();
    await page.goto(`${baseUrl}/straddled`, { waitUntil: "networkidle" });

    await expect
      .poll(() =>
        page.locator("#straddled-order").evaluate((element) => getComputedStyle(element).color),
      )
      .toBe("rgb(0, 0, 255)");

    await page.close();
  });

  browserIt("classifies extensionless CSS module aliases by their resolved target", async () => {
    const page = await browser!.newPage();
    await page.goto(`${baseUrl}/alias-module`, { waitUntil: "networkidle" });

    await expect
      .poll(() =>
        page.locator("#alias-module").evaluate((element) => getComputedStyle(element).color),
      )
      .toBe("rgb(255, 0, 0)");

    await page.close();
  });

  browserIt("preserves CSS order through an intermediate JavaScript module", async () => {
    const page = await browser!.newPage();
    await page.goto(`${baseUrl}/transitive`, { waitUntil: "networkidle" });

    await expect
      .poll(() =>
        page.locator("#transitive-before").evaluate((element) => getComputedStyle(element).color),
      )
      .toBe("rgb(255, 0, 0)");
    await expect
      .poll(() =>
        page.locator("#transitive-after").evaluate((element) => getComputedStyle(element).color),
      )
      .toBe("rgb(0, 0, 255)");

    await page.close();
  });

  browserIt("preserves CSS evaluation order in a cyclic chunk shared by routes", async () => {
    for (const route of ["cycle-one", "cycle-two"]) {
      const page = await browser!.newPage();
      await page.goto(`${baseUrl}/${route}`, { waitUntil: "networkidle" });

      await expect
        .poll(() =>
          page.locator("#cycle-shared").evaluate((element) => getComputedStyle(element).color),
        )
        .toBe("rgb(255, 0, 0)");
      await expect(page.locator("#cycle-shared").getAttribute("data-marker")).resolves.toBe("b-a");
      await page.close();
    }
  });

  it("records resolved and transitive stylesheet resources in cascade order", () => {
    const manifestSource = fs.readFileSync(
      path.join(DIST_DIR, "server", "__vite_rsc_assets_manifest.js"),
      "utf8",
    );
    const manifest = JSON.parse(manifestSource.slice("export default ".length)) as {
      serverResources: Record<string, { css: string[] }>;
    };
    const cssDir = path.join(DIST_DIR, "client");
    const resourceColors = (resource: string) =>
      manifest.serverResources[resource].css.map((href) =>
        fs.readFileSync(path.join(cssDir, href), "utf8"),
      );

    expect(resourceColors("app/reverse/page.tsx").map(cssColor)).toEqual(["green", "red"]);
    expect(resourceColors("app/straddled/page.tsx").map(cssColor)).toEqual([
      "green",
      "red",
      "blue",
    ]);
    expect(resourceColors("app/alias-module/page.tsx").map(cssColor)).toEqual(["green", "red"]);
    expect(resourceColors("app/transitive/page.tsx").map(cssColor)).toEqual([
      "green",
      "red",
      "blue",
    ]);
    expect(resourceColors("app/cycle-shared/a.tsx").map(cssColor)).toEqual(["green", "red"]);
  });

  it("gives relative and extensionless alias imports of one global CSS file one owner", () => {
    const cssDir = path.join(DIST_DIR, "client", "_next", "static", "css");
    const matchingAssets = fs.readdirSync(cssDir).filter((file) => {
      if (!file.endsWith(".css")) return false;
      return fs.readFileSync(path.join(cssDir, file), "utf8").includes("next-dynamic-css-page");
    });

    expect(matchingAssets).toHaveLength(1);
    expect(matchingAssets[0]).toMatch(/^app-global-css-/);

    const aliasOnlyAssets = fs.readdirSync(cssDir).filter((file) => {
      if (!file.endsWith(".css")) return false;
      return fs
        .readFileSync(path.join(cssDir, file), "utf8")
        .includes("next-dynamic-css-alias-only");
    });
    expect(aliasOnlyAssets).toHaveLength(1);
    expect(aliasOnlyAssets[0]).toMatch(/^app-global-css-/);
  });
});

function cssColor(source: string): "blue" | "green" | "red" {
  if (source.includes("color:blue") || source.includes("color:#00f")) return "blue";
  if (source.includes("color:green") || source.includes("color:#008000")) return "green";
  if (source.includes("color:red") || source.includes("color:#f00")) return "red";
  throw new Error(`Expected CSS fixture color in ${source}`);
}
