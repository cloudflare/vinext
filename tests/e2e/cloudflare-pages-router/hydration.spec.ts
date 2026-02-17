import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4177";

test.describe("Pages Router client hydration on Cloudflare Workers", () => {
  // Note: Pages Router has a known hydration issue with timestamps on the index page.
  // This is separate from the App Router RSC hydration fix (issue #61).
  // We don't use the strict console error fixture here until that's fixed.

  test("client JS bundle is loaded", async ({ page }) => {
    const response = await page.goto(BASE + "/");
    const html = await response!.text();
    // The HTML should contain a script tag for the client entry
    expect(html).toMatch(/script\s+type="module"\s+src="\/assets\/[^"]+\.js"/);
  });

  test("counter becomes interactive after hydration", async ({ page }) => {
    await page.goto(BASE + "/");

    // SSR content should be visible immediately
    await expect(page.locator("#count")).toHaveText("0");

    // Wait for hydration — the client JS loads and React hydrates
    await page.waitForTimeout(3000);

    // Click the increment button
    await page.click("#increment");
    await expect(page.locator("#count")).toHaveText("1");

    // Click again
    await page.click("#increment");
    await expect(page.locator("#count")).toHaveText("2");
  });

  test("no hydration mismatch errors in console", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto(BASE + "/");
    await page.waitForTimeout(3000);

    // Filter for hydration-specific errors
    const hydrationErrors = errors.filter(
      (e) =>
        e.includes("Hydration") ||
        e.includes("hydration") ||
        e.includes("did not match") ||
        e.includes("server-rendered"),
    );
    expect(hydrationErrors).toHaveLength(0);
  });

  test("Head component updates document title on client", async ({ page }) => {
    await page.goto(BASE + "/");
    await page.waitForTimeout(2000);
    // The index page sets title via <Head>
    await expect(page).toHaveTitle("Cloudflare Pages Router");
  });

  test("GSSP page hydrates with server data", async ({ page }) => {
    await page.goto(BASE + "/ssr");
    await page.waitForTimeout(2000);

    // __NEXT_DATA__ should have the GSSP props
    const nextData = await page.evaluate(() => (window as any).__NEXT_DATA__);
    expect(nextData).toBeDefined();
    expect(nextData.props.pageProps.message).toBe(
      "Server-Side Rendered on Workers",
    );
  });
});
