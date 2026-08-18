import { expect, test } from "@playwright/test";

const ROUTE = "/provider-region";

test.describe("provider country propagation", () => {
  test("propagates the native Workers country to Next request headers", async ({ page }) => {
    await page.goto(ROUTE);

    await expect(page.getByTestId("api-resolved-country")).toBeVisible();
    const cfCountry = await page.getByTestId("api-cf-country").innerText();
    const headerCountry = await page.getByTestId("api-header-country").innerText();
    const resolvedCountry = await page.getByTestId("api-resolved-country").innerText();

    if (cfCountry !== "missing") {
      expect(headerCountry).toBe(cfCountry);
      expect(resolvedCountry).toBe(cfCountry);
      await expect(page.getByTestId("page-header-country")).toHaveText(cfCountry);
      await expect(page.getByTestId("page-resolved-country")).toHaveText(cfCountry);
    }

    if (process.env.VINEXT_E2E_BASE_URL?.startsWith("https://")) {
      expect(cfCountry).toMatch(/^(?:[A-Z]{2}|T1)$/);
    }
  });

  test("uses the provider catalog returned by the API for App Router navigation", async ({
    page,
  }) => {
    await page.goto(ROUTE);
    await expect(page.getByTestId("provider-8")).toBeVisible();

    await page.getByTestId("provider-8").click();
    await expect(page).toHaveURL(`${ROUTE}?provider=8`);
    await expect(page.getByTestId("client-provider")).toHaveText("8");
    await expect(page.getByTestId("server-provider")).toHaveText("8");
    const pageRegion = await page.getByTestId("page-resolved-country").innerText();
    await expect(page.getByTestId("server-region")).toHaveText(pageRegion);

    await page.getByTestId("provider-8").click();
    await expect(page).toHaveURL(ROUTE);
    await expect(page.getByTestId("client-provider")).toHaveText("none");
    await expect(page.getByTestId("server-provider")).toHaveText("none");
  });
});
