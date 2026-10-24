// Ported from Next.js:
// test/e2e/app-dir/segment-cache-dynamic-params/segment-cache-dynamic-params.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache-dynamic-params/segment-cache-dynamic-params.test.ts
//
// The closed-parameter prefetch hint tests are not ported: vinext's route tree
// does not carry Next.js' PrefetchHint.IsClosedParam bits.

import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const ROOT = "/nextjs-compat/segment-cache-dynamic-params";
const ROOT_NOT_FOUND = "404 - Page Not Found";
const NEVER_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate";

const treePrefetchHeaders = {
  RSC: "1",
  "Next-Router-Prefetch": "1",
  "Next-Router-Segment-Prefetch": "/_tree",
};

test.describe("Next.js compat: segment cache closed params (dynamicParams = false)", () => {
  test("rejects unlisted params at the routing level", async ({ request }) => {
    const allowedResponse = await request.get(`${ROOT}/products/allowed`);
    expect(allowedResponse.status()).toBe(200);
    const allowed = await allowedResponse.text();
    expect(allowed).toContain('id="product-page"');
    expect(allowed).toContain("product-record-allowed");

    // The product page always returns successful UI; it never calls notFound().
    // An unlisted slug must be rejected by routing, without rendering the
    // products layout, its nested not-found boundary, or the [slug] layout and
    // its generateMetadata with the rejected param.
    const rejectedResponse = await request.get(`${ROOT}/products/rejected`);
    expect(rejectedResponse.status()).toBe(404);
    // As for an unmatched route, the routing-level 404 is never cached.
    expect(rejectedResponse.headers()["cache-control"]).toBe(NEVER_CACHE_CONTROL);
    const rejected = await rejectedResponse.text();
    expect(rejected).toContain(ROOT_NOT_FOUND);
    for (const marker of [
      'id="products-layout"',
      'id="product-layout"',
      'id="product-page"',
      'id="nested-not-found"',
      "Product catalog",
      "product-record-",
    ]) {
      expect(rejected).not.toContain(marker);
    }

    const rejectedRsc = await request.get(`${ROOT}/products/rejected`, { headers: { RSC: "1" } });
    expect(rejectedRsc.status()).toBe(404);
    expect(rejectedRsc.headers()["cache-control"]).toBe(NEVER_CACHE_CONTROL);
    const rejectedPayload = await rejectedRsc.text();
    expect(rejectedPayload).toContain(ROOT_NOT_FOUND);
    for (const marker of [
      "products-layout",
      "product-layout",
      "nested-not-found",
      "product-record-",
    ]) {
      expect(rejectedPayload).not.toContain(marker);
    }

    // Client route discovery is rejected too, rather than returning a
    // successful generic /products/[slug] tree for an invalid parameter.
    const allowedTree = await request.get(`${ROOT}/products/allowed`, {
      headers: treePrefetchHeaders,
    });
    expect(allowedTree.status()).toBe(200);
    const rejectedTree = await request.get(`${ROOT}/products/rejected`, {
      headers: treePrefetchHeaders,
    });
    expect(rejectedTree.status()).toBe(404);
    expect(rejectedTree.headers()["cache-control"]).toBe(NEVER_CACHE_CONTROL);
    expect(await rejectedTree.text()).not.toContain("product-record-");
  });

  test("does not reuse a prefetched 404 for an allowed parameter value", async ({
    page,
  }, testInfo) => {
    // As in Next.js, Link prefetching only runs in production.
    test.skip(testInfo.project.name === "app-router", "prefetching is production-only");
    const rejectedStatuses: number[] = [];
    page.on("response", (response) => {
      if (
        response.request().headers().rsc === "1" &&
        new URL(response.url()).pathname === `${ROOT}/products/rejected`
      ) {
        rejectedStatuses.push(response.status());
      }
    });

    await page.goto(ROOT);
    await waitForAppRouterHydration(page);
    await page.locator(`input[data-link-accordion="${ROOT}/products/rejected"]`).click();
    await expect.poll(() => rejectedStatuses).toContain(404);

    await page.locator(`input[data-link-accordion="${ROOT}/products/allowed"]`).click();
    await page.locator(`a[href="${ROOT}/products/allowed"]`).click();

    await expect(page.locator("#product-page")).toHaveText("Allowed product page");
    await expect(page.getByText(ROOT_NOT_FOUND)).toHaveCount(0);
  });

  test("does not reuse an allowed route for a parameter value that must 404", async ({ page }) => {
    await page.goto(ROOT);
    await waitForAppRouterHydration(page);
    await page.locator(`input[data-link-accordion="${ROOT}/products/allowed"]`).click();
    await expect(page.locator(`a[href="${ROOT}/products/allowed"]`)).toBeVisible();

    // Learning /products/[slug] must not imply that every slug can match it.
    // This link opts out of prefetching, so the navigation asks the server.
    await page.locator("#navigate-rejected").click();
    await expect(page.getByText(ROOT_NOT_FOUND)).toBeVisible();
    await expect(page.locator("#products-layout")).toHaveCount(0);
    await expect(page.locator("#product-layout")).toHaveCount(0);
    await expect(page.locator("#nested-not-found")).toHaveCount(0);

    await page.reload();
    await expect(page.getByText(ROOT_NOT_FOUND)).toBeVisible();
    await expect(page.locator("#products-layout")).toHaveCount(0);
    await expect(page).toHaveTitle("App Basic");
  });
});
