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

  test("server template identity follows its segment boundary", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/template-server/alpha`);
    await waitForAppRouterHydration(page);

    await page.getByTestId("server-template-identity-increment").click();
    await expect(page.getByTestId("server-template-identity")).toHaveText("1");

    await page.getByTestId("server-template-search-link").click();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/template-server/alpha?view=details`);
    await expect(page.getByTestId("server-template-identity")).toHaveText("1");

    await page.getByTestId("server-template-child-link").click();
    await expect(page.getByTestId("server-template-child-page")).toHaveText("Child alpha");
    await expect(page.getByTestId("server-template-identity")).toHaveText("1");

    await page.getByTestId("server-template-param-link").click();
    await expect(page.getByTestId("server-template-section-page")).toHaveText("Section beta");
    await expect(page.getByTestId("server-template-identity")).toHaveText("0");
  });
});
