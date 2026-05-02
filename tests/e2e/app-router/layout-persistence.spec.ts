import { test, expect } from "@playwright/test";
import { disableDevErrorOverlay, waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

type CounterControls = {
  countTestId: string;
  incrementTestId: string;
  label: string;
};

async function readCounterValue(
  page: import("@playwright/test").Page,
  { countTestId, label }: CounterControls,
): Promise<number> {
  const text = await page.getByTestId(countTestId).textContent();
  if (text == null) {
    throw new Error(`Missing counter text for ${countTestId}`);
  }

  const expectedPrefix = `${label}: `;
  if (!text.startsWith(expectedPrefix)) {
    throw new Error(`Unexpected counter text for ${countTestId}: ${text}`);
  }

  return Number.parseInt(text.slice(expectedPrefix.length), 10);
}

async function waitForInteractiveCounter(
  page: import("@playwright/test").Page,
  controls: CounterControls,
): Promise<number> {
  const incrementButton = page.getByTestId(controls.incrementTestId);
  await incrementButton.waitFor({ state: "visible" });

  await expect(async () => {
    const before = await readCounterValue(page, controls);
    await incrementButton.click();
    const after = await readCounterValue(page, controls);
    expect(after).toBeGreaterThan(before);
  }).toPass({ timeout: 10_000 });

  return readCounterValue(page, controls);
}

async function incrementCounter(
  page: import("@playwright/test").Page,
  controls: CounterControls,
  expectedValue: number,
) {
  await page.getByTestId(controls.incrementTestId).click();
  await expect(page.getByTestId(controls.countTestId)).toHaveText(
    `${controls.label}: ${expectedValue}`,
  );
}

const layoutCounter = {
  countTestId: "layout-count",
  incrementTestId: "layout-increment",
  label: "Layout count",
} as const;

const templateCounter = {
  countTestId: "template-count",
  incrementTestId: "template-increment",
  label: "Template count",
} as const;

// ---------------------------------------------------------------------------
// 1. Layout persistence — navigate between sibling routes, prove the layout
//    DOM survives and client state in it persists.
// ---------------------------------------------------------------------------

test.describe("Layout persistence", () => {
  test("dashboard layout counter survives sibling navigation", async ({ page }) => {
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator("h1")).toHaveText("Dashboard");
    await waitForAppRouterHydration(page);

    // Prove the counter is interactive before asserting exact values.
    const initialCount = await waitForInteractiveCounter(page, layoutCounter);
    await incrementCounter(page, layoutCounter, initialCount + 1);
    await incrementCounter(page, layoutCounter, initialCount + 2);

    // Navigate to settings (sibling route under same layout)
    await page.getByTestId("dash-settings-link").click();
    await expect(page.locator("h1")).toHaveText("Settings");

    // Layout counter should preserve its value — the layout was NOT remounted.
    await expect(page.getByTestId("layout-count")).toHaveText(`Layout count: ${initialCount + 2}`);

    // Navigate back to dashboard home
    await page.getByTestId("dash-home-link").click();
    await expect(page.locator("h1")).toHaveText("Dashboard");

    await expect(page.getByTestId("layout-count")).toHaveText(`Layout count: ${initialCount + 2}`);
  });

  test("layout counter resets on hard navigation", async ({ page }) => {
    await page.goto(`${BASE}/dashboard`);
    await waitForAppRouterHydration(page);

    const countAfterHydration = await waitForInteractiveCounter(page, layoutCounter);
    await incrementCounter(page, layoutCounter, countAfterHydration + 1);
    await incrementCounter(page, layoutCounter, countAfterHydration + 2);

    // Hard navigation (full page load) should reset everything
    await page.goto(`${BASE}/dashboard`);
    await waitForAppRouterHydration(page);

    await expect(page.getByTestId("layout-count")).toHaveText("Layout count: 0");
  });
});

// ---------------------------------------------------------------------------
// 2. Template remount — prove template state resets on segment boundary
//    change but persists on search param change.
// ---------------------------------------------------------------------------

