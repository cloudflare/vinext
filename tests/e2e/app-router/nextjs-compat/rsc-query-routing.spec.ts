import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = process.env.VINEXT_RSC_QUERY_TEST_BASE_URL ?? "http://localhost:4174";
const ROOT = "/nextjs-compat/rsc-query-routing";

// Ported from Next.js v16.2.6:
// test/e2e/app-dir/rsc-query-routing/rsc-query-routing.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/rsc-query-routing/rsc-query-routing.test.ts
test.describe("Next.js compat: RSC query routing", () => {
  test("preserves a valued RSC query through a config redirect", async ({ page }) => {
    await page.goto(`${BASE}${ROOT}/redirect`);
    await waitForAppRouterHydration(page);

    const rscRequestUrls: URL[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.searchParams.get("_rsc")) rscRequestUrls.push(url);
    });

    await page.getByRole("link", { name: "Redirect Link" }).click();
    await expect(page.getByRole("heading", { name: "Redirect Dest" })).toBeVisible();

    expect(rscRequestUrls[0]?.pathname).toBe(`${ROOT}/redirect/source`);
    expect(rscRequestUrls[1]?.pathname).toBe(`${ROOT}/redirect/dest`);
  });

  test("preserves a valued RSC query through a config rewrite", async ({ page }) => {
    await page.goto(`${BASE}${ROOT}/rewrite`);
    await waitForAppRouterHydration(page);

    const rscRequestUrls: URL[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.searchParams.get("_rsc")) rscRequestUrls.push(url);
    });

    await page.getByRole("link", { name: "Rewrite Link" }).click();
    await expect(page.getByRole("heading", { name: "Rewrite Dest" })).toBeVisible();

    expect(rscRequestUrls[0]?.pathname).toBe(`${ROOT}/rewrite/source`);
  });
});
