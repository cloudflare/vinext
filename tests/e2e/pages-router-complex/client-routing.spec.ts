import { test, expect } from "@playwright/test";

type BeaconWindow = Window & {
  __ATLAS_BEACONS__?: { name: string; attributes: Record<string, unknown> }[];
  __ATLAS_TRIALS_ACTIVE__?: string[];
  __nav_marker__?: boolean;
};

/**
 * Client-side routing behaviours: shallow router.push with the internal
 * dynamic-route pattern, router.events subscriptions, and the trial-mark
 * reset hook built on next/compat/router.
 */
test.describe("shallow routing and router events", () => {
  test.fixme("changing sort shallow-navigates without re-running gSSP", async ({ page }) => {
    await page.goto("/gallery/skies/clips");
    await expect(page.locator('[data-testid="gallery-wall"]')).toHaveAttribute(
      "data-sort",
      "featured",
    );

    // Plant a marker: a shallow transition must NOT be a full document load.
    await page.evaluate(() => {
      (window as BeaconWindow).__nav_marker__ = true;
    });

    await page.locator('[data-testid="wall-sort"]').selectOption("alpha");

    await page.waitForURL("**/gallery/skies/clips?sort=alpha");
    await expect(page.locator('[data-testid="gallery-wall"]')).toHaveAttribute(
      "data-sort",
      "alpha",
    );

    const marker = await page.evaluate(() => (window as BeaconWindow).__nav_marker__);
    expect(marker).toBe(true);

    // The wall reordered client-side (alpha puts "asset 0" first regardless).
    const titles = await page.locator('[data-testid="gallery-wall"] ol li').allTextContents();
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
  });

  test.fixme("shallow transitions fire router events observed by the progress frame", async ({
    page,
  }) => {
    await page.goto("/gallery/skies/clips");
    await expect(page.locator('[data-testid="route-progress"]')).toBeVisible();

    await page.locator('[data-testid="wall-sort"]').selectOption("newest");
    await page.waitForURL("**/gallery/skies/clips?sort=newest");

    const phases = await page.evaluate(() =>
      ((window as BeaconWindow).__ATLAS_BEACONS__ ?? [])
        .filter((b) => b.name === "route-change")
        .map((b) => b.attributes["phase"]),
    );
    expect(phases).toContain("start");
    expect(phases).toContain("complete");
    // start must precede complete
    expect(phases.indexOf("start")).toBeLessThan(phases.indexOf("complete"));
  });

  test.fixme("route changes reset the per-page trial marks", async ({ page }) => {
    await page.goto("/gallery/skies/clips");
    await page.evaluate(() => {
      (window as BeaconWindow).__ATLAS_TRIALS_ACTIVE__ = ["stale-flag"];
    });

    await page.locator('[data-testid="wall-sort"]').selectOption("alpha");
    await page.waitForURL("**/gallery/skies/clips?sort=alpha");

    const marks = await page.evaluate(() => (window as BeaconWindow).__ATLAS_TRIALS_ACTIVE__);
    expect(marks).toEqual([]);
  });

  test("a full load with a sort query flows through gSSP validation", async ({ page }) => {
    await page.goto("/gallery/skies/clips?sort=alpha");
    await expect(page.locator('[data-testid="gallery-wall"]')).toHaveAttribute(
      "data-sort",
      "alpha",
    );
  });
});
