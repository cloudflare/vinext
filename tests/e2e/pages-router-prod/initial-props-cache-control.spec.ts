import { test, expect } from "@playwright/test";

// Next.js pages-handler.ts gives every render that is not a getStaticProps
// result (and a getStaticPaths fallback shell) `revalidate: 0` unless the page
// set its own Cache-Control, so a shared cache never stores it.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/pages/pages-handler.ts

const BASE = "http://localhost:4175";
const NEVER_CACHE = "private, no-cache, no-store, max-age=0, must-revalidate";

test.describe("Pages Router Cache-Control for request-time renders", () => {
  test("a page getInitialProps document and data response are never cached", async ({
    request,
  }) => {
    const document = await request.get(`${BASE}/nav-compat-gip/cache-control`);
    expect(document.status()).toBe(200);
    expect(document.headers()["cache-control"]).toBe(NEVER_CACHE);
    const html = await document.text();
    expect(html).toContain('<pre id="gip-slug">cache-control</pre>');

    const buildId = /"buildId":"([^"]+)"/.exec(html)?.[1];
    expect(buildId).toBeTruthy();
    const data = await request.get(
      `${BASE}/_next/data/${buildId}/nav-compat-gip/cache-control.json`,
      { headers: { "x-nextjs-data": "1" } },
    );
    expect(data.status()).toBe(200);
    expect(data.headers()["cache-control"]).toBe(NEVER_CACHE);
  });

  // Middleware and next.config headers are on the res before getInitialProps
  // runs, so the default only fills a missing Cache-Control.
  for (const param of ["mw-cache-control", "config-cache-control"]) {
    test(`a ${param} Cache-Control replaces the getInitialProps default`, async ({ request }) => {
      const document = await request.get(`${BASE}/nav-compat-gip/cache-policy?${param}=1`);
      expect(document.status()).toBe(200);
      expect(document.headers()["cache-control"]).toBe("public, max-age=60");
      const buildId = /"buildId":"([^"]+)"/.exec(await document.text())?.[1];
      expect(buildId).toBeTruthy();

      const data = await request.get(
        `${BASE}/_next/data/${buildId}/nav-compat-gip/cache-policy.json?${param}=1`,
        { headers: { "x-nextjs-data": "1" } },
      );
      expect(data.status()).toBe(200);
      expect(data.headers()["cache-control"]).toBe("public, max-age=60");
    });
  }

  test("a getStaticPaths fallback shell is never cached", async ({ request }) => {
    const pid = `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const shell = await request.get(`${BASE}/products/${pid}`);
    expect(shell.status()).toBe(200);
    expect(await shell.text()).toContain("Loading product...");
    expect(shell.headers()["cache-control"]).toBe(NEVER_CACHE);
  });
});
