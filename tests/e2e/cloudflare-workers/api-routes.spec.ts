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
});
