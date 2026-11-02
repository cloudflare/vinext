import { test, expect } from "@playwright/test";
import { waitForHydration } from "../helpers";

/**
 * Config destination params substituted into a destination query. Expected
 * values match Next.js 16.2.7 for the same rules.
 */
const BASE = "http://localhost:4175";

test.describe("Config destination query params (Pages Router production)", () => {
  test("redirect inserts source captures verbatim into the Location query", async ({ request }) => {
    for (const [pathname, location] of [
      [
        "/query-param-redirect/foo%26next%3Dhttps%3A%2F%2Fevil.example",
        "/about?next=/foo%26next%3Dhttps%3A%2F%2Fevil.example&safe=1",
      ],
      ["/query-param-redirect/foo&next=evil.example", "/about?next=/foo&next=evil.example&safe=1"],
      ["/query-param-redirect/caf%C3%A9", "/about?next=/caf%C3%A9&safe=1"],
      [
        "/query-param-redirect/foo%26next%3Devil?utm=a%20b&next=x",
        "/about?utm=a%20b&next=/foo%26next%3Devil&safe=1",
      ],
      [
        "/query-param-redirect/foo&utm=evil?utm=good&next=x",
        "/about?utm=good&next=/foo&utm=evil&safe=1",
      ],
    ]) {
      const res = await request.get(`${BASE}${pathname}`, { maxRedirects: 0 });
      expect(res.status()).toBe(307);
      expect(res.headers()["location"]).toBe(location);
    }
  });

  test("rewrite keeps an encoded or literal & inside one getServerSideProps query value", async ({
    page,
  }) => {
    for (const [pathname, q] of [
      ["/query-param-rewrite/foo%26admin=true", "foo%26admin=true"],
      ["/query-param-rewrite/foo&admin=true", "foo&admin=true"],
    ]) {
      await page.goto(`${BASE}${pathname}`);
      const query = JSON.parse((await page.getByTestId("query").textContent()) ?? "");
      expect(query).toEqual({ q, fixed: "1", term: q });
    }
  });

  test("client rewrite resolution keeps a literal & inside one router.query value", async ({
    page,
  }) => {
    await page.goto(`${BASE}/about`);
    await waitForHydration(page);
    await page.evaluate(() => {
      (window as any).__QUERY_PARAM_NAV_MARKER__ = true;
    });

    await page.evaluate(() =>
      (window as any).next.router.push("/api-query-param-rewrite/foo&admin=true"),
    );
    await expect(page.locator("h1")).toHaveText("Rewrite Navigation Destination");

    expect(await page.evaluate(() => (window as any).__QUERY_PARAM_NAV_MARKER__)).toBe(true);
    const query = await page.evaluate(() => (window as any).next.router.query);
    expect(query.q).toBe("foo&admin=true");
    expect(query.fixed).toBe("1");
    expect(query).not.toHaveProperty("admin");
  });

  // Browsers strip ASCII tab/newline from a Location before parsing it, so a
  // decoded query capture of "\t/evil.test" substituted into "/:to" must not
  // reach the browser as "/\t/evil.test" (resolved as //evil.test).
  test("query capture at the start of a destination stays same-origin", async ({ request }) => {
    for (const to of ["%09%2Fevil.test", "%09%5Cevil.test", "%2F%09%2Fevil.test", "%2Fevil.test"]) {
      const res = await request.get(`${BASE}/query-capture-redirect?to=${to}`, {
        maxRedirects: 0,
      });
      expect(res.status()).toBe(307);
      const location = res.headers()["location"];
      expect(location).toBe(`/evil.test?to=${to}`);
      const resolved = new URL(location, BASE);
      expect(resolved.origin).toBe(BASE);
      expect(resolved.pathname).toBe("/evil.test");
    }
  });
});

test.describe("Config redirect captured control characters (Pages Router production)", () => {
  // The server percent-encodes the captured LF in its Location; a soft
  // navigation must follow the redirect to the same path.
  test("client navigation and the server agree on the redirect path", async ({ page, request }) => {
    const res = await request.get(`${BASE}/control-capture-redirect?x=a%0Afoo`, {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(307);
    expect(new URL(res.headers()["location"], BASE).pathname).toBe("/target/a%0Afoo");

    await page.goto(`${BASE}/`);
    await waitForHydration(page);
    const documentRequest = page.waitForRequest(
      (req) => req.isNavigationRequest() && new URL(req.url()).pathname.startsWith("/target/"),
    );
    await page.evaluate(() => {
      void (
        window as unknown as { next: { router: { push(url: string): Promise<boolean> } } }
      ).next.router.push("/control-capture-redirect?x=a%0Afoo");
    });
    expect(new URL((await documentRequest).url()).pathname).toBe("/target/a%0Afoo");
  });
});

test.describe("Config redirect non-ASCII destinations (Pages Router production)", () => {
  // Next.js 16.2.7 sends the same Locations for the path, hash, host and the
  // parsed template. It answers 500 for a non-ASCII destination query.
  test("percent-encodes non-ASCII destination characters in the Location", async ({
    page,
    request,
  }) => {
    for (const [pathname, status, location] of [
      [
        "/non-ascii-redirect/%EC%84%9C%20a?x=%EC%B9%98",
        308,
        "/docs/%EC%B9%98%EA%B3%BC/%EC%84%9C%20a?x=%EC%B9%98#%EC%84%B9%EC%85%98",
      ],
      ["/non-ascii-query-redirect", 307, "/about?from=%EC%84%9C%EC%9A%B8"],
      ["/normalized-redirect/abc", 307, "/docs/abc"],
      ["/non-ascii-external-redirect", 307, "https://xn--3e0b707e.example/%EC%B9%98%EA%B3%BC"],
    ] as const) {
      const res = await request.get(`${BASE}${pathname}`, { maxRedirects: 0 });
      expect(res.status()).toBe(status);
      expect(res.headers()["location"]).toBe(location);
    }

    await page.goto(`${BASE}/non-ascii-redirect/%EC%84%9C`);
    await expect(page.getByTestId("docs-slug")).toHaveText("Path: 치과/서");
    expect(page.url()).toBe(`${BASE}/docs/%EC%B9%98%EA%B3%BC/%EC%84%9C#%EC%84%B9%EC%85%98`);
  });
});
