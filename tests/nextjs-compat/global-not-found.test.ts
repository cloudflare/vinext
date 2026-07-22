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
const NOT_PRESENT_FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "../fixtures/global-not-found-not-present",
);

/**
 * Extract the href of every `<link rel="stylesheet">` tag in the SSR markup,
 * preserving document order. CSS cascade is order-sensitive — for the
 * initial-css-order regression we need to assert which stylesheet is emitted
 * (and which is NOT) for route-miss 404s.
 */
function extractCssLinks(html: string): string[] {
  const hrefs: string[] = [];
  // The link tag emitted by React Float / @vitejs/plugin-rsc uses
  // `rel="stylesheet"`. We only care about visible stylesheets, so skip
  // preload/preconnect/etc.
  const linkRe = /<link\b[^>]*\brel="stylesheet"[^>]*>/gi;
  for (const m of html.matchAll(linkRe)) {
    const hrefMatch = /\bhref="([^"]+)"/i.exec(m[0]);
    if (hrefMatch) hrefs.push(hrefMatch[1]);
  }
  return hrefs;
}

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

  // Ported from Next.js: test/e2e/app-dir/initial-css-order/initial-css-order.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/initial-css-order/initial-css-order.test.ts
  //
  // global-not-found.tsx replaces the root layout for route-miss 404s, so the
  // response must serve ONLY global-not-found's CSS — not the layout's. If
  // both stylesheets render on the 404 page the CSS cascade ends with the
  // layout's rules (e.g., layout's green.css overrides global-not-found's
  // red.css) and the document paints the wrong colours.
  //
  // The vinext fixture mirrors Next.js: layout.tsx imports red.css then
  // green.css (so green wins on matched routes), and global-not-found.tsx
  // imports red.css (so red wins on route-miss 404s).
  // See: https://github.com/cloudflare/vinext/issues/1549
  it("only emits global-not-found's CSS link on route-miss 404 (not the layout's)", async () => {
    const homeResp = await fetchHtml(baseUrl, "/");
    expect(homeResp.res.status).toBe(200);
    // Matched routes load the layout's CSS chain. Matching upstream Next.js,
    // both red.css and green.css are linked in import order so green wins.
    const homeLinks = extractCssLinks(homeResp.html);
    expect(homeLinks).toEqual([
      expect.stringMatching(/red\.css/),
      expect.stringMatching(/green\.css/),
    ]);

    const nfResp = await fetchHtml(baseUrl, "/does-not-exist");
    expect(nfResp.res.status).toBe(404);
    // The 404 response must NOT carry the root layout's CSS — the layout was
    // skipped (skipLayoutWrapping) so its CSS imports must not appear in the
    // SSR markup. Only global-not-found's red.css should be linked.
    const nfLinks = extractCssLinks(nfResp.html);
    expect(nfLinks).toEqual([expect.stringMatching(/red\.css/)]);
    expect(nfLinks.some((href) => /green\.css/.test(href))).toBe(false);
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

describe("Next.js compat: global-not-found (not present)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(NOT_PRESENT_FIXTURE_DIR, {
      appRouter: true,
    }));
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // Ported from Next.js: test/e2e/app-dir/global-not-found/not-present/not-present.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/global-not-found/not-present/not-present.test.ts
  it("renders the default 404 for a route miss when global-not-found is absent", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/does-not-exist");
    expect(res.status).toBe(404);
    expect(html).toContain("404");
    expect(html).toContain("This page could not be found.");
    expect(html).not.toContain("not-found.js");
    expect(html).not.toContain('lang="en"');
    expect((html.match(/<html/gi) ?? []).length).toBe(1);
    expect((html.match(/<body/gi) ?? []).length).toBe(1);
  });

  it("keeps the root not-found boundary for explicit notFound()", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/call-not-found");
    expect(res.status).toBe(404);
    expect(html).toContain('lang="en"');
    expect(html).toContain("not-found.js");
  });
});
