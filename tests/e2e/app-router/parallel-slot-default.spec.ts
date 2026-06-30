// Ported from Next.js:
// test/e2e/app-dir/parallel-routes-catchall-default/parallel-routes-catchall-default.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/parallel-routes-catchall-default/parallel-routes-catchall-default.test.ts

import { expect, test } from "@playwright/test";

const BASE = "http://localhost:4174";

test("renders the implicit children default beside a nested parallel slot", async ({ page }) => {
  await page.goto(`${BASE}/parallel-slot-default/nested/foo/bar/baz`);

  await expect(page.getByTestId("parallel-slot-default-children")).toHaveText(
    "nested children default",
  );
  await expect(page.getByTestId("parallel-slot-default-slot")).toHaveText("slot dynamic page: baz");
});
