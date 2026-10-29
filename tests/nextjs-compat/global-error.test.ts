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
 * - layout generateMetadata() errors following the same boundary path
 * - layout generateViewport() errors streaming through the same recoverable outlet path
 *
 * NOTE: Most Next.js global-error tests are browser-based (click buttons, check
 * rendered error UI after hydration/client error). This file tests the raw HTTP
 * boundary: like Next.js, an error that rejects the document's shell answers
 * 500 with the `__next_error__` error document, carrying the payload of the
 * render that failed, and streamed metadata errors produce a recoverable
 * shell. The browser-level suite (tests/e2e/app-router/error-handling.spec.ts)
 * verifies the boundary the browser then renders.
 *
 * Fixture pages live in:
 * - fixtures/app-basic/app/global-error.tsx (pre-existing)
 * - fixtures/app-basic/app/error-server-test/ (pre-existing)
 * - fixtures/app-basic/app/nextjs-compat/global-error-rsc/ (new)
 * - fixtures/app-basic/app/nextjs-compat/global-error-ssr/ (new)
 * - fixtures/app-basic/app/nextjs-compat/metadata-error-{with,without}-boundary/ (new)
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { createBuilder, preview, type ViteDevServer } from "vite-plus";
import vinext from "../../packages/vinext/src/index.js";
import {
  APP_FIXTURE_DIR,
  createIsolatedFixture,
  startFixtureServer,
  fetchHtml,
  testCacheDir,
} from "../helpers.js";

/**
 * Next.js answers an error that rejects the document's shell with an error
 * document, carrying the payload of the render that failed, and the browser
 * renders the error boundary that payload carries. No boundary renders on the
 * server.
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/app-render.tsx (getErrorRSCPayload)
 */
