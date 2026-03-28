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
 * The app-router-cloudflare example has two competing handlers for /:
 *   - pages/index.tsx  → "<div>pages index</div>"  (Pages Router stub)
 *   - app/page.tsx     → "vinext on Cloudflare Workers"  (App Router, Worker)
 *
 * The Worker entry dispatches via the RSC entry, which serves app/page.tsx.
 * If the connect handler intercepted the request first, pages/index.tsx would
 * be rendered — without any Cloudflare runtime.
 *
 * Note: Pages Router API routes on Cloudflare Workers are covered by the
 * cloudflare-pages-router e2e suite (wrangler dev, not vite dev), which
 * already asserts { runtime: "Cloudflare-Workers" } on every API response.
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4178";

test.describe("Pages Router routes on Cloudflare Workers (vite dev)", () => {
  test("root route is served by the Worker, not intercepted by the connect handler", async ({
    request,
  }) => {
    // pages/index.tsx and app/page.tsx both match /.
    // The Worker entry dispatches via the RSC entry, which serves app/page.tsx.
    // If the connect handler intercepts first, pages/index.tsx is rendered instead.
    const res = await request.get(`${BASE}/`);
    expect(res.status()).toBe(200);

    const body = await res.text();
    expect(body).toContain("vinext on Cloudflare Workers");
    expect(body).not.toContain("pages index");
  });
});
