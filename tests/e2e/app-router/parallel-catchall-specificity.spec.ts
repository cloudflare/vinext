// Ported from Next.js:
// test/e2e/app-dir/parallel-routes-catchall-specificity/parallel-routes-catchall-specificity.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/parallel-routes-catchall-specificity/parallel-routes-catchall-specificity.test.ts

import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174/parallel-catchall-specificity";

test("restores an intercepted slot before matching its catch-all sibling", async ({ page }) => {
  await page.goto(BASE);
  await waitForAppRouterHydration(page);

  await page.locator('a[href$="/comments/product"]').click();
  await expect(page.getByRole("heading", { name: "Modal" })).toBeVisible();

  await page.locator('a[href$="/u/foobar/l"]').click();
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Modal" })).toBeVisible();

  await page.locator('a[href$="/trending"]').click();
  await expect(page.getByRole("heading", { name: "Trending" })).toBeVisible();
});
