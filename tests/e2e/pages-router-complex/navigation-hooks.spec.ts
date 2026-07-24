import { test, expect } from "@playwright/test";

/**
 * App Router navigation hooks (`useSearchParams`, `usePathname` from
 * next/navigation) used inside a Pages Router page, combined with direct
 * window.history.replaceState query updates that bypass the router.
 */
test.describe("next/navigation hooks in the pages router", () => {
  test("useSearchParams seeds the initial filter from the URL", async ({ page }) => {
    await page.goto("/gallery/directory/a-z?desk=tides");
    await expect(page.locator('[data-testid="directory-a-z"]')).toHaveAttribute(
      "data-desk",
      "tides",
    );
    const rows = await page.locator('[data-testid="directory-a-z"] ul li').allTextContents();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.startsWith("Tides"))).toBe(true);
  });

  test("usePathname reports the public pathname", async ({ page }) => {
    await page.goto("/gallery/directory/a-z");
    await expect(page.locator('[data-testid="directory-a-z"]')).toHaveAttribute(
      "data-pathname",
      "/gallery/directory/a-z",
    );
  });

  test.fixme("filter changes update the URL via history.replaceState without navigating", async ({
    page,
  }) => {
    await page.goto("/gallery/directory/a-z");
    await page.evaluate(() => {
      (window as Window & { __nav_marker__?: boolean }).__nav_marker__ = true;
    });

    await page.locator('[data-testid="desk-filter"]').selectOption("forests");

    // URL updated in place...
    await page.waitForURL("**/gallery/directory/a-z?desk=forests");
    await expect(page.locator('[data-testid="directory-a-z"]')).toHaveAttribute(
      "data-desk",
      "forests",
    );

    // ...with neither a document load nor a router transition.
    const state = await page.evaluate(() => {
      const w = window as Window & {
        __nav_marker__?: boolean;
        __ATLAS_BEACONS__?: { name: string }[];
      };
      return {
        marker: w.__nav_marker__,
        routeChanges: (w.__ATLAS_BEACONS__ ?? []).filter((b) => b.name === "route-change").length,
      };
    });
    expect(state.marker).toBe(true);
    expect(state.routeChanges).toBe(0);
  });

  test("the directory page is a static sibling beating the gallery catch-all", async ({ page }) => {
    await page.goto("/gallery/directory/a-z");
    await expect(page.locator('[data-testid="directory-a-z"]')).toBeVisible();
    await expect(page.locator('[data-testid="gallery-wall"]')).toHaveCount(0);
  });
});
