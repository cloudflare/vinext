import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4181";

// app-with-src is a bare-bones fixture: no global-error.tsx, no route-level
// error.tsx. That means a thrown error in /dev-overlay-recovery walks past
// every user-defined boundary and lands on vinext's internal
// DevRecoveryBoundary, exercising its componentDidCatch → drainPrePaintEffects
// path. The richer app-basic fixture has global-error.tsx and so always
// catches via the user boundary first; this spec covers the gap.

test.describe("Dev recovery boundary (no global-error.tsx)", () => {
  test("reports an error the HTML render and the browser both throw once", async ({ page }) => {
    // The shell error sends the error document, and the browser's render
    // throws again, where vinext's dev recovery boundary catches it.
    const response = await page.goto(`${BASE}/dev-overlay-recovery`);
    expect(response?.status()).toBe(500);
    await page.waitForLoadState("networkidle");

    const dialog = page.getByTestId("vinext-dev-error-overlay");
    const indicator = page.getByTestId("vinext-dev-error-indicator");
    await expect(dialog.or(indicator).first()).toBeVisible({ timeout: 10_000 });
    if ((await dialog.count()) === 0) await indicator.click();
    // Once the document's copy of the error has been replayed, the overlay
    // shows only the browser's own report.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { __VINEXT_INITIAL_DEV_ERRORS__?: unknown[] })
              .__VINEXT_INITIAL_DEV_ERRORS__?.length,
        ),
      )
      .toBe(0);
    await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
      "dev-overlay-recovery: bare-bones render failure",
    );
    await expect(page.getByTestId("vinext-dev-error-pagination")).toBeHidden();
  });

  test("soft-nav to a broken route still updates the URL", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("#app-with-src-home")).toBeVisible();
    await waitForAppRouterHydration(page);
    await page.evaluate(() => {
      (window as unknown as { __vinextReloadCanary?: boolean }).__vinextReloadCanary = true;
    });

    await page.getByTestId("link-to-recovery").click();

    // The dev overlay surfaces the error.
    const indicator = page.getByTestId("vinext-dev-error-indicator");
    const dialog = page.getByTestId("vinext-dev-error-overlay");
    await expect(indicator.or(dialog).first()).toBeVisible({ timeout: 10_000 });
    if ((await indicator.count()) > 0 && (await dialog.count()) === 0) {
      await indicator.click();
    }
    await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
      "dev-overlay-recovery: bare-bones render failure",
    );

    // URL has moved — exercising the recovery hook in
    // DevRecoveryBoundary.componentDidCatch (NavigationCommitSignal never
    // gets to commit because BrowserRoot's slot subtree was replaced with
    // the boundary fallback, so its useLayoutEffect never runs).
    await expect(page).toHaveURL(`${BASE}/dev-overlay-recovery`, { timeout: 10_000 });

    // The canary survives — no full reload happened.
    const canary = await page.evaluate(
      () => (window as unknown as { __vinextReloadCanary?: boolean }).__vinextReloadCanary,
    );
    expect(canary).toBe(true);
  });
});
