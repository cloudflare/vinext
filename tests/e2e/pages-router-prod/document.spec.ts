import { test, expect } from "@playwright/test";

/**
 * Production build E2E tests for custom _document and _app.
 *
 * Ported from tests/e2e/pages-router/document.spec.ts — same assertions,
 * but exercised against the production server on port 4175.
 */
const BASE = "http://localhost:4175";

test.describe("Document (prod)", () => {
  test("page includes theme attribute on the body", async ({ page }) => {
    await page.goto(`${BASE}/`);

    await expect(page.getAttribute("body", "data-theme-prop")).resolves.toBe("light");
  });

  test("page includes app prop attribute", async ({ page }) => {
    await page.goto(`${BASE}/?appProp=value`);

    await expect(page.getAttribute("#app-wrapper", "data-app-prop")).resolves.toBe("value");
  });

  test("error pages (404) also use the custom _document and get getInitialProps", async ({
    page,
  }) => {
    await page.goto(`${BASE}/this-page-does-not-exist`);

    await expect(page.getAttribute("body", "data-theme-prop")).resolves.toBe("light");
  });

  test("basic document structure is present (id=__next, html/head/body)", async ({ page }) => {
    await page.goto(`${BASE}/`);

    await expect(page.locator("#__next")).toBeVisible();
    const htmlLang = await page.evaluate(() => document.documentElement.lang);
    expect(htmlLang).toBe("en");
  });

  test("getInitialProps receives the correct pathname via DocumentContext", async ({ page }) => {
    await page.goto(`${BASE}/about`);

    await expect(page.getAttribute("body", "data-theme-prop")).resolves.toBe("light");
    await expect(page.getAttribute("body", "data-pathname")).resolves.toBe("/about");
    await expect(page.locator("#__next")).toBeVisible();
  });
});
