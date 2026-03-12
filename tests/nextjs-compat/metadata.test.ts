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
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-title");
    expect(html).toContain("<title>this is the page title</title>");
  });

  it("should render description meta tag", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-title");
    expect(html).toMatch(/meta\s+name="description"\s+content="this is the layout description"/);
  });

  // ── Title template ───────────────────────────────────────────
  // Next.js: 'should support title template'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L34-L38

  it("should apply title template from layout", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-title-template");
    // Layout has template "%s | Layout", page has title "Page"
    // Result should be "Page | Layout"
    expect(html).toContain("<title>Page | Layout</title>");
  });

  // Next.js: 'should support stashed title in one layer'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L40-L44

  it("should apply title template to child page", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-title-template/child");
    // Layout template "%s | Layout", child page title "Extra Page"
    expect(html).toContain("<title>Extra Page | Layout</title>");
  });

  // ── Basic metadata tags ──────────────────────────────────────
  // Next.js: 'should support other basic tags'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L52-L89

  it("should render generator meta tag", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-basic");
    expect(html).toMatch(/meta\s+name="generator"\s+content="next\.js"/);
  });

  it("should render application-name meta tag", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-basic");
    expect(html).toMatch(/meta\s+name="application-name"\s+content="test"/);
  });

  it("should render referrer meta tag", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-basic");
    expect(html).toMatch(/meta\s+name="referrer"\s+content="origin-when-cross-origin"/);
  });

  it("should render keywords meta tag", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-basic");
    // Next.js joins keywords with "," (no space) — match that exactly
    expect(html).toMatch(/meta\s+name="keywords"\s+content="next\.js,react,javascript"/);
  });

  it("should render author meta tags", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-basic");
    expect(html).toMatch(/meta\s+name="author"\s+content="huozhi"/);
    expect(html).toMatch(/meta\s+name="author"\s+content="tree"/);
  });

  it("should render creator meta tag", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-basic");
    expect(html).toMatch(/meta\s+name="creator"\s+content="shu"/);
  });

  it("should render publisher meta tag", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-basic");
    expect(html).toMatch(/meta\s+name="publisher"\s+content="vercel"/);
  });

  it("should render robots meta tag", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-basic");
    expect(html).toMatch(/meta\s+name="robots"\s+content="index, follow"/);
  });

  it("should render format-detection meta tag", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-basic");
    expect(html).toMatch(/meta\s+name="format-detection"/);
    expect(html).toMatch(/telephone=no/);
  });

  // ── OpenGraph ────────────────────────────────────────────────
  // Next.js: 'should support opengraph tags'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L175-L211

  it("should render og:title", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-opengraph");
    expect(html).toMatch(/meta\s+property="og:title"\s+content="My custom title"/);
  });

  it("should render og:description", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-opengraph");
    expect(html).toMatch(/meta\s+property="og:description"\s+content="My custom description"/);
  });

  it("should render og:url", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-opengraph");
    expect(html).toMatch(/meta\s+property="og:url"\s+content="https:\/\/example\.com"/);
  });

  it("should render og:site_name", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-opengraph");
    expect(html).toMatch(/meta\s+property="og:site_name"\s+content="My custom site name"/);
  });

  it("should render og:type", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-opengraph");
    expect(html).toMatch(/meta\s+property="og:type"\s+content="website"/);
  });

  it("should render og:image", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-opengraph");
    expect(html).toMatch(
      /meta\s+property="og:image"\s+content="https:\/\/example\.com\/image\.png"/,
    );
  });

  it("should render og:image:width and og:image:height", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-opengraph");
    expect(html).toMatch(/meta\s+property="og:image:width"\s+content="800"/);
    expect(html).toMatch(/meta\s+property="og:image:height"\s+content="600"/);
  });

  // ── OpenGraph single image object ────────────────────────────
  // Next.js allows openGraph.images to be a single object (not wrapped in an array).
  // See: https://nextjs.org/docs/app/api-reference/functions/generate-metadata#opengraph

  it("should render og:image when images is a single object", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-opengraph-single-image");
    expect(html).toMatch(
      /meta\s+property="og:image"\s+content="https:\/\/example\.com\/single\.png"/,
    );
  });

  it("should render og:image dimensions for single image object", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-opengraph-single-image");
    expect(html).toMatch(/meta\s+property="og:image:width"\s+content="1200"/);
    expect(html).toMatch(/meta\s+property="og:image:height"\s+content="630"/);
  });

  it("should render twitter:image when images is a single object", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-opengraph-single-image");
    expect(html).toMatch(
      /meta\s+name="twitter:image"\s+content="https:\/\/example\.com\/twitter-single\.png"/,
    );
  });

  // ── Twitter ──────────────────────────────────────────────────
  // Next.js: 'should support twitter card summary_large_image'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L308-L323

  it("should render twitter:card", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-twitter");
    expect(html).toMatch(/meta\s+name="twitter:card"\s+content="summary_large_image"/);
  });

  it("should render twitter:title", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-twitter");
    expect(html).toMatch(/meta\s+name="twitter:title"\s+content="Twitter Title"/);
  });

  it("should render twitter:description", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-twitter");
    expect(html).toMatch(/meta\s+name="twitter:description"\s+content="Twitter Description"/);
  });

  it("should render twitter:image", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-twitter");
    expect(html).toMatch(
      /meta\s+name="twitter:image"\s+content="https:\/\/twitter\.com\/image\.png"/,
    );
  });

  // ── Robots (complex) ────────────────────────────────────────
  // Next.js: 'should support robots tags'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L113-L121

  it("should render complex robots meta tag", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-robots");
    expect(html).toMatch(/meta\s+name="robots"/);
    // Should contain noindex and follow
    expect(html).toMatch(/noindex/);
    expect(html).toMatch(/follow/);
  });

  it("should render googlebot meta tag", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-robots");
    expect(html).toMatch(/meta\s+name="googlebot"/);
  });

  // ── Alternates ───────────────────────────────────────────────
  // Next.js: 'should support alternate tags'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L129-L152

  it("should render canonical link", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-alternates");
    expect(html).toMatch(/link\s+rel="canonical"\s+href="https:\/\/example\.com\/alternates"/);
  });

  it("should render hreflang alternate links", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-alternates");
    // React JSX renders as hrefLang (camelCase) in HTML output
    expect(html).toMatch(/hrefLang="en-US"/i);
    expect(html).toMatch(/hrefLang="de-DE"/i);
  });

  // ── generateMetadata with dynamic params ─────────────────────
  // Next.js: 'should support generateMetadata dynamic props'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts#L174-L184

  it("should render title from generateMetadata with params", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-generate/my-slug");
    expect(html).toContain("<title>params - my-slug</title>");
  });

  it("should render description from generateMetadata with params", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-generate/test-page");
    expect(html).toMatch(/meta\s+name="description"\s+content="Description for test-page"/);
  });

  // ── Default charset and viewport injection ────────────────────
  // Next.js always injects <meta charset="utf-8"> and
  // <meta name="viewport" content="width=device-width, initial-scale=1">
  // on every page, even when no metadata or viewport is exported.

  it("should always include charset meta tag in SSR output", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-title");
    expect(html).toMatch(/meta\s+charSet="utf-8"|meta\s+charset="utf-8"/i);
  });

  it("should always include viewport meta tag in SSR output", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-title");
    expect(html).toMatch(/meta\s+name="viewport"\s+content="width=device-width, initial-scale=1"/);
  });

  it("should include charset and viewport even on pages with only OG metadata", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-opengraph");
    expect(html).toMatch(/meta\s+charSet="utf-8"|meta\s+charset="utf-8"/i);
    expect(html).toMatch(/meta\s+name="viewport"/);
  });

  // ── generateMetadata with parent parameter ────────────────────
  // Regression test for: https://github.com/cloudflare/vinext/issues/375
  //
  // Next.js passes a `parent` Promise<ResolvedMetadata> as the second argument
  // to generateMetadata(). This allows child segments to extend ancestor metadata
  // (e.g. prepend/append OG images from a parent layout) rather than replace it.
  //
  // Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/app/dynamic/%5Bslug%5D/page.tsx
  //   "should support generateMetadata with parent parameter"

  it("should pass parent metadata to generateMetadata via parent parameter", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-parent-generate");
    // The layout's generateMetadata() returns openGraph.images: ['/base-image.jpg'].
    // The page's generateMetadata() prepends '/new-image.jpg' to the parent images.
    // Both images must appear in the HTML.
    expect(html).toMatch(/og:image.*new-image\.jpg/);
    expect(html).toMatch(/og:image.*base-image\.jpg/);
  });

  it("should render page title from generateMetadata that uses parent", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-parent-generate");
    expect(html).toContain("<title>parent-generate page</title>");
  });

  it("parent parameter should not be undefined (await parent must not throw)", async () => {
    // If parent is undefined, `await parent` throws a TypeError at runtime.
    // A successful 200 response means parent was a valid thenable.
    const res = await fetch(`${baseUrl}/nextjs-compat/metadata-parent-generate`);
    expect(res.status).toBe(200);
  });

  // ── generateMetadata with searchParams ───────────────────────
  // Regression test: searchParams was not forwarded to the page's generateMetadata()
  // call (undefined was always passed). Verify that query-string values are
  // accessible inside generateMetadata via the searchParams argument.

  it("should pass searchParams to page generateMetadata()", async () => {
    const { html } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/metadata-generate-searchparams?q=hello",
    );
    expect(html).toContain("<title>search: hello</title>");
  });

  it("generateMetadata searchParams defaults to empty when no query string", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-generate-searchparams");
    expect(html).toContain("<title>search: (none)</title>");
  });

  // ── iTunes meta tag ──────────────
  // Ported from Next.js: test/e2e/app-dir/metadata/metadata.test.ts
  // 'should support apple related tags itunes and appWebApp'

  it("should render apple-itunes-app meta tag", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-itunes");
    expect(html).toContain(
      '<meta name="apple-itunes-app" content="app-id=123456789, app-argument=myapp://content/123"/>',
    );
  });

  // ── App Links ──────────────
  // Ported from Next.js: test/e2e/app-dir/metadata/metadata.test.ts
  // 'should support appLinks tags'

  it("should render appLinks meta tags", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-applinks");
    expect(html).toContain('property="al:ios:url" content="https://example.com/ios"');
    expect(html).toContain('property="al:ios:app_store_id" content="123456789"');
    expect(html).toContain('property="al:ios:app_name" content="My iOS App"');
    expect(html).toContain('property="al:android:package" content="com.example.app"');
    expect(html).toContain('property="al:android:url" content="https://example.com/android"');
    expect(html).toContain('property="al:android:app_name" content="My Android App"');
    expect(html).toContain('property="al:web:url" content="https://example.com"');
    expect(html).toContain('property="al:web:should_fallback" content="true"');
  });

  // ── Twitter player cards ──────────────
  // Ported from Next.js: test/e2e/app-dir/metadata/metadata.test.ts
  // 'should support twitter player/app cards'

  it("should render twitter player card meta tags", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-twitter-player");
    expect(html).toContain('name="twitter:card" content="player"');
    expect(html).toContain('name="twitter:player" content="https://example.com/player"');
    expect(html).toContain('name="twitter:player:stream" content="https://example.com/stream"');
    expect(html).toContain('name="twitter:player:width" content="480"');
    expect(html).toContain('name="twitter:player:height" content="360"');
  });

  // ── Twitter app cards ──────────────

  it("should render twitter app card meta tags", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/metadata-twitter-app");
    expect(html).toContain('name="twitter:card" content="app"');
    expect(html).toContain('name="twitter:app:name:iphone" content="My App"');
    expect(html).toContain('name="twitter:app:id:iphone" content="id123456789"');
    expect(html).toContain('name="twitter:app:url:iphone" content="https://example.com/iphone"');
    expect(html).toContain('name="twitter:app:name:ipad" content="My App"');
    expect(html).toContain('name="twitter:app:id:ipad" content="id123456789"');
    expect(html).toContain('name="twitter:app:url:ipad" content="https://example.com/ipad"');
    expect(html).toContain('name="twitter:app:name:googleplay" content="My App"');
    expect(html).toContain('name="twitter:app:id:googleplay" content="com.example.app"');
    expect(html).toContain(
      'name="twitter:app:url:googleplay" content="https://example.com/android"',
    );
  });

  // ── Browser-only tests (documented, not ported) ──────────────
  //
  // N/A: 'should apply metadata when navigating client-side'
  //   Requires Playwright — tests title updates on client-side navigation
  //
  // N/A: 'should support title template' (browser eval)
  //   Some template tests use browser.eval('document.title') — ported above at SSR level
  //
  // N/A: 'should support socials related tags'
  //   Would need dedicated fixture page (fb:app_id, pinterest)
  //
  // N/A: 'should support verification tags'
  //   Would need dedicated fixture page
  //
  // N/A: 'should support icons field' (basic, string, descriptor)
  //   Would need dedicated fixture pages — partially covered by existing vinext tests
  //
  // N/A: 'should pick up opengraph-image and twitter-image as static metadata files'
  //   Tests file-based metadata images — different feature
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
