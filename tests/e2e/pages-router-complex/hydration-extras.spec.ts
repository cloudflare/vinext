import { test, expect } from "@playwright/test";

/**
 * Client/server render-boundary behaviours: ssr:false dynamic imports,
 * server-HTML-only subtrees, lifted chrome data, and client interactivity on
 * the diagnostics page.
 */
test.describe("hydration boundaries", () => {
  test("the helper dock is client-only (absent from server HTML)", async ({ page, request }) => {
    const html = await (await request.get("/journal")).text();
    expect(html).not.toContain('data-testid="helper-dock"');

    await page.goto("/journal");
    await expect(page.locator('[data-testid="helper-dock"]')).toBeVisible();
  });

  test("server-HTML-only content is dropped after hydration", async ({ page, request }) => {
    const html = await (await request.get("/diagnostics")).text();
    expect(html).toContain('data-testid="crawler-note"');

    await page.goto("/diagnostics");
    // Wait until hydration has demonstrably happened (helper dock mounts).
    await expect(page.locator('[data-testid="helper-dock"]')).toBeVisible();
    await expect(page.locator('[data-testid="crawler-note"]')).toHaveCount(0);
  });

  test("lifted broadcast data renders in the shared frame", async ({ page }) => {
    await page.goto("/diagnostics");
    await expect(page.locator('[data-testid="frame-ticker"]')).toContainText("TICKER broadcast");
    await expect(page.locator('[data-testid="frame-marquee"]')).toContainText("MARQUEE broadcast");

    // Other pages lift no broadcasts, so the frame omits them.
    await page.goto("/journal");
    await expect(page.locator('[data-testid="frame-ticker"]')).toHaveCount(0);
  });

  test("diagnostics memo stamp is stable across reloads within its TTL", async ({ request }) => {
    const stamp = async () => {
      const html = await (await request.get("/diagnostics")).text();
      return html.match(/data-testid="memo-stamp">([^<]+)</)?.[1];
    };
    const first = await stamp();
    expect(first).toBeTruthy();
    expect(await stamp()).toBe(first);
  });

  test.fixme("flyouts open and close client-side", async ({ page }) => {
    await page.goto("/diagnostics");
    await expect(page.locator('[data-testid="primary-flyout"]')).toHaveCount(0);
    await page.getByText("Primary flyout", { exact: true }).click();
    await expect(page.locator('[data-testid="primary-flyout"]')).toBeVisible();
    await page.locator('[data-testid="primary-flyout"] button').click();
    await expect(page.locator('[data-testid="primary-flyout"]')).toHaveCount(0);
  });

  test("the launch-timer trial arm renders its knob value", async ({ page }) => {
    await page.goto("/diagnostics");
    await expect(page.locator('[data-testid="launch-timer"]')).toHaveAttribute(
      "data-deadline",
      "2027-01-01T00:00:00Z",
    );
  });
});
