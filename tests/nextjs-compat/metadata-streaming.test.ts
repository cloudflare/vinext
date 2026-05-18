/**
 * Next.js compat: metadata-streaming
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
 *
 * Next.js 15+ streams non-blocking metadata into <body> after the initial
 * flush, then hoists it to <head> client-side. When a route has
 * generateMetadata() (or any async metadata resolution), the resolved <title>
 * / <meta> / <link> tags should NOT appear inside <head> in the initial HTML
 * response — they should appear inside <body> instead, so the page shell can
 * flush early without waiting for slow metadata.
 *
 * Bots that don't run client JS still need the metadata in <head>. For known
 * HTML-only bots (e.g. Twitterbot), the server falls back to blocking the
 * shell on metadata resolution and writing the tags into <head>.
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import {
  startFixtureServer,
  APP_FIXTURE_DIR,
  fetchHtml,
  type TestServerResult,
} from "../helpers.js";

let ctx: TestServerResult;

/**
 * Split an HTML response at `</head>` so callers can independently assert on
 * the head and body slices. Hard-fails (rather than returning -1) when the
 * boundary is missing so a malformed response surfaces as a clear test
 * failure instead of misleading "expected contains" diffs.
 */
function splitAtHeadClose(html: string): { headSlice: string; bodySlice: string } {
  expect(html).toContain("</head>");
  const boundary = html.indexOf("</head>");
  return {
    headSlice: html.slice(0, boundary),
    bodySlice: html.slice(boundary),
  };
}

// All "should-be-streamed" assertions are currently `it.todo` because vinext
// does not yet stream dynamic metadata to <body>. Tracking PR: see metadata
// streaming follow-up. The bot/HTML-only assertions are live since the
// blocking path already produces correct HTML.
describe("Next.js compat: metadata-streaming", () => {
  beforeAll(async () => {
    ctx = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true });
  });

  afterAll(async () => {
    await ctx.server.close();
  });

  // Equivalent of:
  //   "should delay the metadata render to body"
  it.todo("should delay metadata render to body for pages with generateMetadata", async () => {
    const { html } = await fetchHtml(ctx.baseUrl, "/nextjs-compat/metadata-streaming-test");
    const { headSlice, bodySlice } = splitAtHeadClose(html);
    // The streamed metadata must NOT be in <head>.
    expect(headSlice).not.toContain("<title>metadata streaming index page</title>");
    // It must appear somewhere in the document body.
    expect(bodySlice).toContain("<title>metadata streaming index page</title>");
  });

  // Equivalent of:
  //   "should still load viewport meta tags even if metadata is delayed"
  it("should still emit viewport meta tags in <head> while metadata is streaming", async () => {
    const { html } = await fetchHtml(ctx.baseUrl, "/nextjs-compat/metadata-streaming-test/slow");
    const { headSlice } = splitAtHeadClose(html);
    expect(headSlice).toMatch(/<meta[^>]+name="viewport"[^>]+content="[^"]*width=device-width/);
    expect(headSlice).toMatch(/<meta[^>]*charSet="utf-8"|<meta[^>]*charset="utf-8"/i);
  });

  // Equivalent of:
  //   "should determine dynamic metadata in build and render in the body"
  it.todo("should stream metadata to body even when most of the page is static", async () => {
    const { html } = await fetchHtml(
      ctx.baseUrl,
      "/nextjs-compat/metadata-streaming-test/static-partial",
    );
    const { headSlice, bodySlice } = splitAtHeadClose(html);
    expect(headSlice).not.toContain("<title>partial static page</title>");
    expect(bodySlice).toContain("<title>partial static page</title>");
  });

  // Equivalent of:
  //   "should still render dynamic metadata in the head for html bots"
  it("should render dynamic metadata in <head> for html-only bots (Twitterbot)", async () => {
    const res = await fetch(`${ctx.baseUrl}/nextjs-compat/metadata-streaming-test/static-partial`, {
      headers: { "user-agent": "Twitterbot/1.0" },
    });
    const html = await res.text();
    const { headSlice } = splitAtHeadClose(html);
    expect(headSlice).toContain("<title>partial static page</title>");
  });

  // Equivalent of:
  //   "should send the blocking response for html limited bots"
  it("should block on metadata for html-only bots on index", async () => {
    const res = await fetch(`${ctx.baseUrl}/nextjs-compat/metadata-streaming-test`, {
      headers: { "user-agent": "Twitterbot/1.0" },
    });
    const html = await res.text();
    const { headSlice } = splitAtHeadClose(html);
    expect(headSlice).toContain("<title>metadata streaming index page</title>");
  });
});
