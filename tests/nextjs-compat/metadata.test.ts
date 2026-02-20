/**
 * Next.js Compatibility Tests: metadata
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts
 *
 * Tests metadata rendering in SSR HTML:
 * - Static metadata (title, description, keywords, etc.)
 * - Title template (layout provides template, page provides value)
 * - OpenGraph tags
 * - Twitter card tags
 * - Robots tags
 * - Alternate/canonical links
 * - generateMetadata() with dynamic params
 *
 * NOTE: Most Next.js metadata tests use Playwright (browser.eval('document.title')).
 * We test at the SSR level by checking HTML <head> content directly.
 *
 * Fixture pages live in:
 * - fixtures/app-basic/app/nextjs-compat/metadata-*
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ViteDevServer } from "vite";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

describe("Next.js compat: metadata", () => {
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

  // ── Title and description ────────────────────────────────────
  // Next.js: 'should support title and description'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L25-L32

  it("should render title in <head>", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-title",
    );
    expect(html).toContain("<title>this is the page title</title>");
  });

  it("should render description meta tag", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-title",
    );
    expect(html).toMatch(
      /meta\s+name="description"\s+content="this is the layout description"/,
    );
  });

  // ── Title template ───────────────────────────────────────────
  // Next.js: 'should support title template'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L34-L38

  it("should apply title template from layout", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-title-template",
    );
    // Layout has template "%s | Layout", page has title "Page"
    // Result should be "Page | Layout"
    expect(html).toContain("<title>Page | Layout</title>");
  });

  // Next.js: 'should support stashed title in one layer'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L40-L44

  it("should apply title template to child page", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-title-template/child",
    );
    // Layout template "%s | Layout", child page title "Extra Page"
    expect(html).toContain("<title>Extra Page | Layout</title>");
  });

  // ── Basic metadata tags ──────────────────────────────────────
  // Next.js: 'should support other basic tags'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L52-L89

  it("should render generator meta tag", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-basic",
    );
    expect(html).toMatch(/meta\s+name="generator"\s+content="next\.js"/);
  });

  it("should render application-name meta tag", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-basic",
    );
    expect(html).toMatch(/meta\s+name="application-name"\s+content="test"/);
  });

  it("should render referrer meta tag", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-basic",
    );
    expect(html).toMatch(
      /meta\s+name="referrer"\s+content="origin-when-cross-origin"/,
    );
  });

  it("should render keywords meta tag", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-basic",
    );
    // Next.js joins keywords with "," (no space) — match that exactly
    expect(html).toMatch(/meta\s+name="keywords"\s+content="next\.js,react,javascript"/);
  });

  it("should render author meta tags", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-basic",
    );
    expect(html).toMatch(/meta\s+name="author"\s+content="huozhi"/);
    expect(html).toMatch(/meta\s+name="author"\s+content="tree"/);
  });

  it("should render creator meta tag", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-basic",
    );
    expect(html).toMatch(/meta\s+name="creator"\s+content="shu"/);
  });

  it("should render publisher meta tag", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-basic",
    );
    expect(html).toMatch(/meta\s+name="publisher"\s+content="vercel"/);
  });

  it("should render robots meta tag", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-basic",
    );
    expect(html).toMatch(/meta\s+name="robots"\s+content="index, follow"/);
  });

  it("should render format-detection meta tag", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-basic",
    );
    expect(html).toMatch(/meta\s+name="format-detection"/);
    expect(html).toMatch(/telephone=no/);
  });

  // ── OpenGraph ────────────────────────────────────────────────
  // Next.js: 'should support opengraph tags'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L175-L211

  it("should render og:title", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-opengraph",
    );
    expect(html).toMatch(/meta\s+property="og:title"\s+content="My custom title"/);
  });

  it("should render og:description", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-opengraph",
    );
    expect(html).toMatch(
      /meta\s+property="og:description"\s+content="My custom description"/,
    );
  });

  it("should render og:url", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-opengraph",
    );
    expect(html).toMatch(
      /meta\s+property="og:url"\s+content="https:\/\/example\.com"/,
    );
  });

  it("should render og:site_name", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-opengraph",
    );
    expect(html).toMatch(
      /meta\s+property="og:site_name"\s+content="My custom site name"/,
    );
  });

  it("should render og:type", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-opengraph",
    );
    expect(html).toMatch(/meta\s+property="og:type"\s+content="website"/);
  });

  it("should render og:image", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-opengraph",
    );
    expect(html).toMatch(
      /meta\s+property="og:image"\s+content="https:\/\/example\.com\/image\.png"/,
    );
  });

  it("should render og:image:width and og:image:height", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-opengraph",
    );
    expect(html).toMatch(/meta\s+property="og:image:width"\s+content="800"/);
    expect(html).toMatch(/meta\s+property="og:image:height"\s+content="600"/);
  });

  // ── Twitter ──────────────────────────────────────────────────
  // Next.js: 'should support twitter card summary_large_image'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L308-L323

  it("should render twitter:card", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-twitter",
    );
    expect(html).toMatch(
      /meta\s+name="twitter:card"\s+content="summary_large_image"/,
    );
  });

  it("should render twitter:title", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-twitter",
    );
    expect(html).toMatch(/meta\s+name="twitter:title"\s+content="Twitter Title"/);
  });

  it("should render twitter:description", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-twitter",
    );
    expect(html).toMatch(
      /meta\s+name="twitter:description"\s+content="Twitter Description"/,
    );
  });

  it("should render twitter:image", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-twitter",
    );
    expect(html).toMatch(
      /meta\s+name="twitter:image"\s+content="https:\/\/twitter\.com\/image\.png"/,
    );
  });

  // ── Robots (complex) ────────────────────────────────────────
  // Next.js: 'should support robots tags'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L113-L121

  it("should render complex robots meta tag", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-robots",
    );
    expect(html).toMatch(/meta\s+name="robots"/);
    // Should contain noindex and follow
    expect(html).toMatch(/noindex/);
    expect(html).toMatch(/follow/);
  });

  it("should render googlebot meta tag", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-robots",
    );
    expect(html).toMatch(/meta\s+name="googlebot"/);
  });

  // ── Alternates ───────────────────────────────────────────────
  // Next.js: 'should support alternate tags'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L129-L152

  it("should render canonical link", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-alternates",
    );
    expect(html).toMatch(
      /link\s+rel="canonical"\s+href="https:\/\/example\.com\/alternates"/,
    );
  });

  it("should render hreflang alternate links", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-alternates",
    );
    // React JSX renders as hrefLang (camelCase) in HTML output
    expect(html).toMatch(/hrefLang="en-US"/i);
    expect(html).toMatch(/hrefLang="de-DE"/i);
  });

  // ── generateMetadata with dynamic params ─────────────────────
  // Next.js: 'should support generateMetadata dynamic props'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L174-L184

  it("should render title from generateMetadata with params", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-generate/my-slug",
    );
    expect(html).toContain("<title>params - my-slug</title>");
  });

  it("should render description from generateMetadata with params", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-generate/test-page",
    );
    expect(html).toMatch(
      /meta\s+name="description"\s+content="Description for test-page"/,
    );
  });

  // ── Default charset and viewport injection ────────────────────
  // Next.js always injects <meta charset="utf-8"> and
  // <meta name="viewport" content="width=device-width, initial-scale=1">
  // on every page, even when no metadata or viewport is exported.

  it("should always include charset meta tag in SSR output", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-title",
    );
    expect(html).toMatch(/meta\s+charSet="utf-8"|meta\s+charset="utf-8"/i);
  });

  it("should always include viewport meta tag in SSR output", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-title",
    );
    expect(html).toMatch(/meta\s+name="viewport"\s+content="width=device-width, initial-scale=1"/);
  });

  it("should include charset and viewport even on pages with only OG metadata", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-opengraph",
    );
    expect(html).toMatch(/meta\s+charSet="utf-8"|meta\s+charset="utf-8"/i);
    expect(html).toMatch(/meta\s+name="viewport"/);
  });

  // ── Browser-only tests (documented, not ported) ──────────────
  //
  // N/A: 'should apply metadata when navigating client-side'
  //   Requires Playwright — tests title updates on client-side navigation
  //
  // N/A: 'should support title template' (browser eval)
  //   Some template tests use browser.eval('document.title') — ported above at SSR level
  //
  // N/A: 'should support apple related tags itunes and appWebApp'
  //   Would need dedicated fixture page
  //
  // N/A: 'should support socials related tags'
  //   Would need dedicated fixture page (fb:app_id, pinterest)
  //
  // N/A: 'should support verification tags'
  //   Would need dedicated fixture page
  //
  // N/A: 'should support appLinks tags'
  //   Would need dedicated fixture page
  //
  // N/A: 'should support icons field' (basic, string, descriptor)
  //   Would need dedicated fixture pages — partially covered by existing vinext tests
  //
  // N/A: 'should pick up opengraph-image and twitter-image as static metadata files'
  //   Tests file-based metadata images — different feature
  //
  // N/A: 'should support twitter player/app cards'
  //   Would need dedicated fixture pages
  //
  // N/A: Static routes (favicon.ico, robots.txt, sitemap.xml)
  //   Tests file serving, not metadata export — separate feature
  //
  // N/A: 'metadataBase' URL resolution tests
  //   Would need dedicated fixture pages
  //
  // N/A: HMR/hot reload tests
  //   Tests dev server file watching
  //
  // N/A: Cache deduping tests
  //   Tests React.cache() with metadata — Playwright required
  //
  // N/A: Viewport tests
  //   Partially covered by existing vinext tests (tests/app-router.test.ts)
});
