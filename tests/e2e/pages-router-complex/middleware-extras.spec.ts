import { test, expect } from "@playwright/test";

/**
 * The non-routing middleware branches: raw /_next/data interception, the CDN
 * asset-prefix rewrite, and the hard 403 on the built-in image endpoint.
 */
test.describe("middleware extras", () => {
  test.fixme("answers raw /_next/data requests with a hardNavTo payload", async ({ request }) => {
    const response = await request.get("/_next/data/whatever/journal.json?x=1", {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    // The instruction points at the *page* URL, not the data URL.
    expect(body.hardNavTo).toBe("/journal?x=1");
  });

  test("rewrites CDN-prefixed asset URLs onto /_next", async ({ request }) => {
    // The rewrite itself must engage; the missing asset then 404s (rather
    // than the path falling through to the page router and rendering HTML).
    const response = await request.get("/atlas/cdn/_next/static/not-a-real-asset.js", {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(404);
  });

  test.fixme("blocks the built-in image endpoint with a 403", async ({ request }) => {
    const response = await request.get("/_next/image?url=%2Ffoo.png&w=640&q=75", {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("image endpoint is disabled");
  });
});
