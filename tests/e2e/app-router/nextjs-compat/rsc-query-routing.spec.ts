// Ported from Next.js: test/e2e/app-dir/rsc-query-routing/rsc-query-routing.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/rsc-query-routing/rsc-query-routing.test.ts
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test.describe("rsc-query-routing", () => {
  test("should contain rsc query in rsc request when redirect the page", async ({ page }) => {
    await page.goto(`${BASE}/redirect`);
    await waitForAppRouterHydration(page);

    const rscRequestUrls: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("?_rsc=")) {
        rscRequestUrls.push(req.url());
      }
    });

    // Click redirect link
    await page.locator("a").click();

    // Wait for the page load to be completed
    await expect(page.locator("h1")).toHaveText("Redirect Dest");

    // The redirect source and dest urls should both contain the rsc query
    expect(rscRequestUrls[0]).toContain("/redirect/source");
    expect(rscRequestUrls[1]).toContain("/redirect/dest");
  });

  test("should contain rsc query in rsc request when rewrite the page", async ({ page }) => {
    await page.goto(`${BASE}/rewrite`);
    await waitForAppRouterHydration(page);

    const rscRequestUrls: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("?_rsc=")) {
        rscRequestUrls.push(req.url());
      }
    });

    // Click rewrite link
    await page.locator("a").click();

    // Wait for the page load to be completed
    await expect(page.locator("h1")).toHaveText("Rewrite Dest");

    // The rewrite source url should contain the rsc query
    expect(rscRequestUrls[0]).toContain("/rewrite/source");
  });
});
