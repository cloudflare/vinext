/**
 * Next.js Compatibility Tests: next/script preload behavior
 *
 * Ported from Next.js: test/e2e/app-dir/app-esm-js/index.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-esm-js/index.test.ts
 *
 * Verifies App Router SSR emits `<link rel="preload" as="script">` for every
 * `<Script>` with a `src` and `strategy="afterInteractive"` (the default) or
 * `strategy="beforeInteractive"`. This is React Float behavior driven by
 * `ReactDOM.preload()` and matches Next.js's implementation at
 * .nextjs-ref/packages/next/src/client/script.tsx:298-376.
 */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, fetchHtml, startFixtureServer } from "../helpers.js";

describe("Next.js compat: next/script preload (React Float)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("App Router emits preload <link> for afterInteractive scripts", async () => {
    const { html } = await fetchHtml(baseUrl, "/script-nonce");

    // /test1.js uses afterInteractive — should preload, no <script src=>.
    expect(html).toMatch(/<link\b[^>]*rel="preload"[^>]*href="\/test1\.js"/);
    expect(html).toMatch(/<link\b[^>]*href="\/test1\.js"[^>]*as="script"/);
    expect(html).not.toMatch(/<script\b[^>]*src="\/test1\.js"/);
  });

  it("App Router emits preload <link> AND <script> tag for beforeInteractive scripts", async () => {
    const { html } = await fetchHtml(baseUrl, "/script-nonce");

    // /test2.js uses beforeInteractive — should preload AND emit the <script> tag.
    expect(html).toMatch(/<link\b[^>]*rel="preload"[^>]*href="\/test2\.js"/);
    expect(html).toMatch(/<script\b[^>]*src="\/test2\.js"/);
  });

  it("does not emit preload for inline (no-src) scripts", async () => {
    const { html } = await fetchHtml(baseUrl, "/script-nonce");

    // id="3" is an inline beforeInteractive script with no src — no preload link.
    // The <script id="3"> tag itself still renders.
    expect(html).toMatch(/<script\b[^>]*id="3"/);
    const preloads = [...html.matchAll(/<link\b[^>]*rel="preload"[^>]*>/g)].map((m) => m[0]);
    for (const link of preloads) {
      // No preload link should have an "id" attribute matching the inline script.
      expect(link).not.toMatch(/id="3"/);
    }
  });
});
