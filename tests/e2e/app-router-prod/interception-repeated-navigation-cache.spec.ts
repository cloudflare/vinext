// Ported from Next.js: test/e2e/app-dir/interception-dynamic-segment/interception-dynamic-segment.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/interception-dynamic-segment/interception-dynamic-segment.test.ts
// ("should handle repeated interceptions without 404")

import { expect, test } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

const ROOT = "/interception-dyn-seg";
const TARGET = `${ROOT}/test-nested`;

// A slot intercept's payload leaves the source page beneath the modal for the
// client to keep. Opening the same modal again from the same page reuses that
// payload instead of requesting the intercepted route again, and going back
// reuses the page the client kept.
test("reuses a slot intercept's payload when the modal opens again", async ({ page }) => {
  const prefetch = page.waitForRequest((request) => isAppRouterRscRequestForPath(request, TARGET));
  await page.goto(ROOT);
  await waitForAppRouterHydration(page);
  await (await prefetch).response();

  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.searchParams.has("_rsc")) requests.push(url.pathname);
  });

  for (let i = 0; i < 3; i++) {
    const before = requests.length;
    await page.click("#link-test-nested");
    await expect(page.locator("#modal")).toContainText("Intercepted test-nested sidebar");
    await expect(page.locator("#children")).toContainText("CHILDREN SLOT");
    if (i > 0) expect(requests.slice(before)).toEqual([]);

    const beforeBack = requests.length;
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${ROOT}$`));
    await expect(page.locator("#modal")).not.toContainText("Intercepted test-nested sidebar");
    expect(requests.slice(beforeBack)).toEqual([]);
  }
});
