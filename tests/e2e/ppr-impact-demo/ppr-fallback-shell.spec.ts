import { expect, test } from "@playwright/test";
// Ported from Next.js:
// test/e2e/app-dir/ppr-root-param-fallback/ppr-root-param-fallback.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/ppr-root-param-fallback/ppr-root-param-fallback.test.ts

test("renders an unknown root-param route safely without serving a partial artifact", async ({
  page,
}) => {
  await page.goto("/en/blog/new-post");

  await expect(page.locator("#static-header")).toContainText("Vinext PPR impact demo");
  await expect(page.locator("#locale-header")).toContainText("Home (en)");
  await expect(page.locator("#blog-content")).toContainText("Blog Post: new-post", {
    timeout: 15_000,
  });
  await expect(page.locator("#comments")).toContainText("Comments for anonymous");
  await expect(page.getByText("This page couldn’t load")).toHaveCount(0);
  await expect(page.getByText("This page couldn't load")).toHaveCount(0);
});
