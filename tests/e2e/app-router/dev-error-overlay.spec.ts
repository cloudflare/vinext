import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const SERVER_HMR_TOGGLE_FILE = path.join(
  process.cwd(),
  "tests/fixtures/app-basic/app/dev-overlay-hmr-toggle/server-hmr-toggle.tsx",
);
const LAYOUT_HMR_TOGGLE_FILE = path.join(
  process.cwd(),
  "tests/fixtures/app-basic/app/dev-overlay-layout-hmr-toggle/layout-hmr-toggle.tsx",
);
const CLIENT_HMR_TOGGLE_FILE = path.join(
  process.cwd(),
  "tests/fixtures/app-basic/app/dev-overlay-client-hmr-toggle/client-hmr-toggle.tsx",
);
const SERVER_HMR_TOGGLE_CLEAN = `export function ServerHmrToggle() {
  return <p data-testid="server-hmr-toggle">server hmr clean</p>;
}
`;
const SERVER_HMR_TOGGLE_BROKEN = `export function ServerHmrToggle() {
  throw new Error("server hmr toggle failure");
  return <p data-testid="server-hmr-toggle">server hmr clean</p>;
}
`;
const SERVER_HMR_TOGGLE_BUILD_ERROR = `export function ServerHmrToggle() {
  return <p data-testid="server-hmr-toggle" className="broken>server hmr clean</p>;
}
`;
const LAYOUT_HMR_TOGGLE_CLEAN = `export function LayoutHmrToggle() {
  return <p data-testid="layout-hmr-toggle">layout hmr clean</p>;
}
`;
const LAYOUT_HMR_TOGGLE_BROKEN = `export function LayoutHmrToggle() {
  throw new Error("layout hmr toggle failure");
  return <p data-testid="layout-hmr-toggle">layout hmr clean</p>;
}
`;
const CLIENT_HMR_TOGGLE_CLEAN = `"use client";

export function ClientHmrToggle() {
  return <p data-testid="client-hmr-toggle">client hmr clean</p>;
}
`;
const CLIENT_HMR_TOGGLE_BROKEN = `"use client";

export function ClientHmrToggle() {
  throw new Error("client hmr toggle failure");
  return <p data-testid="client-hmr-toggle">client hmr clean</p>;
}
`;
const CLIENT_HMR_TOGGLE_BROKEN_UPDATED = `"use client";

export function ClientHmrToggle() {
  throw new Error("client hmr updated failure");
  return <p data-testid="client-hmr-toggle">client hmr clean</p>;
}
`;
const CLIENT_HMR_TOGGLE_BUILD_ERROR = `"use client";

export function ClientHmrToggle() {
  return <p data-testid="client-hmr-toggle" className="broken>client hmr clean</p>;
}
`;

async function restoreHmrToggleFiles(): Promise<void> {
  await writeFileIfChanged(SERVER_HMR_TOGGLE_FILE, SERVER_HMR_TOGGLE_CLEAN);
  await writeFileIfChanged(LAYOUT_HMR_TOGGLE_FILE, LAYOUT_HMR_TOGGLE_CLEAN);
  await writeFileIfChanged(CLIENT_HMR_TOGGLE_FILE, CLIENT_HMR_TOGGLE_CLEAN);
}

