import { expect, test } from "../fixtures";

// Regression: https://github.com/cloudflare/vinext/issues/3483
// Related Next.js coverage: test/production/app-dir/barrel-optimization/basic/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/production/app-dir/barrel-optimization/basic/index.test.ts
test("renders and hydrates real Radix barrel imports across RSC, SSR and the browser", async ({
  page,
  request,
  consoleErrors,
  baseURL,
}) => {
  // Dev already rendered this case; production used to hang during the RSC scan.
  // Exercise both halves together to enforce parity as we fix the production loop.
  for (const [mode, url] of [
    ["dev", "http://localhost:4216"],
    ["production", baseURL],
  ]) {
    await test.step(mode!, async () => {
      const response = await request.get(`${url}/radix`);
      expect(response.status()).toBe(200);
      const html = await response.text();
      expect(html).toContain('<h1 data-testid="server-slot">Radix barrel imports</h1>');
      expect(html).toMatch(/<button[^>]*>Count: (?:<!-- -->)?0<\/button>/);

      await page.goto(`${url}/radix`);
      await expect(page.getByTestId("server-slot")).toHaveText("Radix barrel imports");
      await expect(page.getByRole("button", { name: "Count: 0" })).toBeEnabled();
      await page.getByRole("button", { name: "Count: 0" }).click();
      await expect(page.getByRole("button", { name: "Count: 1" })).toBeVisible();

      await page.getByRole("button", { name: "Open dialog" }).click();
      await expect(page.getByRole("dialog", { name: "Radix dialog" })).toBeVisible();
      await page.getByRole("button", { name: "Close dialog" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Open dialog" })).toBeFocused();

      await page.getByRole("link", { name: "About this fixture" }).click();
      await expect(page).toHaveURL(/\/about$/);
      await page.goBack();
      await expect(page.getByTestId("server-slot")).toBeVisible();
      await page.getByRole("button", { name: "Open dialog" }).click();
      await expect(page.getByRole("dialog", { name: "Radix dialog" })).toBeVisible();
    });
  }
  expect(consoleErrors).toEqual([]);
});
