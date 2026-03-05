/**
 * Regression test + functional test for instrumentation.ts when
 * @cloudflare/vite-plugin is present.
 *
 * ## The original bug (startup crash)
 *
 * When @cloudflare/vite-plugin is loaded, it registers a Vite environment
 * named "rsc". The old vinext configureServer() hook detected this and tried
 * to load instrumentation.ts via server.ssrLoadModule() — which crashed with:
 *
 *   TypeError: Cannot read properties of undefined (reading 'outsideEmitter')
 *
 * because SSRCompatModuleRunner is constructed synchronously during
 * configureServer(), before the dev server starts listening, and immediately
 * reads environment.hot.api which is undefined at that point.
 *
 * ## The real bug (wrong process)
 *
 * Even if the crash was papered over, register() was running in the host
 * Node.js process (where configureServer() runs). With @cloudflare/vite-plugin,
 * the Worker runs in a miniflare subprocess — a completely separate process
 * with its own isolated globalThis. Any state set by register() in the host
 * was invisible to the Worker where the API routes execute.
 *
 * ## The fix
 *
 * register() is now emitted as a top-level `await` inside the generated RSC
 * entry module. This means it runs inside the Cloudflare Worker — the same
 * process and module graph as the API routes. State set by register() is
 * immediately visible to any module imported from the Worker.
 *
 * configureServer() no longer calls runInstrumentation() for App Router at all.
 *
 * ## How this test reproduces both issues
 *
 * The Playwright webServer for this project is configured with
 * reuseExistingServer: false — it always starts a fresh server.
 *
 * 1. If the startup crash is present, `vite dev` exits before the server ever
 *    starts listening. Playwright cannot connect to port 4178 and every test
 *    fails with a connection error.
 *
 * 2. If register() runs in the wrong process (host instead of Worker), the
 *    API route returns { registerCalled: false } and the second assertion fails.
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4178";

test.describe("instrumentation.ts with @cloudflare/vite-plugin", () => {
  test("dev server starts without crashing when instrumentation.ts is present alongside @cloudflare/vite-plugin", async ({
    request,
  }) => {
    // If we reach this line at all, vite dev started successfully — the
    // startup crash regression is not present.
    //
    // The webServer for this project uses reuseExistingServer: false, so a
    // fresh server is started for every test run. A crash would cause
    // Playwright to fail connecting to port 4178 and this test would never
    // reach its body.
    const res = await request.get(`${BASE}/api/hello`);
    expect(res.status()).toBe(200);
  });

  test("register() runs inside the Worker and is visible to API routes", async ({
    request,
  }) => {
    // This assertion catches the wrong-process bug: if register() ran in the
    // host Node.js process instead of the Worker, the API route would return
    // { registerCalled: false } because the Worker's module graph has a
    // separate copy of instrumentation-state.ts with registerCalled = false.
    //
    // With the fix, register() is emitted as a top-level await in the RSC
    // entry, so it runs in the Worker before any request is handled. The API
    // route reads from the same module instance and sees registerCalled = true.
    const res = await request.get(`${BASE}/api/instrumentation-test`);
    expect(res.status()).toBe(200);

    const data = await res.json() as { registerCalled: boolean; errors: unknown[] };
    expect(data.registerCalled).toBe(true);
  });

  test("app routes are served correctly after startup with instrumentation.ts", async ({
    request,
  }) => {
    // Verify normal app functionality works — not just that the server started,
    // but that it is serving requests correctly. A crash during instrumentation
    // loading that was swallowed and allowed the server to continue in a broken
    // state would be caught here.
    const res = await request.get(`${BASE}/api/hello`);
    expect(res.status()).toBe(200);

    const data = await res.json();
    expect(typeof data).toBe("object");
  });
});
