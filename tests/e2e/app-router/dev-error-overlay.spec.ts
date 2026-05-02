import { test, expect, type Page } from "@playwright/test";

const BASE = "http://localhost:4174";

// React doesn't attach onClick until hydration completes. The click can land
// before that, so retry until the overlay (or its minimized indicator) shows
// up — matches the hydration-aware polling in error-interactive.spec.ts.
async function clickUntilOverlay(page: Page, triggerTestId: string): Promise<void> {
  const trigger = page.getByTestId(triggerTestId);
  const dialog = page.getByTestId("vinext-dev-error-overlay");
  const indicator = page.getByTestId("vinext-dev-error-indicator");
  // Either the dialog or the corner indicator means the click landed.
  const visibleSurface = dialog.or(indicator);

  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await expect(async () => {
    await trigger.click({ noWaitAfter: true });
    await expect(visibleSurface.first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  // Caught errors start minimized; expand so callers can assert against the
  // full dialog content. Dialog-already-visible cases (window-error,
  // unhandled-rejection, etc.) are no-ops here.
  if ((await indicator.count()) > 0 && (await dialog.count()) === 0) {
    await indicator.click();
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }
}

test.describe("Dev error overlay", () => {
  test("surfaces React render errors with no error.tsx boundary", async ({ page }) => {
    await page.goto(`${BASE}/dev-overlay-test`);
    await expect(page.getByTestId("dev-overlay-content")).toBeVisible();

    await clickUntilOverlay(page, "trigger-render-error");

    // Title may be "Runtime Error" (caught by NotFoundBoundary's
    // getDerivedStateFromError before it rethrows) or "Unhandled Runtime Error"
    // depending on which React error callback fires last. Either is fine — the
    // point is that the developer sees the error.
    await expect(page.getByTestId("vinext-dev-error-title")).toContainText("Runtime Error");
    await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
      "DropZone is not defined",
    );
  });

  test("surfaces global script errors via window.onerror", async ({ page }) => {
    await page.goto(`${BASE}/dev-overlay-test`);
    await expect(page.getByTestId("dev-overlay-content")).toBeVisible();

    await clickUntilOverlay(page, "trigger-window-error");

    await expect(page.getByTestId("vinext-dev-error-title")).toHaveText("Unhandled Script Error");
    await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
      "uncaught timer error",
    );
  });

  test("surfaces unhandled promise rejections", async ({ page }) => {
    await page.goto(`${BASE}/dev-overlay-test`);
    await expect(page.getByTestId("dev-overlay-content")).toBeVisible();

    await clickUntilOverlay(page, "trigger-unhandled-rejection");

    await expect(page.getByTestId("vinext-dev-error-title")).toHaveText(
      "Unhandled Promise Rejection",
    );
    await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
      "unhandled rejection from button",
    );
  });

  test("dismiss button hides the overlay", async ({ page }) => {
    await page.goto(`${BASE}/dev-overlay-test`);
    await clickUntilOverlay(page, "trigger-window-error");

    await page.getByTestId("vinext-dev-error-close").click();
    await expect(page.getByTestId("vinext-dev-error-overlay")).toBeHidden();
  });

  test("subsequent errors update the overlay and expose pagination", async ({ page }) => {
    await page.goto(`${BASE}/dev-overlay-test`);
    await clickUntilOverlay(page, "trigger-window-error");
    // With a single error, pagination is not rendered.
    await expect(page.getByTestId("vinext-dev-error-pagination")).toBeHidden();

    // The dialog covers the page; minimize so the next trigger is reachable.
    await page.getByTestId("vinext-dev-error-minimize").click();
    await page.getByTestId("trigger-unhandled-rejection").click();
    // A non-caught error re-expands the dialog automatically.
    await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
      "unhandled rejection from button",
    );
    await expect(page.getByTestId("vinext-dev-error-counter")).toHaveText("2 of 2");
  });

  test("prev/next pagination switches between reported errors", async ({ page }) => {
    await page.goto(`${BASE}/dev-overlay-test`);
    await clickUntilOverlay(page, "trigger-window-error");
    await page.getByTestId("vinext-dev-error-minimize").click();
    await page.getByTestId("trigger-unhandled-rejection").click();
    await expect(page.getByTestId("vinext-dev-error-counter")).toHaveText("2 of 2");

    await page.getByTestId("vinext-dev-error-prev").click();
    await expect(page.getByTestId("vinext-dev-error-counter")).toHaveText("1 of 2");
    await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
      "uncaught timer error",
    );

    await page.getByTestId("vinext-dev-error-next").click();
    await expect(page.getByTestId("vinext-dev-error-counter")).toHaveText("2 of 2");
    await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
      "unhandled rejection from button",
    );
  });

  test("renders a parsed stack when one is available", async ({ page }) => {
    await page.goto(`${BASE}/dev-overlay-test`);
    await clickUntilOverlay(page, "trigger-window-error");

    const stack = page.getByTestId("vinext-dev-error-stack");
    await expect(stack).toBeVisible();
    // Each frame is its own <li>; we should see at least one.
    await expect(stack.locator("li")).not.toHaveCount(0);
  });

  // A soft-nav to a route whose render throws should still move the URL to
  // that route, so the dev overlay surfaces which page is broken and HMR's
  // rsc:update — which fetches RSC for window.location.pathname — targets
  // the route the developer is actually editing.
  test("soft-nav to a broken route still updates the URL", async ({ page }) => {
    await page.goto(`${BASE}/dev-overlay-test`);
    await expect(page.getByTestId("dev-overlay-content")).toBeVisible();
    await expect(page.getByTestId("link-to-broken")).toBeVisible();
    // Wait for the Link's onClick handler to attach so the click drives a soft
    // RSC navigation (with historyUpdateMode = "push") instead of a full reload.
    await page.waitForFunction(
      () =>
        typeof (window as unknown as { __VINEXT_RSC_NAVIGATE__?: unknown })
          .__VINEXT_RSC_NAVIGATE__ === "function",
      undefined,
      { timeout: 10_000 },
    );
    await page.evaluate(() => {
      (window as unknown as { __vinextReloadCanary?: boolean }).__vinextReloadCanary = true;
    });

    await page.getByTestId("link-to-broken").click();

    // The error is caught by the user's global-error.tsx, so it surfaces as a
    // minimized indicator rather than a full dialog. Expand it to inspect the
    // message.
    const indicator = page.getByTestId("vinext-dev-error-indicator");
    const dialog = page.getByTestId("vinext-dev-error-overlay");
    await expect(indicator.or(dialog).first()).toBeVisible({ timeout: 10_000 });
    if ((await indicator.count()) > 0 && (await dialog.count()) === 0) {
      await indicator.click();
    }
    await expect(dialog).toBeVisible({ timeout: 2_000 });
    await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
      "dev-overlay-broken: client render failure",
    );

    // URL has moved to the navigation target rather than being stuck on the
    // previous page.
    await expect(page).toHaveURL(`${BASE}/dev-overlay-broken`, { timeout: 10_000 });

    // No full reload happened — the canary set before the navigation is still
    // there.
    const canary = await page.evaluate(
      () => (window as unknown as { __vinextReloadCanary?: boolean }).__vinextReloadCanary,
    );
    expect(canary).toBe(true);
  });

  // The dev recovery boundary should keep BrowserRoot mounted when a render
  // error fires, so navigating away resets the boundary and lands on a fresh
  // page without a full document reload. The window-level canary survives
  // soft navigation but not a full reload.
  test("render error does not trigger a full page reload", async ({ page }) => {
    await page.goto(`${BASE}/dev-overlay-test`);
    await page.evaluate(() => {
      (window as unknown as { __vinextReloadCanary?: boolean }).__vinextReloadCanary = true;
    });

    await clickUntilOverlay(page, "trigger-render-error");

    const canaryAfterError = await page.evaluate(
      () => (window as unknown as { __vinextReloadCanary?: boolean }).__vinextReloadCanary,
    );
    expect(canaryAfterError).toBe(true);

    // The boundary itself rendered null, so any in-page link inside the route
    // tree is gone. Drive a soft RSC navigation programmatically through the
    // global hook the framework installs — the dispatched tree bumps
    // renderId, the boundary resets, and the home page renders without a
    // document reload.
    await page.evaluate(() => {
      const navigate = (window as unknown as { __VINEXT_RSC_NAVIGATE__?: (href: string) => void })
        .__VINEXT_RSC_NAVIGATE__;
      if (!navigate) throw new Error("__VINEXT_RSC_NAVIGATE__ is not installed");
      navigate("/");
    });
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");

    const canaryAfterNav = await page.evaluate(
      () => (window as unknown as { __vinextReloadCanary?: boolean }).__vinextReloadCanary,
    );
    expect(canaryAfterNav).toBe(true);
  });

  test("clicking the backdrop minimizes the dialog to a corner indicator", async ({ page }) => {
    await page.goto(`${BASE}/dev-overlay-test`);
    await clickUntilOverlay(page, "trigger-window-error");

    // Click the backdrop (an area outside the dialog rectangle) — proper
    // modal behavior: dismisses the overlay without reaching the page
    // underneath.
    await page.getByTestId("vinext-dev-error-backdrop").click({ position: { x: 5, y: 5 } });

    await expect(page.getByTestId("vinext-dev-error-overlay")).toBeHidden();
    const indicator = page.getByTestId("vinext-dev-error-indicator");
    await expect(indicator).toBeVisible();
    await expect(page.getByTestId("vinext-dev-error-indicator-count")).toHaveText("1");

    // Clicking the indicator restores the full dialog.
    await indicator.click();
    await expect(page.getByTestId("vinext-dev-error-overlay")).toBeVisible();
    await expect(indicator).toBeHidden();
  });
});
