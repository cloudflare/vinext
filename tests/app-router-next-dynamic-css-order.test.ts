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

describe("App Router: next/dynamic CSS order (production)", () => {
  let server: Awaited<ReturnType<typeof preview>>;
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    const builder = await createBuilder({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [vinext({ appDir: FIXTURE_DIR })],
      logLevel: "silent",
    });
    await builder.buildApp();

    server = await preview({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [vinext({ appDir: FIXTURE_DIR })],
      preview: { port: 0 },
      logLevel: "silent",
    });
    const address = server.httpServer.address();
    baseUrl = address && typeof address === "object" ? `http://localhost:${address.port}` : "";
    expect(baseUrl).not.toBe("");
    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.httpServer.close();
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  });

  it("keeps Next.js cascade order across an SSR bailout and next/dynamic", async () => {
    const page = await browser.newPage();
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
});
