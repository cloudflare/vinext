import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("MDX support", () => {
  test("renders an imported MDX component", async ({ page }) => {
    await page.goto(`${BASE}/mdx-test`);
    // The page imports content.mdx as a React component and renders it.
    // This verifies the vinext:mdx proxy plugin transforms .mdx files
    // before vite:import-analysis runs (the fix from #77).
    await expect(page.locator('[data-testid="mdx-page"] h1')).toHaveText("Hello from MDX");
  });

  test("renders markdown formatting from MDX", async ({ page }) => {
    await page.goto(`${BASE}/mdx-test`);
    // Bold text should render
    await expect(page.locator('[data-testid="mdx-page"] strong').first()).toHaveText("MDX");
    // List items should render
    await expect(page.locator('[data-testid="mdx-page"] ul > li').first()).toContainText("Item one");
  });
});
