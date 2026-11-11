import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

// Next.js ignores next/head in the App Router: server components get a no-op
// Head, and client components see a HeadManagerContext without
// mountedInstances, so the document head only holds the Metadata API output.
// The Pages Router still applies the same client component's tags.
// https://github.com/cloudflare/vinext/issues/4589
test.describe("next/head in the App Router", () => {
  test("a client layout's next/head tags do not override metadata after hydration", async ({
    page,
  }) => {
    await page.goto(`${BASE}/next-head-ignored`);
    await waitForAppRouterHydration(page);
    // Rendered after the layout's effects ran, so a Head sync would be done.
    await expect(page.locator("#next-head-layout-mounted")).toBeVisible();

    await expect(page).toHaveTitle("next-head-ignored metadata title");
    await expect(page.locator('meta[name="next-head-client"]')).toHaveCount(0);
    await expect(page.locator('meta[name="description"]')).toHaveCount(1);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      "next-head-ignored metadata description",
    );
    await expect(page.locator('meta[name="viewport"]')).toHaveCount(1);
    await expect(page.locator("[data-next-head]")).toHaveCount(0);
  });

  test("a server component renders next/head as nothing", async ({ page }) => {
    const response = await page.goto(`${BASE}/next-head-ignored/server-component`);
    expect(response?.status()).toBe(200);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#next-head-layout-mounted")).toBeVisible();

    await expect(page.locator("#next-head-server-component")).toBeVisible();
    await expect(page).toHaveTitle("next-head-ignored server component metadata title");
    await expect(page.locator('meta[name="next-head-server"]')).toHaveCount(0);
    await expect(page.locator('meta[name="next-head-client"]')).toHaveCount(0);
  });

  test("client navigation keeps the metadata title", async ({ page }) => {
    await page.goto(`${BASE}/next-head-ignored`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#next-head-layout-mounted")).toBeVisible();

    // Marker survives a soft navigation but is wiped by a full page reload.
    await page.evaluate(() => {
      (window as { __NEXT_HEAD_SOFT_NAV_MARKER__?: string }).__NEXT_HEAD_SOFT_NAV_MARKER__ =
        "alive";
    });

    await page.click("#next-head-server-link");
    await expect(page.locator("#next-head-server-component")).toBeVisible();
    await expect(page).toHaveTitle("next-head-ignored server component metadata title");
    await expect(page.locator('meta[name="next-head-server"]')).toHaveCount(0);
    await expect(page.locator('meta[name="next-head-client"]')).toHaveCount(0);

    const marker = await page.evaluate(
      () => (window as { __NEXT_HEAD_SOFT_NAV_MARKER__?: string }).__NEXT_HEAD_SOFT_NAV_MARKER__,
    );
    expect(marker).toBe("alive");
  });

  test("the same client layout still applies next/head in the Pages Router", async ({ page }) => {
    await page.goto(`${BASE}/next-head-shared`);
    await expect(page.locator("#next-head-layout-mounted")).toBeVisible();

    await expect(page).toHaveTitle("next/head title");
    await expect(page.locator('meta[name="next-head-client"]')).toHaveAttribute(
      "content",
      "applied",
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      "next/head description",
    );
  });
});
