import { test, expect } from "@playwright/test";

/**
 * The app shell's getInitialProps fetches masthead/baseboard chrome for every
 * page, memoises the navigation payload per zone+lang, and skips chrome
 * entirely for embedded-shell requests.
 */
test.describe("app-shell getInitialProps", () => {
  test("renders masthead and baseboard chrome on every page", async ({ page }) => {
    for (const path of ["/", "/journal", "/gallery/skies"]) {
      await page.goto(path);
      await expect(page.locator('[data-testid="frame-masthead"]')).toBeVisible();
      await expect(page.locator('[data-testid="frame-baseboard"]')).toBeVisible();
    }
  });

  test("navigation payload is memoised across requests (same minted-at)", async ({ request }) => {
    const mintedAt = async () => {
      const html = await (await request.get("/journal")).text();
      const match = html.match(/data-nav-minted-at="(\d+)"/);
      expect(match).not.toBeNull();
      return match![1];
    };

    const first = await mintedAt();
    const second = await mintedAt();
    expect(second).toBe(first);
  });

  test("embedded-shell cookie suppresses all chrome", async ({ browser }) => {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "atlas-shell",
        value: "1",
        url: (test.info().project.use.baseURL as string) ?? "http://localhost:4199",
      },
    ]);
    const page = await context.newPage();
    await page.goto("/journal");
    await expect(page.locator('[data-testid="frame-masthead"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="frame-baseboard"]')).toHaveCount(0);
    // The page content itself still renders.
    await expect(page.locator('[data-testid="journal-front"]')).toBeVisible();
    await context.close();
  });

  test("emits the shell-info beacon after hydration", async ({ page }) => {
    await page.goto("/journal");
    await page.waitForFunction(
      () =>
        (window as unknown as { __ATLAS_BEACONS__?: { name: string }[] }).__ATLAS_BEACONS__?.some(
          (b) => b.name === "shell-info",
        ) ?? false,
    );
    const beacon = await page.evaluate(
      () =>
        (
          window as unknown as {
            __ATLAS_BEACONS__: { name: string; attributes: Record<string, unknown> }[];
          }
        ).__ATLAS_BEACONS__.find((b) => b.name === "shell-info")?.attributes,
    );
    expect(beacon?.viewKind).toBe("story");
    expect(beacon?.isEmbedded).toBe(false);
  });

  test("link navigation to a data-fetching page forces a full document load", async ({ page }) => {
    await page.goto("/");
    // Plant a marker that survives client-side transitions but not full loads.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>)["__nav_marker__"] = true;
    });
    await page.click('[data-testid="front-to-diagnostics"]');
    await page.waitForURL("**/diagnostics");
    await expect(page.locator('[data-testid="memo-stamp"]')).toBeVisible();
    const marker = await page.evaluate(
      () => (window as unknown as Record<string, unknown>)["__nav_marker__"],
    );
    // The middleware answers /_next/data with a hardNavTo payload, so the
    // client must fall back to a full document navigation.
    expect(marker).toBeUndefined();
  });
});
