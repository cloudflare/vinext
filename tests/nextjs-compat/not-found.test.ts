/**
 * Next.js Compatibility Tests: not-found (basic)
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found/basic/index.test.ts
 *
 * Tests not-found boundary behavior in the App Router:
 * - Root not-found.tsx renders for unmatched routes (404 status)
 * - notFound() called in page returns 404
 * - Dynamic route [id] with scoped not-found boundary
 * - Escalation to parent layout when no not-found boundary exists
 * - notFound() propagates past error boundaries
 * - noindex meta tag in not-found response
 *
 * Fixture pages live in:
 * - fixtures/app-basic/app/not-found.tsx (root, pre-existing)
 * - fixtures/app-basic/app/notfound-test/page.tsx (pre-existing)
 * - fixtures/app-basic/app/nextjs-compat/not-found-dynamic/ (new)
 * - fixtures/app-basic/app/nextjs-compat/not-found-no-boundary/ (new)
 * - fixtures/app-basic/app/nextjs-compat/not-found-error-boundary/ (new)
 *
 * NOTE: Some Next.js tests are browser-only (click button -> client-side notFound()).
 * Those are marked with a comment and would need to go in Playwright specs.
 * This file covers all HTTP-level (SSR) tests.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ViteDevServer } from "vite";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

describe("Next.js compat: not-found", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up the server
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // ── Root not-found ──────────────────────────────────────────
  // Next.js: it('should return 404 status code for custom not-found page', ...)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found/basic/index.test.ts#L35-L38
  it("should return 404 for unmatched routes", async () => {
    const res = await fetch(`${baseUrl}/random-content-that-does-not-exist`);
    expect(res.status).toBe(404);
  });

  // Next.js: it('should use the not-found page for non-matching routes', ...)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found/basic/index.test.ts#L65-L71
  it("should render root not-found content for non-matching routes", async () => {
    const { html } = await fetchHtml(baseUrl, "/random-content-that-does-not-exist");
    // Root not-found.tsx renders "404 - Page Not Found"
    expect(html).toContain("404 - Page Not Found");
    // Should be wrapped in root layout (html tag with lang)
    expect(html).toContain('<html lang="en">');
  });

  // ── Shell notFound() ───────────────────────────────────────
  // Next.js: it('should return 404 status if notFound() is called in shell', ...)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found/basic/index.test.ts#L59-L63
  it("should return 404 when notFound() is called in a page", async () => {
    const res = await fetch(`${baseUrl}/notfound-test`);
    expect(res.status).toBe(404);
  });

  it("should include noindex meta tag in not-found response", async () => {
    const { html } = await fetchHtml(baseUrl, "/notfound-test");
    expect(html).toContain("noindex");
  });

  // ── Dynamic route with scoped not-found ─────────────────────
  // Next.js: it('should match dynamic route not-found boundary correctly', ...)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found/basic/index.test.ts#L73-L87

  it("dynamic index page renders normally", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/not-found-dynamic");
    expect(res.status).toBe(200);
    expect(html).toContain("dynamic");
  });

  it("dynamic [id] page renders for valid id", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/not-found-dynamic/123");
    expect(res.status).toBe(200);
    expect(html).toContain("dynamic [id]");
  });

  it("dynamic [id] notFound() uses scoped not-found boundary", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/not-found-dynamic/404");
    expect(res.status).toBe(404);
    // Should render the scoped not-found.tsx at [id] level, not the root one
    expect(html).toContain("dynamic/[id] not found");
    // Should NOT contain root not-found content
    expect(html).not.toContain("404 - Page Not Found");
  });

  // ── Escalation without not-found boundary ──────────────────
  // Next.js: it('should escalate notFound to parent layout if no not-found boundary present', ...)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found/basic/index.test.ts#L89-L107

  it("layout without not-found boundary renders its page normally", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/not-found-no-boundary");
    expect(res.status).toBe(200);
    expect(html).toContain("Dynamic with Layout");
  });

  it("dynamic [id] page renders for valid id (no-boundary)", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/not-found-no-boundary/123");
    expect(res.status).toBe(200);
    expect(html).toContain("not-found-no-boundary [id]");
  });

  it("notFound() escalates to root not-found when no local boundary exists", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/not-found-no-boundary/404");
    expect(res.status).toBe(404);
    // Should render ROOT not-found.tsx since there's no local not-found boundary
    expect(html).toContain("404 - Page Not Found");
  });

  // ── Existing vinext tests: dashboard scoped not-found ──────
  // These exercise the pre-existing dashboard/not-found.tsx with dashboard/missing/page.tsx
  // (not from Next.js test suite, but validates the same pattern)

  it("dashboard/missing calls notFound() -> dashboard-scoped not-found", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/dashboard/missing");
    expect(res.status).toBe(404);
    expect(html).toContain("Dashboard: Page Not Found");
    // Should be wrapped in dashboard layout
    expect(html).toContain("dashboard-layout");
    // Should also be in root layout
    expect(html).toContain('<html lang="en">');
  });

  // ── Error boundary + notFound() interaction ────────────────
  // Next.js: it("should propagate notFound errors past a segment's error boundary", ...)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found/basic/index.test.ts#L14-L29
  //
  // The original test uses browser-based button clicks for root + nested-2 routes
  // (client-side notFound()), but SSR-based notFound() for the dynamic route.
  // We test the SSR-based part here. Browser tests would go in Playwright.

  it("notFound() in server component propagates past error boundary to not-found boundary", async () => {
    // /nextjs-compat/not-found-error-boundary/nested/trigger-not-found
    // has error.tsx at parent levels, but notFound() should bypass them
    // and reach nested/not-found.tsx
    const { res, html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/not-found-error-boundary/nested/trigger-not-found",
    );
    expect(res.status).toBe(404);
    expect(html).toContain("Not Found (error-boundary/nested)");
    // Should NOT show the error boundary content
    expect(html).not.toContain("There was an error");
  });

  // ── Metadata cascade into not-found pages ───────────────────
  // Next.js cascades metadata from parent layouts into not-found/error pages.

  it("not-found page should inherit metadata title from parent layout", async () => {
    const { res, html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-not-found/missing",
    );
    expect(res.status).toBe(404);
    // Should render the not-found content
    expect(html).toContain("Not Found (metadata test)");
    // Should inherit the title from the parent layout's metadata export
    expect(html).toContain("<title>Metadata Not Found Layout Title</title>");
  });

  it("not-found page should inherit metadata description from parent layout", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-not-found/missing",
    );
    expect(html).toContain(
      '<meta name="description" content="Layout description for not-found test"',
    );
  });

  it("not-found page should still include noindex meta tag alongside layout metadata", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-not-found/missing",
    );
    // noindex should still be present
    expect(html).toContain("noindex");
    // Layout metadata should also be present
    expect(html).toContain("<title>Metadata Not Found Layout Title</title>");
  });

  // ── notFound() from layout components ───────────────────────
  // Tests that notFound() thrown from a layout component is caught by the
  // parent layout's NotFoundBoundary (per-layout boundary matching Next.js).

  it("valid slug renders page through layout", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/not-found-layout/hello");
    expect(res.status).toBe(200);
    expect(html).toContain("not-found-layout-page");
    expect(html).toContain("not-found-layout-wrapper");
  });

  it("notFound() from layout is caught by parent boundary", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/not-found-layout/invalid");
    expect(res.status).toBe(404);
    // Should render the PARENT not-found.tsx (not-found-layout/not-found.tsx)
    // because the layout at [slug] level threw, and the boundary at that level
    // only wraps the layout's children, not the layout itself.
    expect(html).toContain("Not Found (parent boundary)");
    // Should NOT render the slug-level not-found (that's for page errors)
    expect(html).not.toContain("Not Found (slug boundary)");
    // Should NOT show the layout wrapper (layout threw before rendering)
    expect(html).not.toContain("not-found-layout-wrapper");
  });

  it("notFound() from layout returns 404 status", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/not-found-layout/does-not-exist`);
    expect(res.status).toBe(404);
  });

  // ── notFound() from both layout AND page ─────────────────────
  // When both the layout and the page call notFound() for invalid params,
  // the layout's notFound() should take precedence (layouts render before
  // pages in Next.js). Without correct pre-render ordering, the page's
  // notFound() is caught first, and the fallback rendering includes the
  // throwing layout, causing a 500 error.

  it("layout+page notFound(): valid slug renders page", async () => {
    const { res, html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/not-found-layout-page/hello",
    );
    expect(res.status).toBe(200);
    expect(html).toContain("not-found-layout-page-content");
    expect(html).toContain("not-found-layout-page-wrapper");
  });

  it("layout+page notFound(): invalid slug caught by parent boundary (not 500)", async () => {
    const { res, html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/not-found-layout-page/invalid",
    );
    // Must be 404, NOT 500 — the layout's notFound() should be caught first,
    // rendering with parent layouts only (excluding the throwing layout).
    expect(res.status).toBe(404);
    // Should render the PARENT boundary (layout threw, propagates up)
    expect(html).toContain("Not Found (layout-page parent boundary)");
    // Should NOT render the slug-level boundary
    expect(html).not.toContain("Not Found (layout-page slug boundary)");
    // Should NOT show the layout wrapper (layout threw before rendering)
    expect(html).not.toContain("not-found-layout-page-wrapper");
  });

  it("layout+page notFound(): RSC request returns 404 (not 500)", async () => {
    const res = await fetch(
      `${baseUrl}/nextjs-compat/not-found-layout-page/invalid.rsc`,
      { headers: { Accept: "text/x-component" } },
    );
    // RSC response must be 404 with valid flight data, not 500
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/x-component");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    // Should contain the parent boundary's not-found content
    expect(body).toContain("layout-page parent boundary");
  });

  // ── RSC (client-side navigation) not-found ──────────────────
  // When navigating client-side, the request goes to .rsc endpoint.
  // The RSC response must contain valid flight data with not-found content.

  it("RSC request for unmatched route returns 404 with valid RSC payload", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist.rsc`, {
      headers: { Accept: "text/x-component" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/x-component");
    const body = await res.text();
    // RSC flight payload should contain the not-found content
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("404");
  });

  it("RSC request for page calling notFound() returns 404 with valid RSC payload", async () => {
    const res = await fetch(`${baseUrl}/notfound-test.rsc`, {
      headers: { Accept: "text/x-component" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/x-component");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("404");
  });

  it("RSC not-found response includes client component wrappers matching normal pages", async () => {
    // The RSC flight payload for not-found pages must include the same
    // component wrapper structure (ErrorBoundary, LayoutSegmentProvider) as
    // normal pages. Without these, React's tree reconciliation during
    // client-side navigation fails, causing a blank white page.
    const nfRes = await fetch(`${baseUrl}/does-not-exist.rsc`, {
      headers: { Accept: "text/x-component" },
    });
    const nfBody = await nfRes.text();
    const normalRes = await fetch(`${baseUrl}/about.rsc`, {
      headers: { Accept: "text/x-component" },
    });
    const normalBody = await normalRes.text();

    // Both should reference ErrorBoundary (from global-error or error boundary wrapper)
    const normalHasErrorBoundary = normalBody.includes("ErrorBoundary");
    if (normalHasErrorBoundary) {
      // If the normal page has ErrorBoundary (meaning global-error.tsx exists),
      // the not-found RSC should also include it
      expect(nfBody).toContain("ErrorBoundary");
    }

    // Both should reference LayoutSegmentProvider
    const normalHasLSP = normalBody.includes("LayoutSegmentProvider");
    if (normalHasLSP) {
      expect(nfBody).toContain("LayoutSegmentProvider");
    }
  });

  // ── Browser-only tests (need Playwright, documented here) ──
  // These tests require clicking a button client-side which triggers notFound()
  // in a client component. Cannot be tested via HTTP fetch alone.
  //
  // SKIP: Client-side notFound() from error-boundary/page.tsx button -> Root Not Found
  //   Source: index.test.ts#L15-L17
  //   WHY SKIPPED: Requires Playwright browser to click button, trigger client-side
  //   state change that calls notFound(). Test that the error.tsx boundary does NOT
  //   catch it, and instead the root not-found.tsx renders.
  //   TO PORT: Add to tests/e2e/app-router/nextjs-compat/not-found.spec.ts as Playwright test.
  //   FIXTURE: fixtures/app-basic/app/nextjs-compat/not-found-error-boundary/page.tsx
  //
  // SKIP: Client-side notFound() from error-boundary/nested/nested-2/page.tsx -> nested not-found
  //   Source: index.test.ts#L19-L23
  //   WHY SKIPPED: Same — requires Playwright click. Tests that nested error.tsx is bypassed
  //   and the nested/not-found.tsx renders instead.
  //   TO PORT: Add to same Playwright spec.
  //   FIXTURE: fixtures/app-basic/app/nextjs-compat/not-found-error-boundary/nested/nested-2/page.tsx
  //
  // SKIP: Dev-only file rename test (remove page.js -> 404, re-add -> page)
  //   Source: index.test.ts#L109-L119
  //   WHY SKIPPED: Requires runtime file manipulation and HMR verification.
  //   This tests Vite's HMR + file watcher integration rather than not-found logic per se.
  //   Not worth porting — vinext's existing HMR tests cover this.
  //   N/A for compat suite.
  //
  // N/A: Build-time tests (file traces, pages manifest, 404.html generation)
  //   Source: index.test.ts#L40-L56, #L121-L129
  //   WHY N/A: These test Next.js build output formats (.next/server/pages/404.html, nft.json).
  //   Vinext has a different build output structure. Not applicable.
  //
  // N/A: Edge runtime variant
  //   Source: index.test.ts#L131-L146
  //   WHY N/A: Tests re-running with `runtime = 'edge'` patched into layout.
  //   Vinext handles edge via Cloudflare Workers with separate test projects.
  //   Not applicable to the shared fixture approach.
});
