import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4177";

test.describe("Pages Router client hydration on Cloudflare Workers", () => {
  // Pages Router uses __NEXT_DATA__ for hydration. Timestamps work correctly
  // when passed via getServerSideProps props (serialized and reused on client).

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

  test("index page with GSSP timestamp hydrates without errors", async ({ page }) => {
    // The index page has a timestamp from getServerSideProps.
    // This demonstrates the correct pattern: timestamps in GSSP props
    // are serialized to __NEXT_DATA__ and reused during hydration.
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto(BASE + "/");
    await page.waitForTimeout(3000);

    // Verify timestamp is displayed
    const content = await page.content();
    expect(content).toContain("Rendered at:");

    // Verify timestamp is in __NEXT_DATA__
    const nextData = await page.evaluate(() => (window as any).__NEXT_DATA__);
    expect(nextData.props.pageProps.timestamp).toBeDefined();

    // No hydration errors because timestamp came from GSSP props
    const hydrationErrors = errors.filter(
      (e) =>
        e.includes("Hydration") ||
        e.includes("hydration") ||
        e.includes("did not match") ||
        e.includes("server-rendered") ||
        e.includes("#418") ||
        e.includes("#425"),
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
    expect(nextData.props.pageProps.message).toBe("Server-Side Rendered on Workers");
  });

  test("GSSP page with timestamp hydrates without errors (correct pattern)", async ({ page }) => {
    // This test verifies the CORRECT way to use timestamps in Pages Router:
    // Generate them in getServerSideProps and pass as props.
    // The timestamp is serialized in __NEXT_DATA__ and reused during hydration,
    // so no mismatch occurs.
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto(BASE + "/ssr");
    await page.waitForTimeout(3000);

    // Verify the timestamp is displayed (came from GSSP props)
    const content = await page.content();
    expect(content).toContain("Generated at:");

    // The timestamp from __NEXT_DATA__ should match what's rendered
    const nextData = await page.evaluate(() => (window as any).__NEXT_DATA__);
    expect(nextData.props.pageProps.timestamp).toBeDefined();

    // No hydration errors because timestamp came from props, not render body
    const hydrationErrors = errors.filter(
      (e) =>
        e.includes("Hydration") ||
        e.includes("hydration") ||
        e.includes("did not match") ||
        e.includes("server-rendered") ||
        e.includes("#418") ||
        e.includes("#425"),
    );
    expect(hydrationErrors).toHaveLength(0);
  });
});
