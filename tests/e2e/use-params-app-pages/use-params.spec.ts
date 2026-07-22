// Ported from Next.js: test/e2e/app-dir/use-params/use-params.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-params/use-params.test.ts
import { expect, test } from "@playwright/test";

test.describe("use-params", () => {
  test("should work for single dynamic param", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/a`);
    await expect(page.locator("#param-id")).toHaveText("a");

    // Also verify that only the [id] layout (not [id]/[id2]) drives this page
    await expect(page.locator("#param-id2")).toHaveCount(0);
  });

  test("should work for nested dynamic params", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/a/b`);
    await expect(page.locator("#param-id")).toHaveText("a");
    await expect(page.locator("#param-id2")).toHaveText("b");
  });

  test("should work for catch all params", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/a/b/c/d/e/f/g`);
    await expect(page.locator("#params")).toHaveText('["a","b","c","d","e","f","g"]');
  });

  test("should work for single dynamic param client navigating", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/`);
    await page.locator("#to-a").click();
    await expect(page.locator("#param-id")).toHaveText("a");
  });

  test("should work for nested dynamic params client navigating", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/`);
    await page.locator("#to-a-b").click();
    await expect(page.locator("#param-id")).toHaveText("a");
    await expect(page.locator("#param-id2")).toHaveText("b");
  });

  test("should work on pages router", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/pages-dir/foobar`);
    await expect(page.locator("#params")).toBeVisible();
    await expect(page.locator("#params")).toHaveText('"foobar"');
  });

  test("Pages route wins for soft-navigation from an App Link", async ({ page, baseURL }) => {
    // Hybrid invariant: the App root catch-all app/[...path] matches
    // /pages-dir/foobar, but Pages dynamic route pages/pages-dir/[dynamic] has
    // higher priority (Pages providers sort ahead of App providers in
    // DefaultRouteMatcherManager). The client must not soft-navigate through
    // the App runtime when Pages owns the URL — the App RSC stream would
    // render the catch-all's path array. Falls back to a document navigation
    // so the Pages handler renders the page.
    await page.goto(`${baseURL}/`);
    await page.locator("#to-pages").click();
    await expect(page).toHaveURL(/\/pages-dir\/foobar$/);
    await expect(page.locator("#params")).toHaveText('"foobar"');
  });

  test("Pages route wins for useRouter().push from an App page", async ({ page, baseURL }) => {
    // Same hybrid invariant as the <Link> case, but driven through the
    // App Router runtime boundary (next/navigation's useRouter). The
    // ownership check now lives inside `navigateClientSide` so
    // `router.push`, `router.replace`, and form-driven navigations all
    // hard-navigate to the Pages document instead of sending an RSC
    // request that the App catch-all would otherwise answer.
    await page.goto(`${baseURL}/`);
    await page.locator("#router-push-pages").click();
    await expect(page).toHaveURL(/\/pages-dir\/foobar$/);
    await expect(page.locator("#params")).toHaveText('"foobar"');
  });

  test("earlier static App segment wins on document load", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/account/details`);
    await expect(page.locator("#route-owner")).toHaveText("app");
  });

  test("earlier static App segment wins for Link navigation", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/`);
    await page.locator("#to-app-priority").click();
    await expect(page).toHaveURL(/\/account\/details$/);
    await expect(page.locator("#route-owner")).toHaveText("app");
  });

  test("earlier static App segment wins for router.push", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/`);
    await page.locator("#router-push-app-priority").click();
    await expect(page).toHaveURL(/\/account\/details$/);
    await expect(page.locator("#route-owner")).toHaveText("app");
  });

  test("useRouter().prefetch does not issue an RSC request for a Pages-owned URL", async ({
    page,
    baseURL,
  }) => {
    // The hybrid check in `_appRouter.prefetch` short-circuits RSC URL
    // construction for Pages-owned targets. Sending an RSC request would
    // hit the App root catch-all's RSC handler and warm an unusable
    // cache entry, so the prefetch should be a no-op.
    await page.goto(`${baseURL}/`);

    const rscRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes(".rsc")) {
        rscRequests.push(req.url());
      }
    });

    await page.locator("#router-prefetch-pages").click();

    // Give the network layer a chance to flush anything the resolver
    // accidentally started. The assertion is a strict zero RSC requests
    // against /pages-dir/foobar — the only RSC traffic the page emits
    // here is the bootstrap hydration (not targeted at the prefetch
    // URL).
    await page.waitForTimeout(250);
    expect(
      rscRequests.filter((u) => u.includes("/pages-dir/foobar")),
      `unexpected RSC prefetch: ${rscRequests.join("\n")}`,
    ).toEqual([]);
  });

  test("shouldn't rerender host component when prefetching", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/rerenders/foobar`);
    const initialRandom = await page.locator("#random").textContent();
    await page.locator("a").hover();
    await expect(page.locator("#random")).toHaveText(initialRandom ?? "");
  });
});
