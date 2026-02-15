import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4177";

test.describe("Pages Router API routes on Cloudflare Workers", () => {
  test("API route returns JSON", async ({ request }) => {
    const res = await request.get(BASE + "/api/hello");
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.message).toBe("Hello from Pages Router API on Workers!");
  });

  test("API route reports Cloudflare Workers runtime", async ({ request }) => {
    const res = await request.get(BASE + "/api/hello");
    const data = await res.json();
    expect(data.runtime).toBe("Cloudflare-Workers");
  });

  test("returns 404 for non-existent API routes", async ({ request }) => {
    const res = await request.get(BASE + "/api/nonexistent");
    expect(res.status()).toBe(404);
  });
});