async function writeFileIfChanged(file: string, content: string): Promise<void> {
  const current = await readFile(file, "utf8");
  if (current !== content) {
    await writeFile(file, content);
  }
}

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
    await page.keyboard.press("Escape");
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
    await page.keyboard.press("Escape");
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
      () => {
        const runtime = Reflect.get(window, Symbol.for("vinext.navigationRuntime"));
        return (
          typeof runtime === "object" &&
          runtime !== null &&
          "functions" in runtime &&
          typeof runtime.functions === "object" &&
          runtime.functions !== null &&
          "navigate" in runtime.functions &&
          typeof runtime.functions.navigate === "function"
        );
      },
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
    // navigation runtime the framework installs — the dispatched tree bumps
    // renderId, the boundary resets, and the home page renders without a
    // document reload.
    await page.evaluate(() => {
      const runtime = Reflect.get(window, Symbol.for("vinext.navigationRuntime"));
      const navigate =
        typeof runtime === "object" &&
        runtime !== null &&
        "functions" in runtime &&
        typeof runtime.functions === "object" &&
        runtime.functions !== null &&
        "navigate" in runtime.functions &&
        typeof runtime.functions.navigate === "function"
          ? runtime.functions.navigate
          : null;
      if (!navigate) throw new Error("App Router navigation runtime is not installed");
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

  test.describe("HMR updates", () => {
    test.describe.configure({ mode: "serial" });

    test.beforeEach(restoreHmrToggleFiles);
    test.afterEach(restoreHmrToggleFiles);

    test("server component HMR updates the overlay when a throw is toggled", async ({ page }) => {
      // Mirrors Next.js redbox recovery coverage:
      // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/error-on-next-codemod-comment/error-on-next-codemod-comment.test.ts
      await page.goto(`${BASE}/dev-overlay-hmr-toggle`);
      await expect(page.getByTestId("server-hmr-toggle")).toHaveText("server hmr clean");
      await expect(page.getByTestId("vinext-dev-error-overlay")).toBeHidden();
      await waitForAppRouterHydration(page);

      const waitForBrokenRsc = page.waitForResponse(
        (response) => isAppRouterRscRequestForPath(response.request(), "/dev-overlay-hmr-toggle"),
        { timeout: 10_000 },
      );
      await writeFile(SERVER_HMR_TOGGLE_FILE, SERVER_HMR_TOGGLE_BROKEN);
      await waitForBrokenRsc;
      await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
        "server hmr toggle failure",
        { timeout: 10_000 },
      );

      const waitForCleanRsc = page.waitForResponse(
        (response) => isAppRouterRscRequestForPath(response.request(), "/dev-overlay-hmr-toggle"),
        { timeout: 10_000 },
      );
      await writeFile(SERVER_HMR_TOGGLE_FILE, SERVER_HMR_TOGGLE_CLEAN);
      await waitForCleanRsc;
      await expect(page.getByTestId("vinext-dev-error-overlay")).toBeHidden({ timeout: 10_000 });
    });

    // FIXME(#1811): flaky — after writing the clean file back, the build-error
    // overlay intermittently stays visible past the 10s timeout in CI.
    // https://github.com/cloudflare/vinext/issues/1811
    test.fixme("server component HMR surfaces Vite build errors after a clean load", async ({
      page,
    }) => {
      // Next.js dev redbox labels build-time failures as "Build Error":
      // https://github.com/vercel/next.js/blob/canary/test/e2e/swc-plugins/index.test.ts
      await page.goto(`${BASE}/dev-overlay-hmr-toggle`);
      await expect(page.getByTestId("server-hmr-toggle")).toHaveText("server hmr clean");
      await expect(page.getByTestId("vinext-dev-error-overlay")).toBeHidden();
      await waitForAppRouterHydration(page);

      await writeFile(SERVER_HMR_TOGGLE_FILE, SERVER_HMR_TOGGLE_BUILD_ERROR);
      await expect(page.getByTestId("vinext-dev-error-title")).toHaveText("Build Error", {
        timeout: 10_000,
      });
      await expect(page.getByTestId("vinext-dev-error-build-message")).toBeVisible();
      await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
        "Transform failed with 1 error",
      );
      await expect(page.getByTestId("vinext-dev-error-build-message")).toContainText(
        "server-hmr-toggle.tsx",
      );
      await expect(page.getByTestId("vinext-dev-error-code-frame")).toBeHidden();
      await expect(page.getByTestId("vinext-dev-error-stack-container")).toBeHidden();
      await expect(page.locator("vite-error-overlay")).toHaveCount(0);

      const waitForCleanRsc = page.waitForResponse(
        (response) => isAppRouterRscRequestForPath(response.request(), "/dev-overlay-hmr-toggle"),
        { timeout: 10_000 },
      );
      await writeFile(SERVER_HMR_TOGGLE_FILE, SERVER_HMR_TOGGLE_CLEAN);
      await waitForCleanRsc;
      await expect(page.getByTestId("vinext-dev-error-overlay")).toBeHidden({ timeout: 10_000 });
    });

    test("layout server component HMR updates the overlay when a throw is toggled", async ({
      page,
    }) => {
      // Mirrors Next.js redbox recovery coverage:
      // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/error-on-next-codemod-comment/error-on-next-codemod-comment.test.ts
      await page.goto(`${BASE}/dev-overlay-layout-hmr-toggle`);
      await expect(page.getByTestId("layout-hmr-toggle")).toHaveText("layout hmr clean");
      await expect(page.getByTestId("vinext-dev-error-overlay")).toBeHidden();
      await waitForAppRouterHydration(page);

      const waitForBrokenRsc = page.waitForResponse(
        (response) =>
          isAppRouterRscRequestForPath(response.request(), "/dev-overlay-layout-hmr-toggle"),
        { timeout: 10_000 },
      );
      await writeFile(LAYOUT_HMR_TOGGLE_FILE, LAYOUT_HMR_TOGGLE_BROKEN);
      await waitForBrokenRsc;
      await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
        "layout hmr toggle failure",
        { timeout: 10_000 },
      );

      const waitForCleanRsc = page.waitForResponse(
        (response) =>
          isAppRouterRscRequestForPath(response.request(), "/dev-overlay-layout-hmr-toggle"),
        { timeout: 10_000 },
      );
      await writeFile(LAYOUT_HMR_TOGGLE_FILE, LAYOUT_HMR_TOGGLE_CLEAN);
      await waitForCleanRsc;
      await expect(page.getByTestId("vinext-dev-error-overlay")).toBeHidden({ timeout: 10_000 });
    });

    test("client component Fast Refresh updates the overlay when a throw is toggled", async ({
      page,
    }) => {
      await page.goto(`${BASE}/dev-overlay-client-hmr-toggle`);
      await expect(page.getByTestId("client-hmr-toggle")).toHaveText("client hmr clean");
      await expect(page.getByTestId("vinext-dev-error-overlay")).toBeHidden();
      await waitForAppRouterHydration(page);

      await writeFile(CLIENT_HMR_TOGGLE_FILE, CLIENT_HMR_TOGGLE_BROKEN);
      await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
        "client hmr toggle failure",
        { timeout: 10_000 },
      );

      await writeFile(CLIENT_HMR_TOGGLE_FILE, CLIENT_HMR_TOGGLE_CLEAN);
      await expect(page.getByTestId("client-hmr-toggle")).toHaveText("client hmr clean", {
        timeout: 10_000,
      });
      await expect(page.getByTestId("vinext-dev-error-overlay")).toBeHidden({ timeout: 10_000 });
    });

    test("client component Fast Refresh replaces a previous runtime error", async ({ page }) => {
      await page.goto(`${BASE}/dev-overlay-client-hmr-toggle`);
      await expect(page.getByTestId("client-hmr-toggle")).toHaveText("client hmr clean");
      await expect(page.getByTestId("vinext-dev-error-overlay")).toBeHidden();
      await waitForAppRouterHydration(page);

      await writeFile(CLIENT_HMR_TOGGLE_FILE, CLIENT_HMR_TOGGLE_BROKEN);
      await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
        "client hmr toggle failure",
        { timeout: 10_000 },
      );

      await writeFile(CLIENT_HMR_TOGGLE_FILE, CLIENT_HMR_TOGGLE_BROKEN_UPDATED);
      await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
        "client hmr updated failure",
        { timeout: 10_000 },
      );
      await expect(page.getByTestId("vinext-dev-error-message")).not.toContainText(
        "client hmr toggle failure",
      );
      await expect(page.getByTestId("vinext-dev-error-pagination")).toBeHidden();
    });

    test("client component build errors replace a previous runtime error", async ({ page }) => {
      await page.goto(`${BASE}/dev-overlay-client-hmr-toggle`);
      await expect(page.getByTestId("client-hmr-toggle")).toHaveText("client hmr clean");
      await expect(page.getByTestId("vinext-dev-error-overlay")).toBeHidden();
      await waitForAppRouterHydration(page);

      await writeFile(CLIENT_HMR_TOGGLE_FILE, CLIENT_HMR_TOGGLE_BROKEN);
      await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
        "client hmr toggle failure",
        { timeout: 10_000 },
      );

      await writeFile(CLIENT_HMR_TOGGLE_FILE, CLIENT_HMR_TOGGLE_BUILD_ERROR);
      await expect(page.getByTestId("vinext-dev-error-title")).toHaveText("Build Error", {
        timeout: 10_000,
      });
      await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
        "Transform failed with 1 error",
      );
      await expect(page.getByTestId("vinext-dev-error-message")).not.toContainText(
        "client hmr toggle failure",
      );
      await expect(page.getByTestId("vinext-dev-error-pagination")).toBeHidden();
    });
  });
});
