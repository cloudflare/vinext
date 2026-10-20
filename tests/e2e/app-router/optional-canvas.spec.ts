import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

test("hydrates client components without reloading", async ({ page }) => {
  let documentRequests = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests++;
  });
  await page.goto("/interactive");
  await waitForAppRouterHydration(page);
  await page.getByRole("button", { name: "Increment", exact: true }).click();
  await expect(page.getByTestId("count")).toHaveText("Count: 1");
  expect(documentRequests).toBe(1);
});

test("client dependencies can catch missing optional server-external packages", async ({
  page,
}) => {
  // Regression for https://github.com/cloudflare/vinext/issues/3484.
  await page.goto("/optional-canvas");
  await page.getByRole("button", { name: "unloaded", exact: true }).click();
  await expect(page.getByRole("button", { name: "fallback", exact: true })).toBeVisible();
});
