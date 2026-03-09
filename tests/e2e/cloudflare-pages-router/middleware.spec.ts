import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4177";

test.describe("middleware.ts on Pages Router Cloudflare Workers (prod build)", () => {
  test("middleware sets x-mw-ran header on /api routes", async ({ request }) => {
    const res = await request.get(`${BASE}/api/hello`);
    expect(res.status()).toBe(200);
    expect(res.headers()["x-mw-ran"]).toBe("true");
  });

  test("middleware sets x-mw-ran header on /ssr", async ({ request }) => {
    const res = await request.get(`${BASE}/ssr`);
    expect(res.status()).toBe(200);
    expect(res.headers()["x-mw-ran"]).toBe("true");
  });

  test("middleware does not run on routes outside the matcher", async ({ request }) => {
    // / and /about are not in the matcher config — header must be absent
    const res = await request.get(`${BASE}/`);
    expect(res.status()).toBe(200);
    expect(res.headers()["x-mw-ran"]).toBeUndefined();

    const res2 = await request.get(`${BASE}/about`);
    expect(res2.status()).toBe(200);
    expect(res2.headers()["x-mw-ran"]).toBeUndefined();
  });

  test("API route still returns correct JSON after middleware runs", async ({ request }) => {
    const res = await request.get(`${BASE}/api/hello`);
    expect(res.status()).toBe(200);
    const data = (await res.json()) as { message: string; runtime: string };
    expect(data.message).toBe("Hello from Pages Router API on Workers!");
    expect(data.runtime).toBe("Cloudflare-Workers");
  });

  test("SSR page still renders correctly after middleware runs", async ({ request }) => {
    const res = await request.get(`${BASE}/ssr`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain("Server-Side Rendered on Workers");
    expect(html).toContain("Cloudflare-Workers");
  });
});
