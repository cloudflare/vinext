/**
 * Regression test asserting that Pages Router routes are served by the
 * Cloudflare Worker (miniflare) when @cloudflare/vite-plugin is present,
 * not intercepted by the host connect handler.
 *
 * ## The bug
 *
 * The connect handler in index.ts handled Pages Router rendering directly in
 * the host Node.js process via getPagesRunner() + createSSRHandler(). When
 * @cloudflare/vite-plugin is present the correct path is for ALL rendering —
 * including Pages Router — to go through the Cloudflare plugin's Worker entry,
 * where virtual:vinext-server-entry → renderPage / handleApiRoute run inside
 * miniflare with the full Workers runtime.
 *
 * ## The fix
 *
 * When hasCloudflarePlugin is true, the connect handler calls next() after
 * running middleware, delegating every request to the Cloudflare plugin.
 *
 * ## How we assert "served by the Worker"
 *
 * The app-router-cloudflare example exposes a dedicated Pages route at
 * /pages-index. If the host connect handler intercepted the request, it would
 * render in Node instead of passing through the Cloudflare Worker entry.
 *
 * Note: Pages Router API routes on Cloudflare Workers are covered by the
 * cloudflare-pages-router e2e suite (wrangler dev, not vite dev), which
 * already asserts { runtime: "Cloudflare-Workers" } on every API response.
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4178";

test.describe("Pages Router routes on Cloudflare Workers (vite dev)", () => {
  test("Pages route is served by the Worker, not intercepted by the connect handler", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/pages-index`);
    expect(res.status()).toBe(200);

    const body = await res.text();
    expect(body).toContain("pages index");
  });
});
