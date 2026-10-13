import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Adapted from Next.js: test/e2e/app-dir/app-root-params-getters/simple.test.ts
// ("should render the not found page without errors")
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-root-params-getters/simple.test.ts
// Next.js's fixture has only dynamic root layouts and the built-in not-found
// page; this fixture adds app/not-found.tsx beside app/[locale]/layout.tsx.
//
// A route miss has no locale to give the [locale] root layout, so Next.js
// renders app/not-found.tsx in its built-in <html><body> layout (#3680).
for (const pathname of ["/", "/no/such/route"]) {
  test(`renders the route miss ${pathname} with app/not-found.tsx and without the dynamic root layout`, async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    const response = await page.goto(pathname);

    expect(response?.status()).toBe(404);
    const html = await response!.text();
    expect(html).toMatch(/^<!DOCTYPE html><html><head>/);
    expect(html.match(/<body/g)).toHaveLength(1);
    expect(html).not.toContain('id="static-header"');
    expect(html).not.toContain('id="locale-header"');

    await waitForAppRouterHydration(page);
    await expect(page.locator("body > main > h1#app-not-found")).toHaveText("Not found");
    expect(pageErrors).toEqual([]);
  });
}

test("runs a server action from app/not-found.tsx on a route miss", async ({ page }) => {
  await page.goto("/no/such/route");
  await waitForAppRouterHydration(page);

  await page.locator("#not-found-ping").click();

  await expect(page.locator("#not-found-ping-reply")).toHaveText("pong");
});

// Next.js reloads the document when navigation changes the root layout, as it
// does from the [locale] root layout to the route miss's built-in one.
test("navigates from a [locale] page to a route miss with a document load", async ({ page }) => {
  const documentPaths: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documentPaths.push(new URL(request.url()).pathname);
  });
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await page.goto("/en/blog/known");
  await waitForAppRouterHydration(page);
  await page.evaluate(() => {
    const router = window.next?.router;
    if (!router) throw new Error("window.next.router is not installed");
    void router.push("/no/such/route");
  });
  await page.waitForURL("**/no/such/route");

  await expect(page.locator("body > main > h1#app-not-found")).toHaveText("Not found");
  await expect(page.locator("#static-header")).toHaveCount(0);
  expect(documentPaths).toEqual(["/en/blog/known", "/no/such/route"]);
  expect(pageErrors).toEqual([]);
});
