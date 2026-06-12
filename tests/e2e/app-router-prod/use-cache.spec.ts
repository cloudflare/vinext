import { expect, test } from "@playwright/test";

test.describe('production "use cache" server function references', () => {
  test("replays cached RSC through SSR and invokes nested functions from the browser", async ({
    page,
  }) => {
    await page.goto("/use-cache-nested-fn-props");
    await expect(page.getByTestId("use-cache-nested-fn-props-page")).toBeVisible();

    await page.locator("#submit-button-date").click();
    await expect(page.locator("#date")).toHaveText(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const firstDate = await page.locator("#date").textContent();
    await page.locator("#submit-button-date").click();
    await expect(page.locator("#date")).toHaveText(firstDate!);

    await page.locator("#submit-button-random").click();
    await expect(page.locator("#random")).toHaveText(/^\d+\.\d+$/);
    const firstRandom = await page.locator("#random").textContent();
    await page.locator("#submit-button-random").click();
    await expect(page.locator("#random")).toHaveText(firstRandom!);

    await page.locator("#submit-button-message").click();
    await expect(page.locator("#message")).toHaveText(
      /^message:closure-captured-bound-arg-vinext:[0-9.e+-]+$/,
    );
    const firstMessage = await page.locator("#message").textContent();
    await page.locator("#submit-button-message").click();
    await expect(page.locator("#message")).toHaveText(firstMessage!);
  });
});
