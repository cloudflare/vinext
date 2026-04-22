/**
 * Next.js Compat E2E: router push pending state
 *
 * Next.js references:
 * - https://github.com/vercel/next.js/blob/canary/test/e2e/use-link-status/index.test.ts
 * - https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts
 *
 * The contract we care about here is that a programmatic App Router navigation
 * started inside useTransition should flip isPending immediately and keep it
 * true until the navigation commits.
 */

import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test.describe("Next.js compat: router.push pending state (browser)", () => {
  test("same-route search param push keeps useTransition pending until commit", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/router-push-pending`);
    await waitForAppRouterHydration(page);

    await expect(page.locator("#pending-state")).toHaveText("idle");
    await expect(page.locator("#client-filter")).toHaveText("client filter: none");
    await expect(page.locator("#server-filter")).toHaveText("server filter: none");

    const clickPromise = page.click("#push-alpha", { noWaitAfter: true });

    await expect(page.locator("#pending-state")).toHaveText("pending", {
      timeout: 1_000,
    });
    await clickPromise;
    await expect(page.locator("#client-filter")).toHaveText("client filter: alpha", {
      timeout: 10_000,
    });
    await expect(page.locator("#server-filter")).toHaveText("server filter: alpha", {
      timeout: 10_000,
    });
    await expect(page.locator("#pending-state")).toHaveText("idle", {
      timeout: 10_000,
    });
  });
});
