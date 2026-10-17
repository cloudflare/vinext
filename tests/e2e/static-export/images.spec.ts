import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

/**
 * next/image in a static export with `trailingSlash: true` and
 * `images.loaderFile` (tests/fixtures/static-export/next.config.mjs).
 *
 * Ported from Next.js:
 * test/e2e/next-image-new/loader-config/loader-config.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-new/loader-config/loader-config.test.ts
 * test/e2e/next-image-new/trailing-slash/trailing-slash.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-new/trailing-slash/trailing-slash.test.ts
 */
const BASE = process.env.VINEXT_E2E_BASE_URL ?? "http://localhost:4180";
const DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];

async function imageAttrs(page: Page, alt: string) {
  const img = page.locator(`img[alt="${alt}"]`);
  return {
    src: await img.getAttribute("src"),
    srcSet: await img.getAttribute("srcset"),
    sizes: await img.getAttribute("sizes"),
  };
}

test.describe("Static Export — next/image", () => {
  let pageErrors: string[];

  test.beforeEach(async ({ page }) => {
    // Every console error counts (production React reports a hydration
    // mismatch as minified error #418), except the fixture's image URLs
    // failing to load: the static host has no image files or optimizer.
    pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource")) {
        pageErrors.push(msg.text());
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const response = await page.goto(`${BASE}/images/`);
    expect(response?.status()).toBe(200);
    await waitForAppRouterHydration(page);
  });

  test.afterEach(() => {
    expect(pageErrors).toEqual([]);
  });

  test("images without a loader prop use images.loaderFile", async ({ page }) => {
    expect(await imageAttrs(page, "loader-file")).toEqual({
      src: "/logo.png#w:128,q:50",
      srcSet: "/logo.png#w:64,q:50 1x, /logo.png#w:128,q:50 2x",
      sizes: null,
    });
    // overrideSrc replaces src but keeps the loader's srcSet.
    expect(await imageAttrs(page, "loader-file-override")).toEqual({
      src: "/override.png",
      srcSet: "/logo.png#w:64,q:50 1x, /logo.png#w:128,q:50 2x",
      sizes: null,
    });
    expect(await imageAttrs(page, "loader-file-fill")).toEqual({
      src: "/logo.png#w:3840,q:50",
      srcSet: DEVICE_SIZES.map((w) => `/logo.png#w:${w},q:50 ${w}w`).join(", "),
      sizes: "100vw",
    });
  });

  test("a loader prop gets every srcSet width and an unset quality", async ({ page }) => {
    expect(await imageAttrs(page, "loader-prop")).toEqual({
      src: "/logo.png?w=128&q=auto",
      srcSet: "/logo.png?w=64&q=auto 1x, /logo.png?w=128&q=auto 2x",
      sizes: null,
    });
  });

  // next/legacy/image never imports images.loaderFile; its built-in loader
  // uses images.path, which Next.js gives a trailing slash under trailingSlash.
  test("next/legacy/image keeps the built-in loader with a trailing slash", async ({ page }) => {
    expect(await imageAttrs(page, "legacy")).toEqual({
      src: "/_next/image/?url=%2Flogo.png&w=128&q=75",
      srcSet:
        "/_next/image/?url=%2Flogo.png&w=64&q=75 1x, /_next/image/?url=%2Flogo.png&w=128&q=75 2x",
      sizes: null,
    });
  });
});
