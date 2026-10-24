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

test("force-static useSearchParams is empty in SSR and reads the browser query after hydration", async ({
  page,
  request,
}) => {
  // Next.js skips "should have empty search params on force-static" in
  // app-static.test.ts. Its browser derives useSearchParams from the URL
  // (canonicalUrl in app-router.tsx), so it reads the query once hydrated.
  // force-static embeds an empty query in the server-rendered HTML...
  const html = await (await request.get("/static-test?value=hidden")).text();
  expect(html).toMatch(/data-testid="force-static-search-params"[^>]*>N\/A</);

  // ...and React switches to the live browser URL snapshot once hydrated,
  // without a hydration mismatch.
  const errors = collectPageErrors(page);
  await page.goto("/static-test?value=hidden");
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("force-static-search-params")).toHaveText("hidden");
  expect(errors).toEqual([]);
});

test("useSearchParams keeps the hydrated object when the browser query matches", async ({
  page,
}) => {
  // A new object with the same query would re-run effects keyed on it.
  await page.goto("/static-test");
  await waitForAppRouterHydration(page);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))),
      ),
  );
  const searchParams = page.getByTestId("force-static-search-params");
  await expect(searchParams).toHaveText("N/A");
  await expect(searchParams).toHaveAttribute("data-search-params-objects", "1");
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

test("a client page hydrates with the rewritten query when it fetches its Flight payload", async ({
  page,
}) => {
  // Without the payload embedded in the document, hydration fetches it, and
  // the query comes from that response rather than the browser URL.
  const errors = collectPageErrors(page);
  await page.route("**/client-page-search-params/delayed-rewritten/bar", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    const html = (await response.text()).replace(
      /<script>[^<]*vinext\.navigationRuntime[^<]*\.bootstrap\.rsc[^<]*<\/script>/g,
      "",
    );
    return route.fulfill({ response, body: html });
  });

  await page.goto("/client-page-search-params/delayed-rewritten/bar");
  const query = page.getByTestId("delayed-client-page-q");
  await expect(query).toHaveAttribute("data-hydrated", "true");
  await expect(query).toHaveText("bar");
  // The response names the rewrite target, but usePathname() hydrates with
  // the public path SSR rendered.
  await expect(page.getByTestId("delayed-client-page-pathname")).toHaveText(
    "/client-page-search-params/delayed-rewritten/bar",
  );
  expect(errors).toEqual([]);
});

test("a client page reads the query a server action re-render was rewritten to", async ({
  page,
}) => {
  // The rewrite matches only the action POST, so the re-render has a query the
  // URL doesn't.
  const errors = collectPageErrors(page);

  await page.goto("/client-page-search-params/action");
  await waitForAppRouterHydration(page);
  const query = page.getByTestId("action-client-page-q");
  await expect(query).toHaveText("(none)");

  await page.getByTestId("action-client-page-submit").click();
  await expect(query).toHaveText("from-action");
  await expect(page).toHaveURL(/\/client-page-search-params\/action$/);
  expect(errors).toEqual([]);
});

test("a client page reading React's promise fields directly hydrates as SSR rendered it", async ({
  page,
}) => {
  const errors = collectPageErrors(page);

  await page.goto("/client-page-search-params/promise-fields?status=y&value=z");
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("client-page-promise-fields")).toHaveText(
    "status:undefined value:undefined",
  );
  expect(errors).toEqual([]);
});

test("a client page reading React's promise fields hydrates as SSR rendered it beside a page using its query", async ({
  page,
}) => {
  // The page's use() must not leave React's fields on the @fields page's
  // promise in SSR, as it doesn't in the browser.
  const errors = collectPageErrors(page);

  await page.goto("/client-page-search-params/promise-fields-sibling?q=one");
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("promise-fields-sibling-q")).toHaveText("one");
  await expect(page.getByTestId("promise-fields-sibling-fields")).toHaveText(
    "status:undefined value:undefined",
  );
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