function expectErrorDocument(res: Response, html: string): void {
  expect(res.status).toBe(500);
  expect(res.headers.get("cache-control")).toBe(
    "private, no-cache, no-store, max-age=0, must-revalidate",
  );
  expect(html).toContain('<html id="__next_error__"');
  expect(html).not.toContain('data-testid="global-error"');
  expect((html.match(/<html/gi) || []).length).toBe(1);
  expect((html.match(/<body/gi) || []).length).toBe(1);
}

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

  it("error-server-test: server component throw answers with the error document", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/error-server-test");
    expectErrorDocument(res, html);
    expect(html).not.toContain("Server Error Caught");
  });

  it("error-nested-test: nested error answers with the error document", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/error-nested-test/child");
    expectErrorDocument(res, html);
    expect(html).not.toContain('data-testid="inner-error-boundary"');
  });

  it("route group error.tsx without sibling layout: descendant server error answers with the error document", async () => {
    // The browser renders the route group's error.tsx; see error-handling.spec.ts.
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/route-group-error/child");
    expectErrorDocument(res, html);
    expect(html).not.toContain('id="route-group-error-boundary"');
  });

  // ── Server component error (RSC throw -> global-error) ─────
  // Next.js: it('should render global error for error in server components', ...)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/basic/index.test.ts#L29-L49
  //
  // In Next.js, a server component that throws with NO local error.tsx
  // falls through to global-error.js, which the browser renders from the
  // error document's payload.

  it("server component throw without local error.tsx answers with the error document", async () => {
    // global-error-rsc/page.tsx throws "server page error" with no error.tsx.
    // Source: index.test.ts#L29-L49
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/global-error-rsc");
    expectErrorDocument(res, html);
    // In development the payload carries the error's message.
    expect(html).toContain("server page error");
  });

  // ── Client component SSR error ─────────────────────────────
  // Next.js: it('should render global error for error in client components during SSR', ...)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/basic/index.test.ts#L51-L66
  //
  // "use client" component that throws during SSR. In Next.js, global-error catches it.

  it("client component SSR throw without local error.tsx answers with the error document", async () => {
    // "use client" component throws during SSR. The browser renders it again,
    // and global-error.tsx catches it. Source: index.test.ts#L51-L66
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/global-error-ssr");
    expectErrorDocument(res, html);
  });

  // ── Metadata error with local boundary ─────────────────────
  // Next.js: it('should catch metadata error in error boundary if presented', ...)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/basic/index.test.ts#L68-L73
  //
  // generateMetadata() throws, but a local error.tsx exists to catch it after
  // hydration. Next.js streams the page shell with a 200 before that boundary
  // takes over; its upstream test therefore asserts the hydrated browser DOM.

  it("generateMetadata() error streams a recoverable shell for the local boundary", async () => {
    // Source: index.test.ts#L68-L73
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-error-with-boundary");
    expect(res.status).toBe(200);
    expect(html).toContain("Sensitive metadata error detail");
    expect(html).not.toContain("Local error boundary");
  });

  // ── Metadata error without boundary ────────────────────────
  // Next.js: it('should catch metadata error in global-error if no error boundary', ...)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/basic/index.test.ts#L75-L93
  //
  // generateMetadata() throws, no local error.tsx — the streamed shell is
  // replaced by global-error.tsx after hydration.

  it("generateMetadata() error streams a recoverable shell for global-error", async () => {
    // Source: index.test.ts#L75-L93
    const { res, html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-error-without-boundary",
    );
    expect(res.status).toBe(200);
    expect(html).toContain("Sensitive metadata error detail");
    expect(html).not.toContain("Something went wrong!");
  });

  it("layout generateMetadata() error streams a recoverable shell for the local boundary", async () => {
    // Ported from Next.js: test/e2e/app-dir/global-error/basic/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/basic/index.test.ts
    const { res, html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/layout-metadata-error-with-boundary",
    );
    expect(res.status).toBe(200);
    expect(html).toContain("layout metadata page rendered");
    expect(html).not.toContain("Local layout metadata error boundary");
  });

  it("layout generateMetadata() error streams a recoverable shell for global-error", async () => {
    // Ported from Next.js: test/e2e/app-dir/global-error/basic/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/basic/index.test.ts
    const { res, html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/layout-metadata-error-without-boundary",
    );
    expect(res.status).toBe(200);
    expect(html).toContain("layout metadata page rendered");
    expect(html).not.toContain("Something went wrong!");
  });

  it("layout generateViewport() error streams a recoverable shell for the local boundary", async () => {
    // Next.js resolves viewport through the same paired outlet path:
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/metadata.tsx
    const { res, html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/layout-viewport-error-with-boundary",
    );
    expect(res.status).toBe(200);
    expect(html).toContain("layout viewport page rendered");
    expect(html).not.toContain("Local layout viewport error boundary");
  });

  it("layout generateViewport() error streams a recoverable shell for global-error", async () => {
    // Next.js resolves viewport through the same paired outlet path:
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/metadata.tsx
    const { res, html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/layout-viewport-error-without-boundary",
    );
    expect(res.status).toBe(200);
    expect(html).toContain("layout viewport page rendered");
    expect(html).not.toContain('data-testid="global-error"');
    expect(html).toContain("Layout viewport error");
  });

  // ── Self-throwing global-error -> built-in default fallback ──
  // Next.js: it('should render fallback UI when error occurs in global-error', ...)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/error-in-global-error/error-in-global-error.test.ts
  //
  // The server answers with the error document whether or not global-error.tsx
  // throws, and the browser renders the boundaries, so error-handling.spec.ts
  // checks the built-in fallback.

  // ── Structural integrity: no double <html>/<body> tags ───────
  // global-error.tsx provides its own <html> and <body>. When it renders,
  // the root layout's <html>/<body> must NOT also appear.

  it("global-error pages have exactly one <html> and one <body> tag", async () => {
    const routes = [
      "/nextjs-compat/global-error-rsc",
      "/nextjs-compat/global-error-ssr",
      "/nextjs-compat/metadata-error-without-boundary",
    ];
    for (const route of routes) {
      const { html } = await fetchHtml(baseUrl, route);
      const htmlTags = (html.match(/<html/gi) || []).length;
      const bodyTags = (html.match(/<body/gi) || []).length;
      expect(htmlTags, `${route} should have exactly 1 <html> tag, got ${htmlTags}`).toBe(1);
      expect(bodyTags, `${route} should have exactly 1 <body> tag, got ${bodyTags}`).toBe(1);
    }
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

describe("Next.js compat: global-error (production preview)", () => {
  let fixtureDir: string;
  let previewServer: Awaited<ReturnType<typeof preview>>;
  let baseUrl: string;

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(
      APP_FIXTURE_DIR,
      "vinext-global-error-",
      undefined,
      path.join(APP_FIXTURE_DIR, "node_modules"),
    );
    const builder = await createBuilder({
      root: fixtureDir,
      cacheDir: testCacheDir(fixtureDir),
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      logLevel: "silent",
    });
    await builder.buildApp();

    previewServer = await preview({
      root: fixtureDir,
      cacheDir: testCacheDir(fixtureDir),
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      preview: { port: 0 },
      logLevel: "silent",
    });

    const addr = previewServer.httpServer.address();
    if (!addr || typeof addr !== "object") {
      throw new Error("Preview server did not expose a port");
    }
    baseUrl = `http://localhost:${addr.port}`;
  }, 60_000);

  afterAll(() => {
    previewServer?.httpServer.close();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("server component throw without local error.tsx answers with the error document", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/global-error-rsc");
    expectErrorDocument(res, html);
    // The payload carries the error by its digest, not its message.
    expect(html).not.toContain("server page error");
    expect(html).toMatch(/\\"digest\\":\\"\d+\\"/);
  });

  it("client component SSR throw without local error.tsx answers with the error document", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/global-error-ssr");
    expectErrorDocument(res, html);
  });

  it("server component throw with local error.tsx answers with the error document", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/error-server-test");
    expectErrorDocument(res, html);
    expect(html).not.toContain("Server Error Caught");
  });

  it("nested server component throw answers with the error document", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/error-nested-test/child");
    expectErrorDocument(res, html);
    expect(html).not.toContain('data-testid="inner-error-boundary"');
  });

  it("generateMetadata() errors stream a recoverable shell for the local boundary", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-error-with-boundary");
    expect(res.status).toBe(200);
    expect(html).toContain("Metadata error");
    expect(html).not.toContain("Sensitive metadata error detail");
    expect(html).not.toContain("Local error boundary");
  });

  it("generateMetadata() errors stream a recoverable shell for global-error", async () => {
    const { res, html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-error-without-boundary",
    );
    expect(res.status).toBe(200);
    expect(html).toContain("Metadata error");
    expect(html).not.toContain("Sensitive metadata error detail");
    expect(html).not.toContain("Something went wrong!");
  });

  it("layout generateMetadata() errors stream a recoverable shell for the local boundary", async () => {
    const { res, html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/layout-metadata-error-with-boundary",
    );
    expect(res.status).toBe(200);
    expect(html).toContain("layout metadata page rendered");
    expect(html).not.toContain("Layout metadata error");
    expect(html).not.toContain("Local layout metadata error boundary");
  });

  it("layout generateMetadata() errors stream a recoverable shell for global-error", async () => {
    const { res, html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/layout-metadata-error-without-boundary",
    );
    expect(res.status).toBe(200);
    expect(html).toContain("layout metadata page rendered");
    expect(html).not.toContain("Layout metadata error");
    expect(html).not.toContain("Something went wrong!");
  });

  it("layout generateViewport() errors stream a recoverable shell for the local boundary", async () => {
    const { res, html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/layout-viewport-error-with-boundary",
    );
    expect(res.status).toBe(200);
    expect(html).toContain("layout viewport page rendered");
    expect(html).not.toContain("Local layout viewport error boundary");
    expect(html).not.toContain('data-testid="global-error"');
  });

  it("layout generateViewport() errors stream a recoverable shell for global-error", async () => {
    const { res, html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/layout-viewport-error-without-boundary",
    );
    expect(res.status).toBe(200);
    expect(html).toContain("layout viewport page rendered");
    expect(html).not.toContain('data-testid="global-error"');
    expect(html).not.toContain("Layout viewport error");
  });
});
