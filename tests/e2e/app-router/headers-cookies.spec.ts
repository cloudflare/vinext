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
