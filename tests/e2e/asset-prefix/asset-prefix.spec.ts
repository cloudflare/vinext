/**
 * E2E tests for assetPrefix — CDN-prefixed asset URLs in rendered HTML.
 *
 * Ported from Next.js: test/e2e/asset-prefix/asset-prefix.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/asset-prefix/asset-prefix.test.ts
 *
 * Verifies that when `assetPrefix: "https://cdn.example.com"` is set in
 * next.config, the server-rendered HTML injects <script> and <link> tags
 * whose URLs are prefixed with the CDN origin. Page navigation links
 * (href to /, /about) must NOT carry the CDN prefix.
 *
 * These tests run against `vinext build` + `vinext start` output on port 4180
 * (the "asset-prefix-prod" Playwright project defined in playwright.config.ts).
 */
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4180";
const CDN = "https://cdn.example.com";

test.describe("assetPrefix — script and link tags in rendered HTML", () => {
  test("script[type=module] src attributes are CDN-prefixed", async ({ request }) => {
    const response = await request.get(`${BASE}/`);
    expect(response.status()).toBe(200);
    const html = await response.text();

    // Collect all <script type="module" src="..."> tags (asset chunks / entry)
    const scriptSrcs = [...html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)].map(
      (m) => m[1],
    );

    // There must be at least one module script injected for the client entry
    expect(
      scriptSrcs.length,
      `Expected at least one <script type="module"> in HTML.\nFull HTML:\n${html}`,
    ).toBeGreaterThan(0);

    for (const src of scriptSrcs) {
      expect(
        src,
        `<script src="${src}"> should start with CDN origin`,
      ).toMatch(new RegExp(`^${CDN}/`));
    }
  });

  test("link[rel=modulepreload] href attributes are CDN-prefixed", async ({ request }) => {
    const response = await request.get(`${BASE}/`);
    expect(response.status()).toBe(200);
    const html = await response.text();

    const preloadHrefs = [
      ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g),
    ].map((m) => m[1]);

    // There must be at least one modulepreload link for the client entry
    expect(
      preloadHrefs.length,
      `Expected at least one <link rel="modulepreload"> in HTML.\nFull HTML:\n${html}`,
    ).toBeGreaterThan(0);

    for (const href of preloadHrefs) {
      expect(
        href,
        `<link rel="modulepreload" href="${href}"> should start with CDN origin`,
      ).toMatch(new RegExp(`^${CDN}/`));
    }
  });

  test("link[rel=stylesheet] href attributes are CDN-prefixed when CSS is present", async ({
    request,
  }) => {
    const response = await request.get(`${BASE}/`);
    expect(response.status()).toBe(200);
    const html = await response.text();

    const cssHrefs = [
      ...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g),
    ].map((m) => m[1]);

    // If any stylesheet link tags exist, all of them must be CDN-prefixed.
    // (CSS injection depends on whether the build produces a separate CSS chunk.)
    for (const href of cssHrefs) {
      expect(
        href,
        `<link rel="stylesheet" href="${href}"> should start with CDN origin`,
      ).toMatch(new RegExp(`^${CDN}/`));
    }
  });

  test("page navigation links do NOT carry the CDN prefix", async ({ request }) => {
    const response = await request.get(`${BASE}/`);
    expect(response.status()).toBe(200);
    const html = await response.text();

    // Extract all <a href="..."> anchors from the HTML
    const anchorHrefs = [...html.matchAll(/<a[^>]+href="([^"]+)"/g)].map((m) => m[1]);

    // The page must render at least the /about navigation link
    const pageLinks = anchorHrefs.filter((href) => href.startsWith("/"));
    expect(
      pageLinks.length,
      "Expected at least one page navigation link starting with /",
    ).toBeGreaterThan(0);

    for (const href of anchorHrefs) {
      expect(
        href,
        `<a href="${href}"> is a page route and must NOT start with the CDN origin`,
      ).not.toMatch(new RegExp(`^${CDN}/`));
    }
  });

  test("/about page also serves CDN-prefixed assets", async ({ request }) => {
    const response = await request.get(`${BASE}/about`);
    expect(response.status()).toBe(200);
    const html = await response.text();

    const scriptSrcs = [...html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)].map(
      (m) => m[1],
    );

    expect(
      scriptSrcs.length,
      `Expected at least one <script type="module"> on /about.\nFull HTML:\n${html}`,
    ).toBeGreaterThan(0);

    for (const src of scriptSrcs) {
      expect(src).toMatch(new RegExp(`^${CDN}/`));
    }
  });
});
