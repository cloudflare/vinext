/**
 * E2E tests for instrumentation.ts startup.
 *
 * This spec runs under two Playwright projects:
 *
 *   - cloudflare-pages-router-dev  (vite dev + @cloudflare/vite-plugin)
 *   - cloudflare-pages-router      (vite build + wrangler dev)
 *
 * ## Dev path (cloudflare-pages-router-dev)
 *
 * runInstrumentation() is called from configureServer() in the host Node.js
 * process. Before the fix it used server.ssrLoadModule() which crashed with:
 *
 *   TypeError: Cannot read properties of undefined (reading 'outsideEmitter')
 *
 * because @cloudflare/vite-plugin replaces the SSR environment's hot channel.
 * The fix uses createDirectRunner() / runner.import() which calls
 * environment.fetchModule() directly and never touches the hot channel.
 *
 * If the crash is present the dev server exits on startup and Playwright's
 * webServer setup fails — the assertion below is never reached.
 *
 * ## Prod path (cloudflare-pages-router)
 *
 * register() is baked into the generated virtual:vinext-server-entry as a
 * top-level await, so it runs inside the Worker bundle at module evaluation
 * time — before any request is handled. configureServer() is never called
 * during a prod build, so there is no double-invocation risk.
 */

import { test, expect } from "@playwright/test";

test.describe("instrumentation.ts startup (Pages Router)", () => {
  test("dev server starts without crashing when instrumentation.ts is present", async ({
    request,
  }) => {
    // Reaching this line means the server started successfully and can serve
    // requests. If the outsideEmitter crash is present, Playwright's webServer
    // setup fails before any test runs — this assertion is never reached.
    const res = await request.get("/api/instrumentation-test");
    expect(res.status()).toBe(200);

    const data = await res.json();
    // register() must have been invoked once when the dev server started.
    expect(data.registerCalled).toBe(true);
    expect(Array.isArray(data.errors)).toBe(true);
  });
});
