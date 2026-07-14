import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4176";

test.describe("Cloudflare Workers API Routes", () => {
  test("GET /api/hello returns JSON", async ({ request }) => {
    const response = await request.get(`${BASE}/api/hello`);

    expect(response.status()).toBe(200);
    const json = await response.json();
    expect(json.message).toBe("Hello from vinext on Cloudflare Workers!");
  });

  test("API route reports Cloudflare-Workers runtime", async ({ request }) => {
    const response = await request.get(`${BASE}/api/hello`);
    const json = await response.json();

    expect(json.runtime).toBe("Cloudflare-Workers");
  });

  test("API route returns proper content-type", async ({ request }) => {
    const response = await request.get(`${BASE}/api/hello`);
    const contentType = response.headers()["content-type"];

    expect(contentType).toContain("application/json");
  });

  // Ported from Next.js: test/e2e/edge-can-use-wasm-files/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/edge-can-use-wasm-files/index.test.ts
  test("API route can use a wasm module", async ({ request }) => {
    const response = await request.get(`${BASE}/api/wasm`);

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ result: 42 });
  });
});

test.describe("canonical repeated-slash redirects", () => {
  for (const [label, pathname, location] of [
    ["App route", "//", "/"],
    ["Pages route", "/pages//pages-index?from=pages", "/pages/pages-index?from=pages"],
    ["route handler", "/api//hello?from=api", "/api/hello?from=api"],
  ] as const) {
    test(`redirects hybrid ${label} before Worker router selection`, async ({ request }) => {
      const response = await request.get(`${BASE}${pathname}`, { maxRedirects: 0 });
      expect(response.status()).toBe(308);
      expect(response.headers().location).toBe(location);
      expect(await response.text()).toBe(location);
    });
  }

  test("keeps encoded delimiter requests blocked", async ({ request }) => {
    const response = await request.get(`${BASE}/%5Cevil.com`, { maxRedirects: 0 });
    expect(response.status()).toBe(404);
  });

  test("redirects existing static assets before Cloudflare asset serving", async ({ request }) => {
    const page = await request.get(BASE);
    const scriptPath = (await page.text()).match(/src="([^"]*\/_next\/static\/[^"]+\.js)"/)?.[1];
    expect(scriptPath).toBeTruthy();

    const assetResponse = await request.get(`${BASE}${scriptPath}`);
    expect(assetResponse.status()).toBe(200);

    const repeatedPath = scriptPath!.replace("/_next/static/", "/_next/static//");
    const response = await request.get(`${BASE}${repeatedPath}`, { maxRedirects: 0 });

    expect(response.status()).toBe(308);
    expect(response.headers().location).toBe(scriptPath);
    expect(await response.text()).toBe(scriptPath);

    const leadingRepeatedResponse = await request.get(`${BASE}/${scriptPath}`, {
      maxRedirects: 0,
    });
    expect(leadingRepeatedResponse.status()).toBe(308);
    expect(leadingRepeatedResponse.headers().location).toBe(scriptPath);
  });
});
