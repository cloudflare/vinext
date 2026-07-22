import { expect, test } from "@playwright/test";
import { disableDevErrorOverlay } from "../helpers";

const BASE = "http://localhost:4174";

async function triggerPostsError(page: import("@playwright/test").Page) {
  await disableDevErrorOverlay(page);

  await expect(page.getByTestId("posts-error-trigger")).toBeVisible({
    timeout: 10_000,
  });

  await expect(async () => {
    await page.getByTestId("posts-error-trigger").click({ noWaitAfter: true });
    await expect(page.getByTestId("posts-error-boundary")).toBeVisible({
      timeout: 10_000,
    });
  }).toPass({ timeout: 20_000 });
}

test.describe("route reset key collisions", () => {
  test("dynamic branches with the same leaf param value clear captured route errors", async ({
    page,
  }) => {
    await page.goto(`${BASE}/reset-collision/posts/123`);
    await expect(page.getByTestId("posts-page")).toHaveText("Posts 123");

    await triggerPostsError(page);

    await page.getByTestId("to-photos-123").click();

    await expect(page.getByTestId("photos-page")).toHaveText("Photos 123");
    await expect(page.getByTestId("posts-error-boundary")).not.toBeAttached();
  });

  test("static branches with the same leaf segment remount route loading", async ({ page }) => {
    await page.goto(`${BASE}/reset-collision/account/settings`);
    await expect(page.getByTestId("account-settings-page")).toHaveText("Account settings");

    await page.getByTestId("to-admin-settings").click();

    await expect(page.getByTestId("admin-settings-loading")).toBeVisible();
    await expect(page.getByTestId("admin-settings-page")).toHaveText("Admin settings");
  });
});
