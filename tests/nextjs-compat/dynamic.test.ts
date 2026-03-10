/**
 * Next.js Compatibility Tests: next/dynamic
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic/dynamic.test.ts
 *
 * Tests next/dynamic behavior in the App Router:
 * - React.lazy in client components (SSR rendering)
 * - dynamic() in server components (SSR rendering)
 * - dynamic() in client components (SSR rendering)
 * - dynamic() server component importing client component
 * - dynamic() with ssr: false (content NOT present in SSR HTML)
 * - dynamic() with named exports (via .then(mod => mod.X))
 *
 * Fixture pages live in:
 * - fixtures/app-basic/app/nextjs-compat/dynamic/ (main page + components)
 * - fixtures/app-basic/app/nextjs-compat/dynamic/named-export/ (named export sub-page)
 * - fixtures/app-basic/app/nextjs-compat/dynamic/ssr-false-only/ (isolated ssr:false test)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ViteDevServer } from "vite";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

describe("Next.js compat: next/dynamic", () => {
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

  // ── Main /dynamic page ───────────────────────────────────────

  // Next.js: 'should handle next/dynamic in SSR correctly'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic/dynamic.test.ts#L17-L27
  //
  // The main /dynamic page composes:
  // 1. LazyClientComponent (React.lazy) -> renders "next-dynamic lazy"
  // 2. NextDynamicServerComponent (dynamic() in server) -> renders "next-dynamic dynamic on server"
  // 3. NextDynamicClientComponent (dynamic() in client) -> renders "next-dynamic dynamic on client"
  //    Also includes DynamicNoSSR (ssr:false) -> should NOT be in SSR HTML
  // 4. NextDynamicServerImportClientComponent -> renders "next-dynamic server import client"

  it("SSR: should contain React.lazy loaded content", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/dynamic");
    expect(html).toContain("next-dynamic lazy");
  });

  it("SSR: should contain dynamic() server component content", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/dynamic");
    expect(html).toContain("next-dynamic dynamic on server");
  });

  it("SSR: should contain dynamic() client component content", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/dynamic");
    expect(html).toContain("next-dynamic dynamic on client");
    expect(html).toContain('id="css-text-dynamic-client"');
  });

  // Regression test for issue #75: dynamic() client components must render
  // their own imported component, not another client component's content.
  it("SSR: dynamic() client should not render LazyClientComponent content (#75)", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/dynamic");
    // class="hi" appears exactly once (from LazyClientComponent), not duplicated
    // by NextDynamicClientComponent rendering the wrong module
    const hiMatches = (html.match(/class="hi"/g) || []).length;
    expect(hiMatches).toBe(1);
  });

  it("SSR: should contain dynamic() server-imported client content", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/dynamic");
    expect(html).toContain("next-dynamic server import client");
  });

  it("SSR: should NOT contain ssr:false client content in HTML", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/dynamic");
    expect(html).not.toContain("next-dynamic dynamic no ssr on client");
  });

  // ── Named export ─────────────────────────────────────────────

  // Next.js: 'should support dynamic import with accessing named exports from client component'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic/dynamic.test.ts#L97-L100
  //
  // Uses dynamic(() => import('./client').then(mod => ({ default: mod.Button })))

  it("SSR: named export via dynamic() should render button content", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/dynamic/named-export");
    expect(html).toContain("this is a client button");
  });

  // ── SSR false only page ──────────────────────────────────────

  // Next.js: 'should not render client component imported through ssr: false in client components'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic/dynamic.test.ts#L79-L96

  it("SSR: ssr:false page should contain static content", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/dynamic/ssr-false-only");
    expect(html).toContain("This is static content");
  });

  it("SSR: ssr:false page should NOT contain dynamic content", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/dynamic/ssr-false-only");
    expect(html).not.toContain("next-dynamic dynamic no ssr on client");
  });

  // ── Browser-only tests (documented, not ported) ──────────────
  //
  // SKIP: 'should handle next/dynamic in hydration correctly'
  //   Source: dynamic.test.ts#L29-L36
  //   WHY: Requires Playwright. After hydration, ssr:false component appears
  //   via client-side rendering. The #css-text-dynamic-no-ssr-client element
  //   should show "next-dynamic dynamic no ssr on client:suffix".
  //   TO PORT: tests/e2e/app-router/nextjs-compat/dynamic.spec.ts
  //
  // SKIP: 'should handle ssr: false in pages when appDir is enabled'
  //   Source: dynamic.test.ts#L13-L21
  //   WHY: Tests Pages Router /legacy/no-ssr. We're testing App Router patterns only.
  //   N/A for this suite.
  //
  // SKIP: 'should generate correct client manifest for dynamic chunks'
  //   Source: dynamic.test.ts#L38-L41
  //   WHY: Tests chunk loading via a specific /chunk-loading/server page.
  //   Would need a dedicated fixture. Low priority for compat.
  //   N/A — build manifest structure differs in vinext.
  //
  // SKIP: 'should render loading by default if loading is specified and loader is slow'
  //   Source: dynamic.test.ts#L43-L50
  //   WHY: Dev-only behavior — slow loader shows loading component. In production
  //   the component resolves. The test patches a file at runtime (dev-only).
  //   N/A for HTTP-level SSR testing.
  //
  // SKIP: 'should not render loading by default'
  //   Source: dynamic.test.ts#L52-L55
  //   WHY: Tests that dynamic component without loading option doesn't show "loading" text.
  //   Could be tested but needs a dedicated fixture. Low value.
  //
  // SKIP: 'should ignore next/dynamic in routes'
  //   Source: dynamic.test.ts#L57-L60
  //   WHY: Tests route handler (API route) behavior. Covered in Chunk 5 (app-routes).
  //
  // SKIP: 'should ignore next/dynamic in sitemap'
  //   Source: dynamic.test.ts#L62-L65
  //   WHY: Tests sitemap.xml generation. Vinext sitemap support is a separate feature.
  //   N/A for this suite.
  //
  // SKIP: 'should not render client component imported through ssr: false in client components in edge runtime'
  //   Source: dynamic.test.ts#L68-L96
  //   WHY: Tests edge runtime variant + build manifest inspection. Both need Playwright
  //   and prod build. N/A for dev SSR tests.
  //
  // SKIP: 'should support dynamic import with TLA in client components'
  //   Source: dynamic.test.ts#L102-L116
  //   WHY: Tests top-level await in client component dynamic imports.
  //   Partially testable at SSR level, but the key assertion (no-ssr text empty
  //   on server, present after hydration) needs Playwright.
  //   TO PORT: tests/e2e/app-router/nextjs-compat/dynamic.spec.ts
});
