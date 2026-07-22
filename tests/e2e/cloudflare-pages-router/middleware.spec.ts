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
    // / and /nav-test are not in the matcher config — header must be absent.
    // /nav-test is subsequently rewritten by next.config.js, after middleware.
    const res = await request.get(`${BASE}/`);
    expect(res.status()).toBe(200);
    expect(res.headers()["x-mw-ran"]).toBeUndefined();

    const res2 = await request.get(`${BASE}/nav-test`);
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

  // Ported from Next.js: test/e2e/middleware-general/test/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-general/test/index.test.ts
  test("middleware can handle a missing build asset", async ({ request }) => {
    const rewritten = await request.get(`${BASE}/_next/static/middleware-rewrite.js`);
    expect(rewritten.status()).toBe(200);
    expect(await rewritten.text()).toBe("rewritten missing asset");

    const unhandled = await request.get(`${BASE}/_next/static/missing.js`);
    expect(unhandled.status()).toBe(404);
    expect(unhandled.headers()["content-type"]).toBe("text/plain; charset=utf-8");
    expect(await unhandled.text()).toBe("Not Found");
  });

  test("does not reinterpret encoded URL controls as data paths", async ({ page, request }) => {
    await page.goto(`${BASE}/ssr`);
    const buildId = await page.evaluate(() => (window as any).__NEXT_DATA__.buildId as string);

    for (const pathname of [
      `/%09_next/data/${buildId}/ssr.json`,
      `/_ne%0Axt/data/${buildId}/ssr.json`,
      `/_next/%0Ddata/${buildId}/ssr.json`,
    ]) {
      const response = await request.get(`${BASE}${pathname}`);
      expect(response.status()).toBe(404);
      expect(await response.text()).not.toContain("Server-Side Rendered on Workers");
    }
  });

  test("preserves encoded URL controls in data route parameters", async ({ page, request }) => {
    await page.goto(`${BASE}/ssr`);
    const buildId = await page.evaluate(() => (window as any).__NEXT_DATA__.buildId as string);

    const response = await request.get(`${BASE}/_next/data/${buildId}/posts/foo%09.json`);
    expect(response.status()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pageProps: { id: "foo\t" },
    });
  });
});
