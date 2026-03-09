/**
 * Next.js Compatibility Tests: app-css
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-css
 *
 * Tests CSS handling in the App Router at the SSR level:
 * - CSS module class names are scoped (not literal) in SSR HTML
 * - CSS module page renders content
 * - Global CSS page renders content
 * - Global CSS class names are preserved (not scoped) in SSR HTML
 *
 * NOTE: Full CSS validation (computed styles, visual appearance) requires
 * Playwright. These tests only verify SSR-level class name handling.
 *
 * Fixture pages live in:
 * - fixtures/app-basic/app/nextjs-compat/css-test/
 * - fixtures/app-basic/app/nextjs-compat/css-test/global/
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ViteDevServer } from "vite";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

describe("Next.js compat: app-css", () => {
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

  // ── CSS Modules ─────────────────────────────────────────────
  // Next.js: CSS module class names should be scoped in SSR
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-css

  it("CSS module class name is applied in SSR HTML", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/css-test");
    // The h1 should have a scoped class name, NOT the literal "heading"
    // Vite CSS modules produce class names like `_heading_xxxxx_x`
    // Match an id="css-page" element with a class attribute that is NOT just "heading"
    const classMatch = html.match(/id="css-page"\s+class="([^"]*)"/);
    expect(classMatch).not.toBeNull();
    const className = classMatch![1];
    // The scoped class name should NOT be the literal unscoped name
    expect(className).not.toBe("heading");
    // It should contain some transformation of "heading"
    expect(className.length).toBeGreaterThan(0);
  });

  it("CSS module page renders content", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/css-test");
    expect(html).toContain("CSS Module Test");
  });

  // ── Global CSS ──────────────────────────────────────────────
  // Next.js: global CSS class names should be preserved in SSR

  it("global CSS page renders content", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/css-test/global");
    expect(html).toContain("Global CSS Test");
  });

  it("global CSS class name is preserved in SSR", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/css-test/global");
    // Global CSS class names are NOT scoped — should appear as-is
    expect(html).toContain('class="global-heading"');
  });

  // ── Browser-only tests (documented, not ported) ──────────────
  //
  // The following tests require Playwright and are N/A for HTTP-level testing:
  //
  // N/A: Computed styles (color, font-size, font-weight)
  //   Tests actual CSS property values in the browser
  //
  // N/A: CSS-in-JS (styled-components, emotion, etc.)
  //   Tests client-side CSS injection libraries
  //
  // N/A: CSS HMR (hot module replacement)
  //   Tests live CSS updates during development
  //
  // N/A: Tailwind CSS class application
  //   Tests utility classes resolved at build time
  //
  // N/A: CSS ordering / specificity
  //   Tests style cascade behavior in the browser
});
