import { expect, test } from "@playwright/test";

// Next.js prerenders a route whose last dynamic segment has no generator when
// its generators give every row every param. vinext stores such a route under
// `dynamicParams = false` once its request check shows that.
test("caches a route whose layout generator gives every param", async ({ request }) => {
  const first = await request.get("/every-param-cache/complete/en/a");
  expect(first.status()).toBe(200);
  const second = await request.get("/every-param-cache/complete/en/a");
  expect(second.headers()["x-vinext-cache"]).toBe("HIT");
  expect(await second.text()).toBe(await first.text());

  const miss = await request.get("/every-param-cache/complete/en/zzz");
  expect(miss.status()).toBe(404);
  expect(miss.headers()["cache-control"]).toContain("no-store");
});

// A row without a param leaves Next.js with no prerendered paths, so each
// request renders.
test("never caches a route whose generator gives a row without a param", async ({ request }) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request.get("/every-param-cache/mixed/en/a");
    expect(response.status()).toBe(200);
    expect(response.headers()["x-vinext-cache"]).toBeUndefined();
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
});
