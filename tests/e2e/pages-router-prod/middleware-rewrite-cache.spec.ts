import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4175";

test.describe("Pages middleware rewrite cache parity", () => {
  test("query-invariant ISR rewrite preserves shared caching", async ({ request }) => {
    const response = await request.get(`${BASE}/mw-rewrite-isr`);

    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("Hello from ISR");
    expect(response.headers()["cache-control"]).toContain("s-maxage=1");
  });

  test("query-invariant static GSP rewrite does not force no-cache", async ({ request }) => {
    const htmlResponse = await request.get(`${BASE}/mw-rewrite-static-gsp`);
    expect(htmlResponse.status()).toBe(200);
    expect(await htmlResponse.text()).toContain("Hello from static GSP");
    expect(htmlResponse.headers()["cache-control"]).toBe(
      "s-maxage=31536000, stale-while-revalidate",
    );

    const dataResponse = await request.get(
      `${BASE}/_next/data/test-build-id/mw-rewrite-static-gsp.json`,
    );
    expect(dataResponse.status()).toBe(200);
    expect(await dataResponse.json()).toMatchObject({
      pageProps: { message: "Hello from static GSP" },
    });
    expect(dataResponse.headers()["cache-control"]).toContain("s-maxage=");
  });

  test("query-varying static GSP rewrites stay private and preserve source router state", async ({
    page,
    request,
  }) => {
    const dataResponse = await request.get(
      `${BASE}/_next/data/test-build-id/mw-rewrite-static-gsp-query.json?variant=one`,
    );
    expect(dataResponse.status()).toBe(200);
    expect(dataResponse.headers()["cache-control"]).toBe("no-store, must-revalidate");
    expect(await dataResponse.json()).toMatchObject({
      pageProps: { message: "Hello from static GSP" },
    });

    await page.goto(`${BASE}/mw-rewrite-static-gsp-query?variant=one`);
    await expect(page.getByTestId("as-path")).toHaveText(
      "/mw-rewrite-static-gsp-query?variant=one",
    );
    expect(JSON.parse((await page.getByTestId("query").textContent()) ?? "null")).toEqual({
      variant: "one",
      from: "middleware",
    });
  });
});
