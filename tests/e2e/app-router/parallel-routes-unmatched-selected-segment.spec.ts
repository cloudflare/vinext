import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = `${process.env.VINEXT_E2E_BASE_URL ?? "http://localhost:4174"}/parallel-selected-unmatched`;

test("preserves an unmatched slot without default.tsx and its selected segment", async ({
  page,
}) => {
  await page.goto(`${BASE}/source`);
  await waitForAppRouterHydration(page);
  await expect(page.locator("#statusSegment")).toHaveText("status segment: source");

  await page.locator('a[href="/parallel-selected-unmatched/target/ready"]').click();
  await expect(page.locator("#statusSegment")).toHaveText("status segment: ready");
  await expect(page.locator("#statusSlot")).toContainText("intercepted status ready");

  await page.locator('a[href="/parallel-selected-unmatched/foo"]').click();
  await expect(page.locator("#statusSegment")).toHaveText("status segment: ready");
  await expect(page.locator("#statusSlot")).toContainText("intercepted status ready");
});
