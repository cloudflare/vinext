/**
 * Next.js compat: Pages Router `context.revalidateReason`
 *
 * Source:
 * - https://github.com/vercel/next.js/blob/canary/test/e2e/revalidate-reason/revalidate-reason.test.ts
 *
 * Asserts that getStaticProps receives `context.revalidateReason: "on-demand"`
 * when the page is regenerated via `res.revalidate()` from an API route.
 *
 * Tracks vinext#1462.
 */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { startFixtureServer, PAGES_FIXTURE_DIR, type TestServerResult } from "../helpers.js";

let ctx: TestServerResult;

function reasonFromHtml(html: string): string {
  // React renders dynamic text after a static prefix with a `<!-- -->` text
  // separator comment, e.g. `revalidate reason: <!-- -->on-demand`. Strip the
  // element's inner HTML of tags/comments to read the trailing reason value.
  const match = html.match(/<p id="reason">([\s\S]*?)<\/p>/);
  if (!match) return "";
  const text = match[1].replace(/<!--.*?-->/g, "").replace(/<[^>]*>/g, "");
  return text.replace(/^revalidate reason:/, "").trim();
}

describe("Next.js compat: revalidate-reason (Pages Router)", () => {
  beforeAll(async () => {
    ctx = await startFixtureServer(PAGES_FIXTURE_DIR);
  });

  afterAll(async () => {
    await ctx.server.close();
  });

  it('should support revalidateReason: "on-demand"', async () => {
    // Prime the ISR cache for the page (first hit). In dev there is no
    // build-time prerender, so the initial miss surfaces as "stale".
    const primeRes = await fetch(`${ctx.baseUrl}/revalidate-reason`);
    expect(primeRes.status).toBe(200);
    expect(reasonFromHtml(await primeRes.text())).toBe("stale");

    // Trigger on-demand revalidation via res.revalidate() in the API route.
    const revalidateRes = await fetch(`${ctx.baseUrl}/api/revalidate-reason`);
    expect(revalidateRes.status).toBe(200);
    expect(await revalidateRes.json()).toEqual({ revalidated: true });

    // The regenerated page must now record the "on-demand" reason.
    const res = await fetch(`${ctx.baseUrl}/revalidate-reason`);
    expect(res.status).toBe(200);
    expect(reasonFromHtml(await res.text())).toBe("on-demand");
  });
});
