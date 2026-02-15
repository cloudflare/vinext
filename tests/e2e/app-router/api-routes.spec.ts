import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("App Router API Route Handlers", () => {
  test.describe("GET /api/hello", () => {
    test("returns JSON with message", async ({ request }) => {
      const response = await request.get(`${BASE}/api/hello`);
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("application/json");
      const body = await response.json();
      expect(body).toEqual({ message: "Hello from App Router API" });
    });
  });

  test.describe("POST /api/hello", () => {
    test("echoes the request body", async ({ request }) => {
      const response = await request.post(`${BASE}/api/hello`, {
        data: { name: "vinext", version: 1 },
      });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ echo: { name: "vinext", version: 1 } });
    });

    test("echoes complex nested data", async ({ request }) => {
      const payload = { users: [{ id: 1, name: "Alice" }], meta: { page: 1 } };
      const response = await request.post(`${BASE}/api/hello`, {
        data: payload,
      });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ echo: payload });
    });
  });

  test.describe("GET /api/get-only", () => {
    test("returns JSON for GET request", async ({ request }) => {
      const response = await request.get(`${BASE}/api/get-only`);
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ method: "GET" });
    });

    test("HEAD request returns 200 with no body", async ({ request }) => {
      const response = await request.head(`${BASE}/api/get-only`);
      expect(response.status()).toBe(200);
      const text = await response.text();
      expect(text).toBe("");
    });
  });

  test.describe("Dynamic route /api/items/[id]", () => {
    test("GET returns the dynamic id param", async ({ request }) => {
      const response = await request.get(`${BASE}/api/items/42`);
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ id: "42" });
    });

    test("GET with string id works", async ({ request }) => {
      const response = await request.get(`${BASE}/api/items/my-item`);
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ id: "my-item" });
    });

    test("PUT merges body with id param", async ({ request }) => {
      const response = await request.put(`${BASE}/api/items/42`, {
        data: { name: "Updated Item", price: 29.99 },
      });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ id: "42", name: "Updated Item", price: 29.99 });
    });
  });

  test.describe("Error handling routes", () => {
    test("GET /api/error-route returns 500", async ({ request }) => {
      const response = await request.get(`${BASE}/api/error-route`);
      expect(response.status()).toBe(500);
    });

    test("GET /api/not-found-route returns 404", async ({ request }) => {
      const response = await request.get(`${BASE}/api/not-found-route`);
      expect(response.status()).toBe(404);
    });

    test("GET /api/redirect-route redirects to /about", async ({ request }) => {
      const response = await request.get(`${BASE}/api/redirect-route`, {
        maxRedirects: 0,
      });
      // Should be a redirect status (307 for temporary redirect)
      expect([301, 302, 303, 307, 308]).toContain(response.status());
      expect(response.headers()["location"]).toContain("/about");
    });
  });

  test.describe("Cookie routes /api/set-cookie", () => {
    test("GET sets cookies in response", async ({ request }) => {
      const response = await request.get(`${BASE}/api/set-cookie`);
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true, message: "Cookies set" });

      // Verify set-cookie headers are present
      const setCookie = response.headers()["set-cookie"];
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain("session=abc123");
    });

    test("POST deletes cookie", async ({ request }) => {
      const response = await request.post(`${BASE}/api/set-cookie`);
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true, message: "Cookie deleted" });
    });
  });

  test.describe("Method not allowed", () => {
    test("DELETE on GET-only route returns 405", async ({ request }) => {
      const response = await request.delete(`${BASE}/api/get-only`);
      expect(response.status()).toBe(405);
    });

    test("PATCH on GET-only route returns 405", async ({ request }) => {
      const response = await request.patch(`${BASE}/api/get-only`, {
        data: {},
      });
      expect(response.status()).toBe(405);
    });
  });
});
