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

/**
 * OpenNext Compat: Exhaustive HTTP method tests for route handlers.
 *
 * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/methods.test.ts
 * Tests: ON-3 in TRACKING.md
 *
 * OpenNext tests every HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS)
 * plus formData, cookies, redirects, dynamic segments, and query params. These
 * tests verify the same behavior in vinext's route handler implementation.
 */
test.describe("Route Handler HTTP Methods (OpenNext compat)", () => {
  // Ref: opennextjs-cloudflare methods.test.ts "all supported methods should work in route handlers"
  test("GET returns 200 with JSON", async ({ request }) => {
    const res = await request.get(`${BASE}/api/methods`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.message).toBe("vinext route handler");
  });

  test("POST with text body returns status-based response", async ({
    request,
  }) => {
    // Ref: opennextjs-cloudflare methods.test.ts "POST"
    const res = await request.post(`${BASE}/api/methods`, {
      headers: { "Content-Type": "text/plain" },
      data: "vinext is awesome!",
    });
    expect(res.status()).toBe(202);
    const data = await res.json();
    expect(data.message).toBe("ok");

    // Error case: forbidden content
    const errorRes = await request.post(`${BASE}/api/methods`, {
      headers: { "Content-Type": "text/plain" },
      data: "vinext is not awesome!",
    });
    expect(errorRes.status()).toBe(403);
    const errorData = await errorRes.json();
    expect(errorData.message).toBe("forbidden");
  });

  test("PUT returns 201 with JSON body merged", async ({ request }) => {
    // Ref: opennextjs-cloudflare methods.test.ts "PUT"
    const res = await request.put(`${BASE}/api/methods`, {
      data: { message: "vinext PUT" },
    });
    expect(res.status()).toBe(201);
    const data = await res.json();
    // Route handler spreads body into response: { message: "ok", ...body }
    // Since body has message: "vinext PUT", it overrides to "vinext PUT"
    expect(data.message).toBe("vinext PUT");
  });

  test("PATCH returns 202 with timestamp", async ({ request }) => {
    // Ref: opennextjs-cloudflare methods.test.ts "PATCH"
    const timestampBefore = new Date();
    const res = await request.patch(`${BASE}/api/methods`, {
      data: { message: "vinext PATCH" },
    });
    expect(res.status()).toBe(202);
    const data = await res.json();
    expect(data.message).toBe("ok");
    expect(data.modified).toBe(true);
    expect(Date.parse(data.timestamp)).toBeGreaterThan(timestampBefore.getTime());
  });

  test("DELETE returns 204 with no body", async ({ request }) => {
    // Ref: opennextjs-cloudflare methods.test.ts "DELETE"
    const res = await request.delete(`${BASE}/api/methods`);
    expect(res.status()).toBe(204);
  });

  test("HEAD returns 200 with custom headers and empty body", async ({
    request,
  }) => {
    // Ref: opennextjs-cloudflare methods.test.ts "HEAD"
    const res = await request.head(`${BASE}/api/methods`);
    expect(res.status()).toBe(200);
    const headers = res.headers();
    expect(headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(headers["special-header"]).toBe("vinext is great");
  });

  test("OPTIONS returns 204 with Allow header", async ({ request }) => {
    // Ref: opennextjs-cloudflare methods.test.ts "OPTIONS"
    const res = await request.fetch(`${BASE}/api/methods`, {
      method: "OPTIONS",
    });
    expect(res.status()).toBe(204);
    // Vinext's auto-OPTIONS sets Allow based on detected exports
    const headers = res.headers();
    const allow = headers["allow"];
    expect(allow).toBeDefined();
    // Should list at minimum the methods we export
    expect(allow).toContain("GET");
    expect(allow).toContain("POST");
    expect(allow).toContain("PUT");
    expect(allow).toContain("DELETE");
  });

  test("formData should work in POST route handler", async ({ request }) => {
    // Ref: opennextjs-cloudflare methods.test.ts "formData should work in POST route handler"
    const res = await request.post(`${BASE}/api/methods`, {
      form: {
        name: "vinext [] () %&#!%$#",
        email: "vinext@vinext.dev",
      },
    });
    expect(res.status()).toBe(202);
    const data = await res.json();
    expect(data.message).toBe("ok");
    expect(data.name).toBe("vinext [] () %&#!%$#");
    expect(data.email).toBe("vinext@vinext.dev");
  });

  test("query parameters should work in route handlers", async ({
    request,
  }) => {
    // Ref: opennextjs-cloudflare methods.test.ts "query parameters should work in route handlers"
    const res = await request.get(`${BASE}/api/methods/query?query=vinext+is+awesome`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.query).toBe("vinext is awesome");
  });
});

/**
 * OpenNext Compat: Route handler Cache-Control headers.
 *
 * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/methods.test.ts
 * Tests: ON-3 #13-14 in TRACKING.md
 *
 * In Next.js, a GET-only route handler with `export const revalidate = N`
 * receives Cache-Control: s-maxage=N, stale-while-revalidate.
 * vinext does not read `revalidate` from route handler modules.
 */
test.describe("Route Handler Cache Headers (OpenNext compat)", () => {
  // Ref: opennextjs-cloudflare methods.test.ts — static GET cache headers
  // vinext does not apply Cache-Control to route handler responses.
  // The dev server only reads `revalidate` from page modules, not route handlers.
  test.fixme(
    "static GET route handler has s-maxage Cache-Control",
    async ({ request }) => {
      const res = await request.get(`${BASE}/api/static-data`);
      expect(res.status()).toBe(200);
      const cacheControl = res.headers()["cache-control"];
      expect(cacheControl).toContain("s-maxage=1");
      expect(cacheControl).toContain("stale-while-revalidate");
    },
  );

  // Ref: opennextjs-cloudflare methods.test.ts — revalidation timing
  // Fixture uses revalidate=1 so the sleep can be short.
  test.fixme(
    "static GET route handler serves fresh data after revalidation period",
    async ({ request }) => {
      const res1 = await request.get(`${BASE}/api/static-data`);
      const data1 = await res1.json();

      // Wait just past the 1s revalidation window
      await new Promise((r) => setTimeout(r, 1100));

      const res2 = await request.get(`${BASE}/api/static-data`);
      const data2 = await res2.json();

      expect(data2.timestamp).not.toBe(data1.timestamp);
    },
  );
});
