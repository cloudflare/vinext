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

test("a client page reads its searchParams prop from the URL in the browser", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/client-page-search-params?q=hello");
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("client-page-search-params-q")).toHaveText("hello");

  await page.getByTestId("client-page-search-params-link").click();
  await expect(page).toHaveURL(/\?q=world$/);
  await expect(page.getByTestId("client-page-search-params-q")).toHaveText("world");
  expect(errors).toEqual([]);
});
