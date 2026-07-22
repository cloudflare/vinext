/**
 * Next.js compat: Pages Router `context.revalidateReason`
 *
 * Source:
 * - https://github.com/vercel/next.js/blob/canary/test/e2e/revalidate-reason/revalidate-reason.test.ts
 *
 * Asserts that getStaticProps receives `context.revalidateReason: "on-demand"`
 * when the page is regenerated via `res.revalidate()` from an API route, and
 * that an unauthenticated `x-prerender-revalidate` header is rejected (it must
 * carry the process revalidate secret, not merely be present — see the security
 * note in `isr-cache.ts`).
 *
 * Tracks vinext#1462.
 */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { startFixtureServer, PAGES_FIXTURE_DIR, type TestServerResult } from "../helpers.js";

let ctx: TestServerResult;

/**
 * Read the `revalidateReason` value rendered by the `/revalidate-reason`
 * fixture. The page renders `<p id="reason">revalidate reason: {reason}</p>`;
 * React inserts a `<!-- -->` text separator before the dynamic value, e.g.
 * `<p id="reason">revalidate reason: <!-- -->on-demand</p>`. The reason itself
 * is always one of a small, fixed set of word tokens, so we extract that token
 * directly instead of stripping arbitrary HTML (which CodeQL — correctly —
 * flags as unreliable sanitization).
 */
function reasonFromHtml(html: string): string {
  const match = html.match(/<p id="reason">revalidate reason:(?:\s|<!--\s*-->)*([a-z-]*)<\/p>/);
  return match ? match[1] : "";
}

describe("Next.js compat: revalidate-reason (Pages Router)", () => {
  beforeAll(async () => {
    ctx = await startFixtureServer(PAGES_FIXTURE_DIR);
  });

  afterAll(async () => {
    await ctx.server.close();
  });

  // NOTE: these run in declaration order and share one server, so the fixture's
  // module state records consecutive development renders. The negative
  // security test runs first so a forged header being incorrectly honored is
  // observable as a flip from the ordinary "stale" reason to "on-demand".

  it("rejects a forged x-prerender-revalidate header (not the secret)", async () => {
    // SECURITY: on-demand revalidation must require the process revalidate
    // secret (the vinext analog of Next.js's `previewModeId`). A request that
    // merely *carries* the header with an attacker-chosen value must NOT be
    // treated as on-demand revalidation — otherwise any external client could
    // force synchronous regeneration of any ISR page (cache-stampede/DoS).

    // Establish the ordinary development-render baseline. Pages response
    // entries are not cached in dev, so each request reports "stale".
    const primeRes = await fetch(`${ctx.baseUrl}/revalidate-reason`);
    expect(primeRes.status).toBe(200);
    expect(reasonFromHtml(await primeRes.text())).toBe("stale");

    // Spoofed values: plain presence ("1"), empty, and a random guess. None
    // equals the secret, so each must be ignored and execute another ordinary
    // "stale" render rather than an authenticated "on-demand" render.
    for (const value of ["1", "", "not-the-secret"]) {
      const forged = await fetch(`${ctx.baseUrl}/revalidate-reason`, {
        headers: { "x-prerender-revalidate": value },
      });
      expect(forged.status).toBe(200);
      expect(reasonFromHtml(await forged.text())).toBe("stale");
    }
  });

  it("accepts the secret without persisting the on-demand dev render", async () => {
    // Trigger on-demand revalidation via res.revalidate() in the API route,
    // which attaches the real process revalidate secret to the internal
    // request — the only value the receiver authorizes.
    const revalidateRes = await fetch(`${ctx.baseUrl}/api/revalidate-reason`);
    expect(revalidateRes.status).toBe(200);
    expect(await revalidateRes.json()).toEqual({ revalidated: true });

    // Next.js does not cache Pages route responses in development. The
    // internal revalidation render observes "on-demand", but this independent
    // page request must execute GSP again and observe "stale".
    const res = await fetch(`${ctx.baseUrl}/revalidate-reason`);
    expect(res.status).toBe(200);
    expect(reasonFromHtml(await res.text())).toBe("stale");
  });
});
