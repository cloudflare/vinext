import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

// fake-client-barrel is in the fixture's optimizePackageImports. Its entry is a
// "use client" barrel, and its unused leaf sets a global when it is evaluated.
test.describe('optimizePackageImports with a "use client" barrel', () => {
  test("SSR only evaluates the modules that define the imported names", async ({ request }) => {
    const res = await request.get(`${BASE}/optimize-imports-client-barrel`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="client-barrel-counter"');
    expect(html).toContain('data-unused-loaded="false"');
  });

  test("the component hydrates", async ({ page }) => {
    await page.goto(`${BASE}/optimize-imports-client-barrel`);
    await waitForAppRouterHydration(page);
    const counter = page.getByTestId("client-barrel-counter");
    await counter.click();
    await expect(counter).toHaveText("Count: 1");
  });
});
