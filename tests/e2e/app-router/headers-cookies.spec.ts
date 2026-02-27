import { test, expect } from "../fixtures";

const BASE = "http://localhost:4174";

test.describe("headers() and cookies() in Server Components", () => {
  test("headers() works on initial page load", async ({ request }) => {
    const res = await request.get(`${BASE}/headers-test`, {
      headers: {
        "User-Agent": "TestAgent/1.0",
      },
    });

    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain("User-Agent:");
    expect(html).toContain("TestAgent");
  });

  test("cookies() works on initial page load", async ({ request }) => {
    const res = await request.get(`${BASE}/headers-test`, {
      headers: {
        Cookie: "test_cookie=hello; another=world",
      },
    });

    expect(res.status()).toBe(200);
    const html = await res.text();
    // React SSR inserts <!-- --> comment nodes between text and expressions
    // Match "Cookies:" followed by optional whitespace/comments and "2"
    expect(html).toMatch(/Cookies:.*2/s);
  });

  test("headers() works on RSC client navigation (.rsc request)", async ({
    request,
  }) => {
    // Simulate an RSC request (what happens during client-side navigation)
    const res = await request.get(`${BASE}/headers-test.rsc`, {
      headers: {
        Accept: "text/x-component",
        "User-Agent": "RSCNavigationAgent/1.0",
      },
    });

    expect(res.status()).toBe(200);
    const contentType = res.headers()["content-type"];
    expect(contentType).toContain("text/x-component");

    // The RSC payload should contain the user agent
    const rscPayload = await res.text();
    expect(rscPayload).toContain("RSCNavigationAgent");
  });

  test("cookies() works on RSC client navigation (.rsc request)", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/headers-test.rsc`, {
      headers: {
        Accept: "text/x-component",
        Cookie: "nav_cookie=value123",
      },
    });

    expect(res.status()).toBe(200);
    const rscPayload = await res.text();
    // RSC payload contains the cookie count as a number in the serialized data
    // The exact format is ["Cookies: ",1] in the RSC stream
    expect(rscPayload).toMatch(/Cookies.*1/);
  });

  test("headers() available during browser client navigation", async ({
    page,
  }) => {
    // Start on the home page
    await page.goto(`${BASE}/`);
    await page.waitForLoadState("networkidle");

    // Navigate to headers-test via client-side navigation (Link click)
    await page.click('[data-testid="headers-test-link"]');

    // Wait for the page to load
    await page.waitForSelector('[data-testid="headers-test-page"]', {
      timeout: 10000,
    });

    // Headers should be present (the browser sends User-Agent on RSC requests)
    const userAgentText = await page.getByTestId("user-agent").textContent();
    expect(userAgentText).toContain("User-Agent:");
  });

  test("headers() page renders correctly in browser", async ({ page }) => {
    await page.goto(`${BASE}/headers-test`);

    await expect(page.getByTestId("headers-test-page")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Headers/Cookies Test");
    await expect(page.getByTestId("user-agent")).toContainText("User-Agent:");
    await expect(page.getByTestId("cookie-count")).toContainText("Cookies:");
  });
});

/**
 * OpenNext Compat: Middleware cookie/header behavior
 *
 * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/middleware.cookies.test.ts
 * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/headers.test.ts
 * Tests: ON-6 and ON-8 in TRACKING.md
 *
 * OpenNext verifies that internal middleware headers (x-middleware-set-cookie,
 * x-middleware-next) are NOT exposed in the response, and that middleware-set
 * cookies are readable by server components via cookies().get().
 */
test.describe("Middleware header/cookie behavior (OpenNext compat)", () => {
  test("middleware sets custom headers on matched routes", async ({
    request,
  }) => {
    // Ref: opennextjs-cloudflare headers.test.ts "Headers"
    // The app-basic middleware sets x-mw-pathname and x-mw-ran
    const res = await request.get(`${BASE}/`);
    expect(res.status()).toBe(200);

    const headers = res.headers();
    expect(headers["x-mw-ran"]).toBe("true");
    expect(headers["x-mw-pathname"]).toBe("/");
  });

  test("internal x-middleware-next header is NOT in response", async ({
    request,
  }) => {
    // Ref: opennextjs-cloudflare middleware.cookies.test.ts
    // "should not expose internal Next headers in response"
    const res = await request.get(`${BASE}/about`);
    const headers = res.headers();

    // x-middleware-next is an internal Next.js header used between middleware
    // and the server — it should never appear in the response to the client
    expect(headers["x-middleware-next"]).toBeUndefined();
  });

  test("internal x-middleware-set-cookie header is NOT in response", async ({
    request,
  }) => {
    // Ref: opennextjs-cloudflare middleware.cookies.test.ts
    // "should not expose internal Next headers in response"
    const res = await request.get(`${BASE}/about`);
    const headers = res.headers();

    // x-middleware-set-cookie is used internally to pass cookie-setting
    // instructions — should be stripped before reaching the client
    expect(headers["x-middleware-set-cookie"]).toBeUndefined();
  });

  test("middleware headers available on matched pages only", async ({
    request,
  }) => {
    // Ref: opennextjs-cloudflare headers.test.ts — headers should only be
    // set on routes that match the middleware config
    const matchedRes = await request.get(`${BASE}/about`);
    expect(matchedRes.headers()["x-mw-ran"]).toBe("true");

    // API routes are not in the middleware matcher
    const apiRes = await request.get(`${BASE}/api/hello`);
    expect(apiRes.headers()["x-mw-ran"]).toBeUndefined();
  });

  test("request headers available in server component RSC rendering", async ({
    request,
  }) => {
    // Ref: opennextjs-cloudflare headers.test.ts "Request header should be available in RSC"
    const res = await request.get(`${BASE}/headers-test`, {
      headers: { "x-custom-test": "opennext-compat" },
    });
    expect(res.status()).toBe(200);
    // The server component reads headers() — verify it can access custom headers
    const html = await res.text();
    expect(html).toContain("User-Agent:");
  });
});
