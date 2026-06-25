import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

// Ported from Next.js: test/e2e/app-dir/app/index.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app/index.test.ts
test.describe("template navigation", () => {
  test("client template state resets on navigation", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/template-client`);
    await waitForAppRouterHydration(page);

    await expect(page.getByTestId("client-template-count")).toHaveText("Template 0");
    await page.getByTestId("client-template-increment").click();
    await expect(page.getByTestId("client-template-count")).toHaveText("Template 1");

    await page.getByTestId("client-template-link").click();
    await expect(page.getByTestId("client-template-other-page")).toBeVisible();
    await expect(page.getByTestId("client-template-count")).toHaveText("Template 0");

    await page.getByTestId("client-template-increment").click();
    await page.getByTestId("client-template-link").click();
    await expect(page.getByTestId("client-template-page")).toBeVisible();
    await expect(page.getByTestId("client-template-count")).toHaveText("Template 0");
  });

  test("server template rerenders on navigation", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/template-server`);
    await waitForAppRouterHydration(page);

    const firstRenderId = await page.getByTestId("server-template-render-id").textContent();
    await page.getByTestId("server-template-link").click();
    await expect(page.getByTestId("server-template-other-page")).toBeVisible();
    await expect(page.getByTestId("server-template-render-id")).not.toHaveText(firstRenderId!);

    const secondRenderId = await page.getByTestId("server-template-render-id").textContent();
    await page.getByTestId("server-template-link").click();
    await expect(page.getByTestId("server-template-page")).toBeVisible();
    await expect(page.getByTestId("server-template-render-id")).not.toHaveText(secondRenderId!);
  });
});
