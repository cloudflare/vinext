/**
 * Next.js Compatibility Tests: navigation
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts
 *
 * Tests navigation behavior in the App Router at the HTTP/SSR level:
 * - Server-side redirect() produces 307 with Location header
 * - Server-side notFound() produces 404 with noindex meta tag
 * - Redirect destination page renders correctly
 * - Not-found page renders root not-found.tsx
 *
 * NOTE: The vast majority of Next.js navigation tests are browser-based
 * (client-side nav, back/forward, hash scrolling, query strings, etc.).
 * This file only tests SSR-level behavior that doesn't require a browser.
 *
 * Fixture pages live in:
 * - fixtures/app-basic/app/nextjs-compat/nav-redirect-server/ (new)
 * - fixtures/app-basic/app/nextjs-compat/nav-redirect-result/ (new)
 * - fixtures/app-basic/app/nextjs-compat/nav-notfound-server/ (new)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ViteDevServer } from "vite";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

describe("Next.js compat: navigation", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // ── Server-side redirect ─────────────────────────────────────
  // Next.js: 'should redirect in a server component'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts#L168-L174

  it("redirect() in server component produces 307", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/nav-redirect-server`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/nextjs-compat/nav-redirect-result");
  });

  it("redirect destination page renders correctly", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/nav-redirect-result");
    expect(html).toContain("Result Page");
  });

  // ── Server-side notFound ─────────────────────────────────────
  // Next.js: 'should trigger not-found in a server component'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts#L136-L146

  it("notFound() in server component produces 404", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/nav-notfound-server`);
    expect(res.status).toBe(404);
  });

  it("404 page contains noindex meta tag", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/nav-notfound-server`);
    const html = await res.text();
    expect(html).toMatch(/meta\s+name="robots"\s+content="noindex"/);
  });

  // ── SEO: noindex for non-existent routes ─────────────────────
  // Next.js: 'should contain default meta tags in error page'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts#L299-L305

  it("non-existent route returns 404 with noindex", async () => {
    const res = await fetch(`${baseUrl}/this-route-definitely-does-not-exist`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toMatch(/meta\s+name="robots"\s+content="noindex"/);
  });

  // ── Browser-only tests (documented, not ported) ──────────────
  //
  // The following tests ALL require Playwright and are N/A for HTTP-level testing:
  //
  // N/A: Query string tests (set-query, semicolon, unicode search params)
  //   Tests client-side URL manipulation via browser interactions
  //
  // N/A: Hash scrolling tests (scroll to hash, scroll offset, back-to-same-page)
  //   Tests window.pageYOffset after client-side navigation
  //
  // N/A: Relative hashes and queries
  //   Tests client-side URL updates via Link and router.push
  //
  // N/A: Client-side not-found trigger
  //   Tests button click triggering notFound() after hydration
  //
  // N/A: Client-side redirect
  //   Tests button click triggering redirect() after hydration
  //
  // N/A: External URL redirect
  //   Tests navigation to external domain
  //
  // N/A: next.config.js redirects
  //   Tests config-based redirects, not supported in vinext the same way
  //
  // N/A: Middleware redirects
  //   Tests middleware-based redirects
  //
  // N/A: External push (router.push to external URL)
  //   Tests client-side external navigation
  //
  // N/A: Navigation between pages and app
  //   Tests Pages Router <-> App Router transitions
  //
  // N/A: Nested navigation
  //   Tests client-side nested route navigation with clicks
  //
  // N/A: Scroll restoration
  //   Tests browser scroll position preservation
  //
  // N/A: useRouter identity
  //   Tests router object stability across renders
  //
  // N/A: useParams identity
  //   Tests params object stability across renders
  //
  // N/A: Dynamic param casing change
  //   Tests navigation with parameter casing differences
  //
  // N/A: Popstate revalidate
  //   Tests form submission + browser back
  //
  // N/A: Locale warnings
  //   Tests console warnings for locale prop
  //
  // N/A: Metadata await promise during navigation
  //   Tests async metadata loading during client nav
  //
  // N/A: Redirect refresh meta tag
  //   Tests HTML meta refresh tag — would need streaming-specific fixture
});
