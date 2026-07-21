import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

test("oversized server action reaches the nearest error boundary", async ({ page }) => {
  await page.goto(`${BASE}/nextjs-compat/action-body-limit`);
  await waitForAppRouterHydration(page);

  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.request().headers()["next-action"] !== undefined,
  );
  await page.click("#overflow-action");
  const response = await responsePromise;

  expect(response.status()).toBe(500);
  expect(response.request().headers()["content-type"]).toContain("text/plain");
  await expect(page.locator("#error")).toHaveText("Something went wrong!");
  await expect(page.locator("#action-body-limit-error-message")).toContainText(
    "Body exceeded 1 MB limit",
  );
  await expect(page.locator("#action-body-limit-error-message")).not.toContainText(
    "NEXT_HTTP_ERROR_FALLBACK;500",
  );
});
