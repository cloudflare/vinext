import { test, expect } from "@playwright/test";
import { waitForHydration } from "../helpers";

/**
 * Config destination params substituted into a query must stay one query
 * value. Expected values match Next.js 16.2.7 for the same rules, except the
 * literal `&` redirect, which Next.js inserts verbatim and vinext escapes.
 */
const BASE = "http://localhost:4175";

test.describe("Config destination query params (Pages Router production)", () => {
  test("redirect keeps an encoded source capture as one Location query value", async ({
    request,
  }) => {
    for (const [pathname, location] of [
      [
        "/query-param-redirect/foo%26next%3Dhttps%3A%2F%2Fevil.example",
        "/about?next=/foo%26next%3Dhttps%3A%2F%2Fevil.example&safe=1",
      ],
      [
        "/query-param-redirect/foo&next=evil.example",
        "/about?next=/foo%26next%3Devil.example&safe=1",
      ],
      ["/query-param-redirect/caf%C3%A9", "/about?next=/caf%C3%A9&safe=1"],
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
});
