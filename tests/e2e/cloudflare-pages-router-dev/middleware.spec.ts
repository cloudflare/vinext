/**
 * Regression tests for middleware.ts on Pages Router when @cloudflare/vite-plugin
 * is present, exercised via `vite dev` (configureServer path).
 *
 * ## The crash bug (outsideEmitter)
 *
 * When @cloudflare/vite-plugin is loaded, the Pages Router connect handler
 * called runMiddleware() → server.ssrLoadModule(), which crashed with:
 *
 *   TypeError: Cannot read properties of undefined (reading 'outsideEmitter')
 *
 * The fix: use createDirectRunner() which calls environment.fetchModule()
 * directly and never touches the hot channel.
 *
 * ## How we assert middleware ran
 *
 * middleware.ts sets x-mw-ran: true on matched routes (/api/:path* and /ssr).
 * If the header is absent on a matched route, middleware either crashed or was
 * skipped entirely. If it's present on an unmatched route, the matcher config
 * is being ignored.
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4179";

test.describe("middleware.ts with @cloudflare/vite-plugin (vite dev)", () => {
  test("dev server handles requests without crashing when middleware.ts is present", async ({
    request,
  }) => {
    // If the outsideEmitter crash is present, the process exits on the first
    // matched request and this returns a connection error rather than a response.
    const res = await request.get(`${BASE}/api/hello`);
    expect(res.status()).toBe(200);
  });

  test("subsequent requests are served normally after middleware runs", async ({ request }) => {
    // Ensures the crash doesn't manifest on the second request either (e.g. if
    // runner state is corrupted after the first call).
    const res1 = await request.get(`${BASE}/api/hello`);
    expect(res1.status()).toBe(200);

    const res2 = await request.get(`${BASE}/api/hello`);
    expect(res2.status()).toBe(200);
  });

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
    // Ensures middleware calling NextResponse.next() correctly continues to
    // the route handler and doesn't swallow or corrupt the response.
    const res = await request.get(`${BASE}/api/hello`);
    expect(res.status()).toBe(200);
    const data = (await res.json()) as { message: string; runtime: string };
    expect(data.message).toBe("Hello from Pages Router API on Workers!");
    // GSSP and API routes run inside miniflare — navigator.userAgent is
    // "Cloudflare-Workers" only if the request reached the Worker.
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
