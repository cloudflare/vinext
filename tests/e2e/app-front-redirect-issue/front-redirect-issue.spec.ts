import { expect, test } from "@playwright/test";

// Ported from Next.js: test/e2e/app-dir/front-redirect-issue/front-redirect-issue.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/front-redirect-issue/front-redirect-issue.test.ts

const BASE = "http://localhost:4188";

test.describe("app dir - front redirect issue", () => {
  test("should redirect with a single bootstrap hydration", async ({ page }) => {
    const scriptRequests: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "script") {
        scriptRequests.push(request.url());
      }
    });

    await page.goto(`${BASE}/vercel-user`);

    await expect(page.locator("#home-page h1")).toHaveText("Hello!", { timeout: 10_000 });
    expect(page.url()).toBe(`${BASE}/vercel-user`);
    await expect(page.locator("#visible-url")).toHaveText("/vercel-user");

    const bootstrapScripts = page.locator('script[type="module"][src]');
    await expect(bootstrapScripts).toHaveCount(1);
    const bootstrapSrc = await bootstrapScripts.first().getAttribute("src");
    expect(bootstrapSrc).toBeTruthy();
    const bootstrapUrl = new URL(bootstrapSrc ?? "", BASE);
    const bootstrapRequests = scriptRequests.filter(
      (requestUrl) => new URL(requestUrl).pathname === bootstrapUrl.pathname,
    );
    expect(bootstrapRequests).toHaveLength(1);
    expect(new URL(bootstrapRequests[0] ?? BASE).searchParams.has("dpl")).toBe(false);

    const bootstrapState = await page.evaluate(() => window.__VINEXT_RSC_BOOTSTRAP_STATE__);
    expect(bootstrapState).toBe("hydrated");

    // The hydrated React root must be present.
    const hasRoot = await page.evaluate(() => !!window.__VINEXT_RSC_ROOT__);
    expect(hasRoot).toBe(true);

    // Next.js hydration marker must be set.
    const nextHydrated = await page.evaluate(() => window.__NEXT_HYDRATED);
    expect(nextHydrated).toBe(true);
  });
});
