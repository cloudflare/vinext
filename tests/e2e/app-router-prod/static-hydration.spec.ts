import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Ported from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-static/app-static.test.ts
test("statically prerendered useSearchParams reads the browser query after hydration", async ({
  page,
}) => {
  let rscRequests = 0;
  page.on("request", (request) => {
    if (request.headers().rsc === "1") rscRequests++;
  });
  await page.goto("/nextjs-compat/use-search-params-static-bailout?value=runtime");
  await waitForAppRouterHydration(page);
  await expect(page.locator("#search-params-value")).toHaveText("runtime");
  expect(rscRequests).toBe(0);
});

test("force-static hydration keeps search params empty", async ({ page }) => {
  await page.goto("/static-test?value=hidden");
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("force-static-search-params")).toHaveText("N/A");
});
