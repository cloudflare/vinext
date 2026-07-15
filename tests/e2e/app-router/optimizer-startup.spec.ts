import { test, expect } from "../fixtures";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

test.describe("App Router optimizer startup", () => {
  test("hydrates a non-startup client route after root startup", async ({
    page,
    consoleErrors,
  }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");
    await waitForAppRouterHydration(page);

    await page.goto(`${BASE}/interactive`);
    await expect(page.locator("h1")).toHaveText("Interactive Page");
    await expect(page.getByTestId("count")).toHaveText("Count: 0");

    const incrementButton = page.locator("button", { hasText: "Increment" });
    await expect(async () => {
      await incrementButton.click();
      await expect(page.getByTestId("count")).not.toHaveText("Count: 0");
    }).toPass({ timeout: 10_000 });

    void consoleErrors;
  });
});
