import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";
const ROUTE_ROOT = "/nextjs-compat/gesture-transitions";

test.describe("Next.js compat: gesture transitions", () => {
  // Ported from Next.js: test/e2e/app-dir/gesture-transitions/gesture-transitions.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/gesture-transitions/gesture-transitions.test.ts
  test("shows optimistic state during gesture, then canonical state after", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE_ROOT}`);
    await waitForAppRouterHydration(page);

    await expect(page.getByTestId("home-page")).toContainText("Home");

    await page.getByTestId("start-gesture").click();

    const targetPage = page.getByTestId("target-page");
    await expect(targetPage).toContainText("Target Page");

    await expect(page.getByTestId("static-content")).toHaveText("This is static content");

    expect(page.url()).toContain(`${ROUTE_ROOT}/target-page`);

    // Note: like the upstream test, this deliberately does not assert the
    // negative held state (`loading` visible / `dynamic-content` absent)
    // during the gesture. Upstream omits it because observing the suspended
    // dynamic hole would require `FreshnessPolicy.Gesture` static-shell
    // behavior, which is out of scope here too. In vinext specifically, the
    // gesture commit performs a full RSC navigation rather than rendering a
    // prefetched static shell, and `connection()` resolves immediately on the
    // dev server, so the dynamic hole streams in during the gesture and the
    // Suspense fallback is not reliably observable either way.

    await page.getByTestId("end-gesture").click();

    await expect(page.getByTestId("dynamic-content")).toHaveText("Dynamic content");

    expect(page.url()).toContain(`${ROUTE_ROOT}/target-page`);
  });
});
