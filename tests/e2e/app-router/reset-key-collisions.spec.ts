import { expect, test } from "@playwright/test";
import { disableDevErrorOverlay } from "../helpers";

const BASE = "http://localhost:4174";

async function triggerError(page: import("@playwright/test").Page, label: string) {
  await disableDevErrorOverlay(page);

  await expect(page.getByTestId(`${label}-error-trigger`)).toBeVisible({
    timeout: 10_000,
  });

  await expect(async () => {
    await page.getByTestId(`${label}-error-trigger`).click({ noWaitAfter: true });
    await expect(page.getByTestId(`${label}-error-boundary`)).toBeVisible({
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

    await triggerError(page, "posts");

    await page.getByTestId("to-photos-123").click();

    await expect(page.getByTestId("photos-page")).toHaveText("Photos 123");
    await expect(page.getByTestId("posts-error-boundary")).not.toBeAttached();
  });

  test("a pathname change below an unchanged segment clears an ancestor's captured error", async ({
    page,
  }) => {
    // Next.js's ErrorBoundary clears on any visible pathname change, not only
    // when the segment below it remounts: here that segment stays "guide".
    await page.goto(`${BASE}/reset-collision/docs/guide/a`);
    await expect(page.getByTestId("docs-guide-page")).toHaveText("Docs guide a");

    await triggerError(page, "docs");
    await page.evaluate(() => {
      (window as Window & { __clientNavMarker?: boolean }).__clientNavMarker = true;
    });

    await page.getByTestId("to-docs-guide-b").click();

    await expect(page.getByTestId("docs-guide-page")).toHaveText("Docs guide b");
    await expect(page.getByTestId("docs-error-boundary")).not.toBeAttached();
    // A full document load would recreate the boundary.
    expect(
      await page.evaluate(
        () => (window as Window & { __clientNavMarker?: boolean }).__clientNavMarker,
      ),
    ).toBe(true);
  });

  test("static branches with the same leaf segment remount route loading", async ({ page }) => {
    await page.goto(`${BASE}/reset-collision/account/settings`);
    await expect(page.getByTestId("account-settings-page")).toHaveText("Account settings");

    await page.getByTestId("to-admin-settings").click();

    await expect(page.getByTestId("admin-settings-loading")).toBeVisible();
    await expect(page.getByTestId("admin-settings-page")).toHaveText("Admin settings");
  });
});
