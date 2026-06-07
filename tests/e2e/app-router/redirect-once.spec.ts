// Ported from Next.js: test/e2e/app-dir/navigation/navigation.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

for (const path of ["/redirect/servercomponent", "/redirect/redirect-with-loading"]) {
  test(`only triggers the redirect once (${path})`, async ({ page }) => {
    const documentRequestPathnames: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "document") {
        documentRequestPathnames.push(new URL(request.url()).pathname);
      }
    });

    await page.goto(`${BASE}${path}`);
    await expect(page.locator("#result-page")).toHaveText("Result Page");

    const initialTimestamp = await page.locator("#timestamp").textContent();
    expect(initialTimestamp).toBeTruthy();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.waitForTimeout(400);
      await expect(page.locator("#timestamp")).toHaveText(initialTimestamp ?? "");
    }
    expect(
      documentRequestPathnames.filter((pathname) => pathname === "/redirect/result"),
    ).toHaveLength(1);
  });
}
