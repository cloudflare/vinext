import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = `http://localhost:${process.env.VINEXT_APP_WITH_SRC_PORT ?? 4181}`;
const APP_FIXTURE = path.resolve(process.cwd(), "tests/fixtures/app-with-src");

// app-with-src is a bare-bones fixture: no global-error.tsx, no route-level
// error.tsx. That means a thrown error in /dev-overlay-recovery walks past
// every user-defined boundary and lands on vinext's internal
// DevRecoveryBoundary, exercising its componentDidCatch → drainPrePaintEffects
// path. The richer app-basic fixture has global-error.tsx and so always
// catches via the user boundary first; this spec covers the gap.

test.describe("Dev recovery boundary (no global-error.tsx)", () => {
  test("keeps an explicitly installed RSDW package as a supported runtime override", async ({
    page,
  }) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(APP_FIXTURE, "package.json"), "utf8"));
    expect(manifest.dependencies).toHaveProperty("react-server-dom-webpack");
    expect(fs.existsSync(path.join(APP_FIXTURE, "node_modules/react-server-dom-webpack"))).toBe(
      true,
    );

    await page.goto(`${BASE}/`);
    await expect(page.locator("#app-with-src-home")).toBeVisible();
    await waitForAppRouterHydration(page);

    const optimizerMetadata = JSON.parse(
      fs.readFileSync(path.join(APP_FIXTURE, "node_modules/.vite/deps_rsc/_metadata.json"), "utf8"),
    );
    expect(Object.keys(optimizerMetadata.optimized)).toContain(
      "react-server-dom-webpack/static.edge",
    );
    expect(Object.keys(optimizerMetadata.optimized)).not.toContain(
      "@vitejs/plugin-rsc/vendor/react-server-dom/static.edge",
    );
    expect(optimizerMetadata.optimized["react-server-dom-webpack/static.edge"].src).toContain(
      "react-server-dom-webpack",
    );
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
