/**
 * Ported from Next.js: test/e2e/app-dir/app/useReportWebVitals.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/useReportWebVitals.test.ts
 */

import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";
const expectedMetricNames = ["CLS", "FCP", "FID", "INP", "LCP", "TTFB"];
const expectedMetricNamesKey = expectedMetricNames.join(",");

test.describe("Next.js compat: useReportWebVitals", () => {
  test("reports browser web vitals from next/web-vitals", async ({ page }) => {
    const reportedMetricNames: string[] = [];

    await page.route("https://example.vercel.sh/vitals", async (route) => {
      const body = route.request().postData();
      if (body) {
        const name = new URLSearchParams(body).get("name");
        if (name) {
          reportedMetricNames.push(name);
        }
      }
      await route.fulfill({ status: 204, body: "" });
    });

    await page.goto(`${BASE}/nextjs-compat/report-web-vitals`);
    await expect(page.locator("h1")).toHaveText("Report Web Vitals");
    await waitForAppRouterHydration(page);
    await expect.poll(() => reportedMetricNames.length, { timeout: 10_000 }).toBeGreaterThan(0);

    await page.reload();
    await waitForAppRouterHydration(page);
    await page.locator("#web-vitals-interaction").click();

    await expect
      .poll(() => reportedMetricNames.includes("FID") || reportedMetricNames.includes("INP"), {
        timeout: 10_000,
      })
      .toBe(true);
    await page.goto("about:blank");

    await expect
      .poll(() => [...new Set(reportedMetricNames)].sort().join(","), { timeout: 10_000 })
      .toBe(expectedMetricNamesKey);
  });
});
