/**
 * Regression tests for middleware.ts when @cloudflare/vite-plugin is present.
 *
 * ## The crash bug
 *
 * When @cloudflare/vite-plugin is loaded, the Pages Router connect handler
 * called runMiddleware() → server.ssrLoadModule(), which crashed with:
 *
 *   TypeError: Cannot read properties of undefined (reading 'outsideEmitter')
 *
 * The fix: use createDirectRunner() which calls environment.fetchModule()
 * directly and never touches the hot channel.
 *
 * ## The routing bug
 *
 * After the crash was papered over, a second bug remained: the connect handler
 * called createSSRHandler() for any Pages Router route match, intercepting
 * requests before they reached the Cloudflare plugin. App Router routes that
 * happened to also match a pages/ stub (e.g. /) were rendered by the host
 * connect stack instead of being dispatched to the Worker.
 *
 * The fix: when hasCloudflarePlugin is true, the connect handler exits with
 * next() immediately after running middleware, delegating all rendering to the
 * Cloudflare plugin's RSC handler inside the Worker.
 *
 * ## How we assert "running inside the Worker"
 *
 * Every route in app-router-cloudflare returns a "runtime" field containing
 * globalThis.navigator?.userAgent. Inside the Cloudflare Worker (miniflare)
 * this is "Cloudflare-Workers". If a route is intercepted and rendered by the
 * connect handler in the host instead, the field is absent or wrong.
 *
 * The root route / additionally has a content check: app/page.tsx renders
 * "vinext on Cloudflare Workers" while the pages/ stub renders "pages index".
 * If the stub text appears, the Worker was bypassed.
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4178";

test.describe("middleware.ts with @cloudflare/vite-plugin", () => {
  test("dev server handles requests without crashing when middleware.ts is present", async ({
    request,
  }) => {
    // If the outsideEmitter crash is present, the process exits on the first
    // matched request and this returns a connection error.
    const res = await request.get(`${BASE}/api/hello`);
    expect(res.status()).toBe(200);
  });

  test("subsequent requests are served normally after middleware runs", async ({
    request,
  }) => {
    const res1 = await request.get(`${BASE}/api/hello`);
    expect(res1.status()).toBe(200);

    const res2 = await request.get(`${BASE}/api/hello`);
    expect(res2.status()).toBe(200);
  });

  test("/api/hello runs inside the Cloudflare Worker", async ({ request }) => {
    // /api/hello is an App Router API route. The connect handler runs
    // middleware then calls next(), handing off to the Cloudflare plugin.
    // The route returns navigator.userAgent — "Cloudflare-Workers" inside
    // miniflare. Any other value means the route ran outside the Worker.
    const res = await request.get(`${BASE}/api/hello`);
    expect(res.status()).toBe(200);
    expect(res.headers()['x-mw-ran']).toBe('true');

    const data = await res.json() as { message: string; runtime: string };
    expect(data.runtime).toBe("Cloudflare-Workers");
  });

  test("root route runs inside the Cloudflare Worker", async ({ request }) => {
    // / is matched by both pages/index.tsx (stub) and app/page.tsx (App Router).
    // The connect handler must call next() so the Cloudflare plugin dispatches
    // the request to app/page.tsx inside the Worker.
    //
    // "vinext on Cloudflare Workers" — app/page.tsx rendered in the Worker
    // "pages index"                  — pages stub rendered by the connect handler
    const res = await request.get(`${BASE}/`);
    expect(res.status()).toBe(200);

    const body = await res.text();
    expect(body).toContain("vinext on Cloudflare Workers");
    expect(body).not.toContain("pages index");
  });
});
