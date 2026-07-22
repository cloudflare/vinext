import { test, expect } from "../fixtures";
import { waitForHydration } from "../helpers";

// Ported from Next.js: test/e2e/getserversideprops/test/index.test.ts
// "should not trigger an error when a data request is cancelled due to another
// navigation"
// https://github.com/vercel/next.js/blob/canary/test/e2e/getserversideprops/test/index.test.ts
//
// Regression test for vinext#1465: when a getServerSideProps/getStaticProps
// data response carries a redirect, the in-flight client navigation to the
// intermediate page must be cancelled and the navigation must land on the
// redirect destination — without a hard reload or console errors.

const BASE = "http://localhost:4173";

test.describe("Pages Router gSSP redirect cancellation (#1465)", () => {
  // The consoleErrors fixture auto-fails the test on any console error, which
  // is exactly what the upstream Next.js test asserts.
  test("Link click to a gSSP-redirect page lands on the destination, not the intermediate page", async ({
    page,
    consoleErrors,
  }) => {
    await page.goto(`${BASE}/gssp-redirect-test`);
    await expect(page.locator("h1")).toHaveText("gSSP Redirect Test");
    await waitForHydration(page);

    // Marker to detect a full page reload (a reload wipes it).
    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    await page.click('[data-testid="link-redirect"]');

    // Must land on the redirect destination ("a normal page"), never commit
    // the intermediate "Redirect Page".
    await expect(page.locator('[data-testid="normal-text"]')).toHaveText("a normal page");
    expect(page.url()).toBe(`${BASE}/gssp-redirect-target`);
    await expect(page.locator('[data-testid="redirect-page"]')).toHaveCount(0);

    // No full reload — the gSSP redirect resolves via a client navigation.
    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);

    void consoleErrors;
  });

  test("router.push to a gSSP-redirect page lands on the destination", async ({
    page,
    consoleErrors,
  }) => {
    await page.goto(`${BASE}/gssp-redirect-test`);
    await expect(page.locator("h1")).toHaveText("gSSP Redirect Test");
    await waitForHydration(page);

    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    await page.click('[data-testid="push-redirect"]');

    await expect(page.locator('[data-testid="normal-text"]')).toHaveText("a normal page");
    expect(page.url()).toBe(`${BASE}/gssp-redirect-target`);
    await expect(page.locator('[data-testid="redirect-page"]')).toHaveCount(0);

    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);

    void consoleErrors;
  });
});
