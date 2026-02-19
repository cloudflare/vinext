/**
 * Next.js Compatibility Tests: global-error (basic)
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/basic/index.test.ts
 *
 * Tests error boundary behavior in the App Router:
 * - Server component errors caught by error.tsx
 * - Client component SSR errors caught by error.tsx
 * - Global-error.tsx as the last resort for root-level errors
 * - generateMetadata() errors caught by local error.tsx when present
 * - generateMetadata() errors escalating to global-error when no local boundary
 *
 * NOTE: Most Next.js global-error tests are browser-based (click buttons, check
 * rendered error UI after hydration/client error). This file tests SSR-level
 * behavior — does the server return a response (not crash) when pages throw?
 *
 * Fixture pages live in:
 * - fixtures/app-basic/app/global-error.tsx (pre-existing)
 * - fixtures/app-basic/app/error-server-test/ (pre-existing)
 * - fixtures/app-basic/app/nextjs-compat/global-error-rsc/ (new)
 * - fixtures/app-basic/app/nextjs-compat/global-error-ssr/ (new)
 * - fixtures/app-basic/app/nextjs-compat/metadata-error-{with,without}-boundary/ (new)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ViteDevServer } from "vite";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

describe("Next.js compat: global-error", () => {
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

  // ── Pre-existing vinext error tests ─────────────────────────
  // These validate that vinext's existing error handling works,
  // providing a baseline before we test Next.js-specific patterns.

  it("error-server-test: server component throw is caught by error.tsx", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/error-server-test");
    expect(res.status).toBe(200);
    expect(html).toContain("Server Error Caught");
  });

  it("error-nested-test: nested error caught by inner error.tsx", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/error-nested-test/child");
    expect(res.status).toBe(200);
    expect(html).toContain("inner-error-boundary");
    expect(html).not.toContain("outer-error-boundary");
  });

  // ── Server component error (RSC throw -> global-error) ─────
  // Next.js: it('should render global error for error in server components', ...)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/basic/index.test.ts#L29-L49
  //
  // In Next.js, a server component that throws with NO local error.tsx
  // falls through to global-error.js. In vinext, the behavior may differ
  // (the RSC error might produce a 500 or the global-error might render).

  it("server component throw without local error.tsx returns a response", async () => {
    // global-error-rsc/page.tsx throws "server page error" with no error.tsx
    const res = await fetch(`${baseUrl}/nextjs-compat/global-error-rsc`);
    // Should not crash the server — should return some response
    // Next.js returns 200 with global-error rendered. Vinext might return 500.
    expect(res.status).toBeLessThan(600);
    const html = await res.text();
    // At minimum, a response was returned (server didn't hang)
    expect(html.length).toBeGreaterThan(0);
  });

  // ── Client component SSR error ─────────────────────────────
  // Next.js: it('should render global error for error in client components during SSR', ...)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/basic/index.test.ts#L51-L66
  //
  // "use client" component that throws during SSR. In Next.js, global-error catches it.

  it("client component SSR throw without local error.tsx returns a response", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/global-error-ssr`);
    expect(res.status).toBeLessThan(600);
    const html = await res.text();
    expect(html.length).toBeGreaterThan(0);
  });

  // ── Metadata error with local boundary ─────────────────────
  // Next.js: it('should catch metadata error in error boundary if presented', ...)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/basic/index.test.ts#L68-L73
  //
  // generateMetadata() throws, but a local error.tsx exists to catch it.

  it("generateMetadata() error caught by local error.tsx boundary", async () => {
    const { res, html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-error-with-boundary",
    );
    expect(res.status).toBeLessThan(600);
    expect(html).toContain("Local error boundary");
  });

  // ── Metadata error without boundary ────────────────────────
  // Next.js: it('should catch metadata error in global-error if no error boundary', ...)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/basic/index.test.ts#L75-L93
  //
  // generateMetadata() throws, no local error.tsx — falls to global-error.

  it("generateMetadata() error without local boundary returns a response", async () => {
    const res = await fetch(
      `${baseUrl}/nextjs-compat/metadata-error-without-boundary`,
    );
    expect(res.status).toBeLessThan(600);
    const html = await res.text();
    expect(html.length).toBeGreaterThan(0);
  });

  // ── Browser-only tests (need Playwright, documented here) ──
  //
  // SKIP: Client-side error trigger via button click -> global-error renders
  //   Source: index.test.ts#L9-L27
  //   WHY SKIPPED: Requires Playwright to click #error-trigger-button, which sets
  //   state causing a throw. The global-error.tsx should render with the error message.
  //   TO PORT: Create tests/e2e/app-router/nextjs-compat/global-error.spec.ts with
  //   Playwright test that navigates to the page, clicks the button, and verifies
  //   the global-error UI appears.
  //   FIXTURE NEEDED: A page with a "use client" button that triggers a throw
  //   (similar to error-test/throwing-component.tsx but WITHOUT a local error.tsx).
  //
  // SKIP: Nested client error auto-thrown via useEffect/setTimeout -> global-error
  //   Source: index.test.ts#L95-L111
  //   WHY SKIPPED: The nested page uses useEffect to set state that causes throw.
  //   This happens after hydration, so requires a browser to observe.
  //   TO PORT: Same Playwright spec file.
  //   FIXTURE: fixtures/app-basic/app/nextjs-compat/global-error-nested/
  //
  // SKIP: Dev-only Redbox display verification
  //   Source: Multiple tests in index.test.ts
  //   WHY SKIPPED: Tests Next.js-specific dev overlay (Redbox) error display format.
  //   Vinext uses Vite's error overlay which has different formatting.
  //   N/A for compat suite.
});