test.describe("Template remount", () => {
  test("root template counter resets when navigating between top-level segments", async ({
    page,
  }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");
    await waitForAppRouterHydration(page);

    const initialCount = await waitForInteractiveCounter(page, templateCounter);
    await incrementCounter(page, templateCounter, initialCount + 1);

    // Navigate to /about — this changes the root segment from "" to "about",
    // so the root template should remount and the counter should reset.
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    await expect(page.getByTestId("template-count")).toHaveText("Template count: 0");
  });

  test("root template counter persists within same top-level segment", async ({ page }) => {
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator("h1")).toHaveText("Dashboard");
    await waitForAppRouterHydration(page);

    const initialCount = await waitForInteractiveCounter(page, templateCounter);
    await incrementCounter(page, templateCounter, initialCount + 1);

    // Navigate to /dashboard/settings — this is still under the "dashboard"
    // top-level segment, so the root template should NOT remount.
    await page.getByTestId("dash-settings-link").click();
    await expect(page.locator("h1")).toHaveText("Settings");

    await expect(page.getByTestId("template-count")).toHaveText(
      `Template count: ${initialCount + 1}`,
    );
  });

  test("template counter does not reset on search param change within same segment", async ({
    page,
  }) => {
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator("h1")).toHaveText("Dashboard");
    await waitForAppRouterHydration(page);

    const initialCount = await waitForInteractiveCounter(page, templateCounter);
    await incrementCounter(page, templateCounter, initialCount + 1);

    // Navigate to /dashboard?tab=settings — same pathname, only search params change.
    // The root segment stays "dashboard", so the root template must NOT remount.
    await page.getByTestId("dash-tab-link").click();
    await expect(page.locator("h1")).toHaveText("Dashboard");

    await expect(page.getByTestId("template-count")).toHaveText(
      `Template count: ${initialCount + 1}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Error recovery — trigger an error, navigate away via client nav,
//    navigate back, prove the error is gone and normal content renders.
// ---------------------------------------------------------------------------

test.describe("Error recovery across navigation", () => {
  test("navigating away from error and back clears the error", async ({ page }) => {
    await page.goto(`${BASE}/error-test`);
    await expect(page.locator('[data-testid="error-content"]')).toBeVisible();
    await waitForAppRouterHydration(page);

    // Trigger error
    await page.getByTestId("trigger-error").waitFor({ state: "visible" });
    await page.getByTestId("trigger-error").click();

    // Error boundary should be visible
    await expect(page.locator("#error-boundary")).toBeVisible({ timeout: 10_000 });

    // Hide the dev error overlay so its modal backdrop doesn't block the
    // error.tsx fallback's "Go home" link.
    await disableDevErrorOverlay(page);

    // Client-navigate away to home via the link in the error boundary
    await page.click('[data-testid="error-go-home"]');
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");

    // Client-navigate back to error-test via link on home page
    await page.click('[data-testid="error-test-link"]');

    // Error should be gone — fresh page renders normally
    await expect(page.locator('[data-testid="error-content"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("#error-boundary")).not.toBeAttached();
  });
});

// ---------------------------------------------------------------------------
// 4. Back/forward — navigate through a sequence, go back, prove layout
//    state survived the round trip.
// ---------------------------------------------------------------------------

test.describe("Back/forward with layout state", () => {
  test("browser back preserves layout counter across navigation history", async ({ page }) => {
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator("h1")).toHaveText("Dashboard");
    await waitForAppRouterHydration(page);

    const initialCount = await waitForInteractiveCounter(page, layoutCounter);
    await incrementCounter(page, layoutCounter, initialCount + 1);

    // Navigate: dashboard → settings
    await page.getByTestId("dash-settings-link").click();
    await expect(page.locator("h1")).toHaveText("Settings");

    await expect(page.getByTestId("layout-count")).toHaveText(`Layout count: ${initialCount + 1}`);

    // Increment once more while on settings
    await incrementCounter(page, layoutCounter, initialCount + 2);

    // Go back to dashboard
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Dashboard");

    await expect(page.getByTestId("layout-count")).toHaveText(`Layout count: ${initialCount + 2}`);

    // Go forward to settings
    await page.goForward();
    await expect(page.locator("h1")).toHaveText("Settings");

    await expect(page.getByTestId("layout-count")).toHaveText(`Layout count: ${initialCount + 2}`);
  });
});

// ---------------------------------------------------------------------------
// 5. Parallel slots — soft nav keeps slot content; hard load shows default.
// ---------------------------------------------------------------------------

test.describe("Parallel slot persistence", () => {
  test("parallel slot content persists on soft navigation to child route", async ({ page }) => {
    // Load /dashboard — parallel slots @team and @analytics have page.tsx
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator("h1")).toHaveText("Dashboard");
    await waitForAppRouterHydration(page);

    // Verify slot content is visible
    await expect(page.locator('[data-testid="team-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="team-slot"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-slot"]')).toBeVisible();

    // Soft navigate to /dashboard/settings
    await page.click('[data-testid="dash-settings-link"]');
    await expect(page.locator("h1")).toHaveText("Settings");

    // Parallel slot content should persist from the soft nav —
    // the slots don't have a page.tsx for /settings, so the previous
    // slot content is retained (absent key = persisted from prior soft nav).
    await expect(page.locator('[data-testid="team-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="team-slot"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-slot"]')).toBeVisible();
    await expect(page.locator('[data-testid="team-default"]')).not.toBeAttached();
    await expect(page.locator('[data-testid="analytics-default"]')).not.toBeAttached();
  });

  test("parallel slots show default.tsx on hard navigation to child route", async ({ page }) => {
    // Hard-load /dashboard/settings directly — slots should show default.tsx
    await page.goto(`${BASE}/dashboard/settings`);
    await expect(page.locator("h1")).toHaveText("Settings");
    await waitForAppRouterHydration(page);

    // On hard load, slots should render their default.tsx content
    await expect(page.locator('[data-testid="team-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="team-default"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-default"]')).toBeVisible();

    // The page-specific slot content should NOT be visible
    await expect(page.locator('[data-testid="team-slot"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="analytics-slot"]')).not.toBeVisible();
  });
});
