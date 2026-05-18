/**
 * Next.js Compatibility Tests: global-not-found (basic)
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-not-found/basic/global-not-found-basic.test.ts
 *
 * `app/global-not-found.tsx` is a Next.js 16 feature (originally behind
 * `experimental.globalNotFound`). When present at the app root:
 *
 *   - Route-miss 404s (no matched route) render this module standalone.
 *     The module provides its own `<html>` and `<body>`, replacing the root
 *     layout — see `createNotFoundLoaderTree` in Next.js:
 *     https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/app-render.tsx#L495-L520
 *
 *   - Page-triggered `notFound()` calls still render the regular `not-found.tsx`
 *     boundary inside the root layout (or the framework default if absent).
 *
 * Fixture: `tests/fixtures/global-not-found-basic/` — minimal app with a root
 * layout, a homepage, a `/call-not-found` page, and `global-not-found.tsx`.
 */

import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { startFixtureServer, fetchHtml } from "../helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../fixtures/global-not-found-basic");

describe("Next.js compat: global-not-found (basic)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR, { appRouter: true }));
    // Warm up
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("renders the homepage with the normal root layout", async () => {
    // Sanity check — the root layout should still wrap matched routes.
    const { res, html } = await fetchHtml(baseUrl, "/");
    expect(res.status).toBe(200);
    expect(html).toContain('lang="en"');
    expect(html).toContain("hello world");
    expect(html).not.toContain('data-global-not-found="true"');
  });

  // Ported from Next.js: test/e2e/app-dir/global-not-found/basic/global-not-found-basic.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-not-found/basic/global-not-found-basic.test.ts
  it("renders global-not-found for route-miss 404 (no root layout)", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/does-not-exist");
    expect(res.status).toBe(404);
    // global-not-found.tsx ships its own <html data-global-not-found="true">.
    expect(html).toContain('data-global-not-found="true"');
    expect(html).toContain('id="global-error-title"');
    expect(html).toContain("global-not-found");
    // The root layout's html tag (`lang="en"`) must NOT be present — global-
    // not-found.tsx is supposed to replace it for the 404 document.
    expect(html).not.toMatch(/<html[^>]*\blang="en"/);
  });

  it("produces exactly one <html> and one <body> for the global-not-found document", async () => {
    // Structural integrity check: when global-not-found.tsx renders standalone
    // the root layout's <html>/<body> must NOT also appear in the markup.
    const { html } = await fetchHtml(baseUrl, "/does-not-exist");
    const htmlTags = (html.match(/<html/gi) ?? []).length;
    const bodyTags = (html.match(/<body/gi) ?? []).length;
    expect(htmlTags, `expected 1 <html> tag, got ${htmlTags}`).toBe(1);
    expect(bodyTags, `expected 1 <body> tag, got ${bodyTags}`).toBe(1);
  });

  // Ported from Next.js: test/e2e/app-dir/global-not-found/basic/global-not-found-basic.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-not-found/basic/global-not-found-basic.test.ts
  it("does not use the global-not-found document when notFound() is called from a page", async () => {
    // /call-not-found is a matched page that calls notFound(). The page-call
    // path must NOT trigger the global-not-found document — that document is
    // reserved for route-miss 404s.
    //
    // NOTE: Next.js parity goes further — it renders the default `404 / This
    // page could not be found.` inside the root layout (so `<html lang="en">`
    // is present). Vinext currently returns a plain "Not Found" body for
    // page-call 404s when no `not-found.tsx` boundary is configured; that
    // pre-existing parity gap is tracked separately and is out of scope for
    // this PR. The assertion below covers only the global-not-found
    // protection that this PR introduces.
    const { res, html } = await fetchHtml(baseUrl, "/call-not-found");
    expect(res.status).toBe(404);
    // global-not-found document must NOT be used for page-call notFound().
    expect(html).not.toContain('data-global-not-found="true"');
    expect(html).not.toContain('id="global-error-title"');
  });
});
