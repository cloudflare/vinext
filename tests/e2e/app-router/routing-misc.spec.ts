/**
 * OpenNext Compat: Trailing slash, catch-all routes, host URL, search params.
 *
 * Ported from:
 *   https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/trailing.test.ts
 *   https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/dynamic.catch-all.hypen.test.ts
 *   https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/host.test.ts
 *   https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/query.test.ts
 * Tests: ON-13, ON-14 in TRACKING.md
 */
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("Trailing Slash (OpenNext compat)", () => {
  // Ref: opennextjs-cloudflare trailing.test.ts — "trailingSlash redirect"
  // Default trailingSlash is false — /about/ should redirect to /about
  test("trailing slash is stripped via redirect", async ({ page }) => {
    const response = await page.goto(`${BASE}/about/`);

    // Should have been redirected from /about/ to /about
    expect(response?.request().redirectedFrom()?.url()).toMatch(/\/about\/$/);
    expect(response?.request().url()).toMatch(/\/about$/);
  });

  // Ref: opennextjs-cloudflare trailing.test.ts — "trailingSlash redirect with search parameters"
  test("trailing slash redirect preserves search params", async ({ page }) => {
    const response = await page.goto(`${BASE}/about/?foo=bar`);

    expect(response?.request().redirectedFrom()?.url()).toMatch(
      /\/about\/\?foo=bar$/,
    );
    expect(response?.request().url()).toMatch(/\/about\?foo=bar$/);
  });

  // Ref: opennextjs-cloudflare trailing.test.ts — "trailingSlash redirect to external domain"
  // Next.js returns 404 for //example.com/ to prevent protocol-relative redirects.
  test("double-slash path returns 404, not external redirect", async ({
    page,
  }) => {
    const response = await page.goto(`${BASE}//example.com/`);
    expect(response?.status()).toBe(404);
  });
});

test.describe("Catch-all API Route with Hyphen (OpenNext compat)", () => {
  // Ref: opennextjs-cloudflare dynamic.catch-all.hyphen.test.ts
  // https://github.com/opennextjs/opennextjs-cloudflare/issues/942
  test("catch-all API route captures multiple segments including hyphens", async ({
    request,
  }) => {
    const res = await request.get(
      `${BASE}/api/catch-all/open-next/is/really/cool`,
    );
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/json");
    const json = await res.json();
    expect(json).toStrictEqual({
      slugs: ["open-next", "is", "really", "cool"],
    });
  });

  test("catch-all API route works with single segment", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/api/catch-all/single`);
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json).toStrictEqual({ slugs: ["single"] });
  });
});

test.describe("Host URL (OpenNext compat)", () => {
  // Ref: opennextjs-cloudflare host.test.ts — "Request.url is host"
  test("route handler request.url has correct host", async ({ request }) => {
    const res = await request.get(`${BASE}/api/host`);
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.url).toBe(`${BASE}/api/host`);
  });
});

test.describe("Search Params in RSC (OpenNext compat)", () => {
  // Ref: opennextjs-cloudflare query.test.ts — "SearchQuery"
  test("searchParams available via props in server component", async ({
    page,
  }) => {
    await page.goto(
      `${BASE}/search-query?searchParams=e2etest&multi=one&multi=two`,
    );

    const propsEl = page.getByTestId("props-params");
    await expect(propsEl).toContainText("Search Params via Props: e2etest");

    const multiEl = page.getByTestId("multi-count");
    await expect(multiEl).toContainText(
      "Multi-value Params (key: multi): 2",
    );
  });

  test("multi-value searchParams are returned as arrays", async ({ page }) => {
    await page.goto(`${BASE}/search-query?multi=one&multi=two`);

    const multiEl = page.getByTestId("multi-count");
    await expect(multiEl).toContainText(
      "Multi-value Params (key: multi): 2",
    );
  });

  // Ref: opennextjs-cloudflare query.test.ts — middleware forwards search params
  test(
    "middleware forwards search params as header",
    async ({ page }) => {
      await page.goto(`${BASE}/search-query?searchParams=mwtest`);

      const mwEl = page.getByTestId("mw-params");
      await expect(mwEl).toContainText(
        "Search Params via Middleware: mw/mwtest",
      );
    },
  );
});
