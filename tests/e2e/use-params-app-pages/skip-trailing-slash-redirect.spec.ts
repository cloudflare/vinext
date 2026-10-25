import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration, waitForHydration } from "../helpers";

// Ported from Next.js: test/e2e/skip-trailing-slash-redirect/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/skip-trailing-slash-redirect/index.test.ts
//
// The use-params-app-pages fixture enables skipTrailingSlashRedirect. Next's
// Pages routes at / live under /skip-trailing-slash/ here.

const routers = [
  { name: "pages dir", basePath: "/skip-trailing-slash/", hydrate: waitForHydration },
  { name: "app dir", basePath: "/with-app-dir/", hydrate: waitForAppRouterHydration },
] as const;

async function pathname(page: Page): Promise<string> {
  return page.evaluate(() => window.location.pathname);
}

for (const { name, basePath, hydrate } of routers) {
  test.describe(name, () => {
    test("should preserve original trailing slashes to links on client", async ({ page }) => {
      await page.goto(basePath);
      await hydrate(page);
      await page.evaluate(() => {
        (window as unknown as { beforeNav: number }).beforeNav = 1;
      });

      await expect(page.locator("#to-another")).toHaveAttribute("href", `${basePath}another`);
      await expect(page.locator("#to-another-with-slash")).toHaveAttribute(
        "href",
        `${basePath}another/`,
      );

      await page.locator("#to-another").click();
      await expect(page.locator("#another")).toBeVisible();
      expect(await pathname(page)).toBe(`${basePath}another`);

      await page.goBack();
      await expect(page.locator("#to-another")).toBeVisible();

      await page.locator("#to-another-with-slash").click();
      await expect(page.locator("#another")).toBeVisible();
      expect(await pathname(page)).toBe(`${basePath}another/`);

      await page.goBack();
      await expect(page.locator("#to-another")).toBeVisible();
      expect(
        await page.evaluate(() => (window as unknown as { beforeNav?: number }).beforeNav),
      ).toBe(1);
    });

    test("should navigate client side correctly", async ({ page }) => {
      await page.goto(basePath);
      await hydrate(page);
      expect(await pathname(page)).toBe(basePath);

      await page.locator("#to-another").click();
      await expect(page.locator("#another")).toBeVisible();
      expect(await pathname(page)).toBe(`${basePath}another`);

      await page.goBack();
      await expect(page.locator("#index")).toBeVisible();
      expect(await pathname(page)).toBe(basePath);

      await page.locator("#to-blog-first").click();
      await expect(page.locator("#blog")).toBeVisible();
      expect(await pathname(page)).toBe(`${basePath}blog/first`);
    });
  });
}

test("should not apply trailing slash on load on client", async ({ page }) => {
  await page.goto("/skip-trailing-slash/another");
  await waitForHydration(page);
  expect(await pathname(page)).toBe("/skip-trailing-slash/another");

  await page.goto("/skip-trailing-slash/another/");
  await waitForHydration(page);
  expect(await pathname(page)).toBe("/skip-trailing-slash/another/");
});
