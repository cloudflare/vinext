import { test, expect } from "@playwright/test";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4173";

// Ported from Next.js: test/e2e/middleware-shallow-link/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-shallow-link/index.test.ts
//
// Every route in the pages-basic fixture is matched by `middleware.ts`, so
// these navigations exercise the "middleware-rewritten shallow link" path.
// Regression coverage for #1540: after a shallow push, a non-shallow
// navigation to another page, and a shallow replace, traversing back through
// history (`window.history.back()`) must land on page 1 again.
test.describe("Middleware shallow link history traversal (Pages Router)", () => {
  test("back button returns to page 1 after shallow push/replace", async ({ page }) => {
    await page.goto(`${BASE}/mw-shallow-link`);
    await expect(page.locator("h1")).toHaveText("Content for page 1");
    await waitForHydration(page);

    // Shallow push — adds a history entry with new query, stays on page 1.
    await page.click("[data-next-shallow-push]");
    await expect(page).toHaveURL(`${BASE}/mw-shallow-link?params=testParams`);
    await expect(page.locator("[data-next-page]")).toBeVisible();

    // Non-shallow navigation to page 2.
    await page.click("[data-next-page]");
    await expect(page.locator("h1")).toHaveText("Content for page 2");
    await expect(page.locator("[data-next-shallow-replace]")).toBeVisible();

    // Shallow replace on page 2 — replaces the page-2 history entry.
    await page.click("[data-next-shallow-replace]");
    await expect(page).toHaveURL(`${BASE}/mw-shallow-link-page2?params=testParams`);

    // The go-back button must render on the rewritten page.
    await expect(page.locator("[data-go-back]")).toBeVisible();

    // Traverse back through history — must land back on page 1.
    await page.click("[data-go-back]");
    await expect(page.locator("h1")).toHaveText("Content for page 1");
  });
});
