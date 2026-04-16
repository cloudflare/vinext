import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

async function clickRapidlyByTestIds(page: Page, testIds: readonly string[]): Promise<void> {
  const targets = await Promise.all(
    testIds.map(async (testId) => {
      const box = await page.locator(`[data-testid="${testId}"]`).boundingBox();
      if (!box) {
        throw new Error(`Missing clickable target: ${testId}`);
      }
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }),
  );

  for (const target of targets) {
    await page.mouse.click(target.x, target.y);
  }
}

test.describe("rapid navigation", () => {
  test("A→B→C rapid navigation completes smoothly", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    // Start at page A
    await page.goto(`${BASE}/nav-rapid/page-a`);
    await expect(page.locator("h1")).toHaveText("Page A");
    await waitForAppRouterHydration(page);
    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = "started-at-a";
    });

    // Trigger B then C with trusted clicks dispatched back-to-back.
    await clickRapidlyByTestIds(page, ["page-a-link-to-b", "page-a-link-to-c"]);

    // Use toHaveURL (polling) instead of waitForURL (navigation event) because
    // rapid back-to-back client-side navigations abort the first navigation,
    // causing waitForURL to fail with ERR_ABORTED.
    await expect(page).toHaveURL(`${BASE}/nav-rapid/page-c`, { timeout: 10_000 });
    await expect(page.locator("h1")).toHaveText("Page C");
    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe("started-at-a");

    const navigationErrors = errors.filter(
      (e) => e.includes("navigation") || e.includes("vinext") || e.includes("router"),
    );
    expect(navigationErrors).toHaveLength(0);
  });

  test("same-route query change during cross-route navigation", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    // Start at page A
    await page.goto(`${BASE}/nav-rapid/page-a`);
    await expect(page.locator("h1")).toHaveText("Page A");
    await waitForAppRouterHydration(page);
    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = "started-at-a";
    });

    // Trigger B then B?filter=test with trusted back-to-back clicks.
    await clickRapidlyByTestIds(page, ["page-a-link-to-b", "page-a-link-to-b-filter"]);

    // Should settle on B with query param
    await expect(page.locator("h1")).toHaveText("Page B");
    await expect(page).toHaveURL(`${BASE}/nav-rapid/page-b?filter=test`);
    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe("started-at-a");

    // Verify no navigation-related errors
    const navigationErrors = errors.filter(
      (e) => e.includes("navigation") || e.includes("vinext") || e.includes("router"),
    );
    expect(navigationErrors).toHaveLength(0);
  });
});
