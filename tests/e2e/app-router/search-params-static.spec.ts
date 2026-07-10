import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Next.js 16.2.7 oracle coverage for development request semantics.
test("dynamic-error client query hooks stay request-scoped in development", async ({ page }) => {
  const slug = `dev-query-${Date.now()}`;
  const response = await page.goto(`/isr-client-search-dynamic-error/${slug}?q=DEVELOPMENT_QUERY`);
  expect(response?.status()).toBe(200);
  expect(await response?.text()).toContain("DEVELOPMENT_QUERY");
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("dynamic-error-query-echo")).toHaveText(
    "Dynamic-error query: DEVELOPMENT_QUERY",
  );
});

test("rewrite destination query stays server-only in development", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  const response = await page.goto("/nextjs-compat/rewrite-query-visible?shown=yes");
  expect(response?.status()).toBe(200);
  const html = await response?.text();
  expect(html).toContain("server:shown=<!-- -->yes<!-- -->&amp;hidden=<!-- -->secret");
  expect(html).toContain("client:<!-- -->shown=yes");
  expect(html).not.toContain("client:<!-- -->shown=yes&amp;hidden=secret");

  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("rewrite-page-query")).toHaveText("server:shown=yes&hidden=secret");
  await expect(page.getByTestId("rewrite-client-query")).toHaveText("client:shown=yes");
  expect(errors).toEqual([]);
});

test("server-inserted callbacks cannot read client query hooks in development", async ({
  request,
}) => {
  const slug = `dev-inserted-${Date.now()}`;
  const response = await request.get(
    `/isr-client-search-inserted-error/${slug}?q=DEVELOPMENT_QUERY`,
  );
  expect(response.status()).toBe(500);
  expect(await response.text()).not.toContain("DEVELOPMENT_QUERY");
});
