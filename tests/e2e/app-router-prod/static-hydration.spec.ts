import { expect, test, type Page } from "@playwright/test";
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
  const errors = collectPageErrors(page);

  await page.goto("/client-page-search-params?q=hello");
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("client-page-search-params-q")).toHaveText("hello");

  await page.getByTestId("client-page-search-params-link").click();
  await expect(page).toHaveURL(/\?q=world$/);
  await expect(page.getByTestId("client-page-search-params-q")).toHaveText("world");
  expect(errors).toEqual([]);
});

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("a client page reads the rewritten query in SSR, hydration and navigation", async ({
  page,
}) => {
  // /client-page-search-params/rewritten/:q rewrites to ?q=:q. Next.js hands a
  // client page the rewritten query from its segment payload.
  const errors = collectPageErrors(page);

  await page.goto("/client-page-search-params/rewritten/bar");
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("client-page-search-params-q")).toHaveText("bar");

  await page.goto("/client-page-search-params?q=hello");
  await waitForAppRouterHydration(page);
  await page.getByTestId("client-page-search-params-rewrite-link").click();
  await expect(page).toHaveURL(/\/client-page-search-params\/rewritten\/bar$/);
  await expect(page.getByTestId("client-page-search-params-q")).toHaveText("bar");
  expect(errors).toEqual([]);
});

test("a client page behind a delayed boundary hydrates with the rewritten query", async ({
  page,
}) => {
  // The page reads its searchParams only after the document head is out, so
  // the head can't carry the rewritten query /delayed-rewritten/:q gives it.
  const errors = collectPageErrors(page);

  await page.goto("/client-page-search-params/delayed-rewritten/bar");
  await waitForAppRouterHydration(page);
  const query = page.getByTestId("delayed-client-page-q");
  await expect(query).toHaveAttribute("data-hydrated", "true");
  await expect(query).toHaveText("bar");
  expect(errors).toEqual([]);
});

test("a force-static client page keeps an empty query during navigation", async ({ page }) => {
  const errors = collectPageErrors(page);

  await page.goto("/client-page-search-params/force-static?q=hidden");
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("force-static-client-page-q")).toHaveText("(none)");

  await page.getByTestId("force-static-client-page-link").click();
  await expect(page).toHaveURL(/\?q=world$/);
  await expect(page.getByTestId("force-static-client-page-q")).toHaveText("(none)");
  expect(errors).toEqual([]);
});
