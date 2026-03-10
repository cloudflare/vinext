/**
 * Next.js Compatibility Tests: hooks
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/hooks/hooks.test.ts
 *
 * Tests hook behavior in the App Router at the HTTP/SSR level:
 * - useParams returns correct single, nested, and catch-all dynamic params
 * - useSearchParams reads query string values and handles missing params
 * - usePathname returns the correct path
 * - useRouter page renders correctly with pathname
 *
 * NOTE: Browser-only hook behavior (client-side navigation, router.push,
 * router.back, etc.) requires Playwright and is not tested here.
 *
 * Fixture pages live in:
 * - fixtures/app-basic/app/nextjs-compat/hooks-params/[id]/page.tsx
 * - fixtures/app-basic/app/nextjs-compat/hooks-params/[id]/[subid]/page.tsx
 * - fixtures/app-basic/app/nextjs-compat/hooks-params/catchall/[...slug]/page.tsx
 * - fixtures/app-basic/app/nextjs-compat/hooks-search/page.tsx
 * - fixtures/app-basic/app/nextjs-compat/hooks-router/page.tsx
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ViteDevServer } from "vite";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

describe("Next.js compat: hooks", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up
    await fetchHtml(baseUrl, "/nextjs-compat/hooks-params/test-id");
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // ── useParams SSR ───────────────────────────────────────────
  // Next.js: 'should have the correct hooks at /adapter-hooks/1'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/hooks/hooks.test.ts

  it("useParams returns correct single dynamic param in SSR", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/hooks-params/my-id");
    expect(html).toContain('<p id="param-id">my-id</p>');
  });

  // Next.js: 'should have the correct hooks at /adapter-hooks/1'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/hooks/hooks.test.ts

  it("useParams returns correct nested dynamic params in SSR", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/hooks-params/parent-id/child-id");
    expect(html).toContain("parent-id");
    expect(html).toContain("child-id");
  });

  // Next.js: 'should have the correct hooks at /adapter-hooks/1'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/hooks/hooks.test.ts

  it("useParams returns correct catch-all params in SSR", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/hooks-params/catchall/a/b/c");
    // React HTML-encodes quotes in SSR output: &quot; instead of "
    expect(html).toContain("[&quot;a&quot;,&quot;b&quot;,&quot;c&quot;]");
  });

  // ── useSearchParams SSR ─────────────────────────────────────
  // Next.js: 'should have the correct hooks at /adapter-hooks/1'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/hooks/hooks.test.ts

  it("useSearchParams reads query string in SSR", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/hooks-search?q=hello&page=3");
    expect(html).toContain("hello");
    expect(html).toContain("3");
  });

  // Next.js: 'should have the correct hooks at /adapter-hooks/1'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/hooks/hooks.test.ts

  it("useSearchParams returns empty when no query", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/hooks-search");
    // Both q and page should show "N/A" when no query string is provided
    expect(html).toContain('<p id="param-q">N/A</p>');
    expect(html).toContain('<p id="param-page">N/A</p>');
  });

  // ── usePathname SSR ─────────────────────────────────────────
  // Next.js: 'should have the correct hooks at /adapter-hooks/1'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/hooks/hooks.test.ts

  it("usePathname returns correct path in SSR", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/hooks-search");
    expect(html).toContain("/nextjs-compat/hooks-search");
  });

  // ── useRouter SSR ───────────────────────────────────────────
  // Next.js: 'should have the correct hooks at /adapter-hooks/1'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/hooks/hooks.test.ts

  it("useRouter page renders correctly in SSR", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/hooks-router");
    expect(html).toContain("Router Test Page");
    expect(html).toContain("/nextjs-compat/hooks-router");
  });

  // ── Browser-only tests (documented, not ported) ──────────────
  //
  // The following tests ALL require Playwright and are N/A for HTTP-level testing:
  //
  // N/A: useParams identity (object stability across renders)
  //   Tests that useParams returns the same object reference on re-render
  //
  // N/A: useRouter.push / replace / back / forward
  //   Tests client-side navigation triggered by router methods
  //
  // N/A: useRouter.refresh
  //   Tests client-side refresh behavior after hydration
  //
  // N/A: useSearchParams updates after client-side navigation
  //   Tests reading search params after pushState or router.push
  //
  // N/A: usePathname updates after client-side navigation
  //   Tests pathname changes after router.push or Link clicks
});
