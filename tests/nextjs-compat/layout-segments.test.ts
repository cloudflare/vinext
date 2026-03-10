/**
 * Next.js Compatibility Tests: useSelectedLayoutSegment(s) with route groups
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/hooks/hooks.test.ts
 *
 * Tests that useSelectedLayoutSegment and useSelectedLayoutSegments return
 * correct values when route groups are present in the tree. Route groups like
 * (group) don't appear in URLs but DO appear in the returned segments array.
 *
 * Fixture structure:
 *   app/nextjs-compat/hooks-segments/
 *     layout.tsx                                          ← outer layout
 *     first/
 *       layout.tsx                                        ← inner layout
 *       page.tsx                                          ← simple leaf
 *       [dynamic]/
 *         page.tsx                                        ← dynamic leaf
 *         (group)/second/[...catchall]/page.tsx            ← nested with route group
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ViteDevServer } from "vite";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

// React SSR HTML-encodes " as &quot; in text content.
const Q = "&quot;";

describe("Next.js compat: useSelectedLayoutSegment(s)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up
    await fetchHtml(baseUrl, "/nextjs-compat/hooks-segments/first");
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // ── useSelectedLayoutSegments ─────────────────────────────────
  // Ported from Next.js: test/e2e/app-dir/hooks/hooks.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/hooks/hooks.test.ts

  describe("useSelectedLayoutSegments", () => {
    it("returns correct segments for simple path (outer layout)", async () => {
      const { html } = await fetchHtml(baseUrl, "/nextjs-compat/hooks-segments/first");
      expect(html).toContain(`<p id="outer-layout">[${Q}first${Q}]</p>`);
    });

    it("returns empty segments for simple path (inner layout)", async () => {
      const { html } = await fetchHtml(baseUrl, "/nextjs-compat/hooks-segments/first");
      expect(html).toContain('<p id="inner-layout">[]</p>');
    });

    it("includes route group in segments (outer layout)", async () => {
      const { html } = await fetchHtml(
        baseUrl,
        "/nextjs-compat/hooks-segments/first/slug2/second/a/b",
      );
      // Route group "(group)" should appear in segments even though it's not in the URL.
      // Catch-all segments are joined with "/" (e.g., "a/b" not "a","b").
      expect(html).toContain(
        `<p id="outer-layout">[${Q}first${Q},${Q}slug2${Q},${Q}(group)${Q},${Q}second${Q},${Q}a/b${Q}]</p>`,
      );
    });

    it("includes route group in segments (inner layout)", async () => {
      const { html } = await fetchHtml(
        baseUrl,
        "/nextjs-compat/hooks-segments/first/slug2/second/a/b",
      );
      expect(html).toContain(
        `<p id="inner-layout">[${Q}slug2${Q},${Q}(group)${Q},${Q}second${Q},${Q}a/b${Q}]</p>`,
      );
    });

    it("returns empty array in leaf page", async () => {
      const { html } = await fetchHtml(
        baseUrl,
        "/nextjs-compat/hooks-segments/first/slug2/second/a/b",
      );
      expect(html).toContain('<p id="page-layout-segments">[]</p>');
    });

    it("returns dynamic param segments (inner layout)", async () => {
      const { html } = await fetchHtml(baseUrl, "/nextjs-compat/hooks-segments/first/slug1");
      expect(html).toContain(`<p id="inner-layout">[${Q}slug1${Q}]</p>`);
    });
  });

  // ── useSelectedLayoutSegment ──────────────────────────────────
  // Ported from Next.js: test/e2e/app-dir/hooks/hooks.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/hooks/hooks.test.ts

  describe("useSelectedLayoutSegment", () => {
    it("returns first child segment (outer layout, simple path)", async () => {
      const { html } = await fetchHtml(baseUrl, "/nextjs-compat/hooks-segments/first");
      expect(html).toContain(`<p id="outer-layout-segment">${Q}first${Q}</p>`);
    });

    it("returns null when at leaf (inner layout, simple path)", async () => {
      const { html } = await fetchHtml(baseUrl, "/nextjs-compat/hooks-segments/first");
      expect(html).toContain('<p id="inner-layout-segment">null</p>');
    });

    it("returns first child segment with route groups (outer layout)", async () => {
      const { html } = await fetchHtml(
        baseUrl,
        "/nextjs-compat/hooks-segments/first/slug2/second/a/b",
      );
      expect(html).toContain(`<p id="outer-layout-segment">${Q}first${Q}</p>`);
    });

    it("returns null in leaf page", async () => {
      const { html } = await fetchHtml(
        baseUrl,
        "/nextjs-compat/hooks-segments/first/slug2/second/a/b",
      );
      expect(html).toContain('<p id="page-layout-segment">null</p>');
    });
  });
});
