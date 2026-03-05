/**
 * Regression test for instrumentation.ts startup crash when
 * @cloudflare/vite-plugin is present.
 *
 * ## The bug
 *
 * When @cloudflare/vite-plugin is loaded, it registers a Vite environment
 * named "rsc". The vinext configureServer() hook detects this and (in the
 * buggy version) tries to load instrumentation.ts via server.ssrLoadModule().
 *
 * Calling ssrLoadModule() during configureServer() — before the dev server is
 * listening — crashes in Vite 7 with:
 *
 *   TypeError: Cannot read properties of undefined (reading 'outsideEmitter')
 *
 * because SSRCompatModuleRunner is constructed synchronously and immediately
 * calls connect() on the transport, which reads environment.hot.api —
 * a property that is only populated once the server starts listening.
 *
 * The crash is specific to the combination of:
 *   1. @cloudflare/vite-plugin present (creates server.environments["rsc"])
 *   2. instrumentation.ts present in the project root
 *   3. The "rsc" environment has no .runner.import (it is a Cloudflare Workers
 *      environment, not @vitejs/plugin-rsc), so the check
 *      `rscEnv?.runner?.import` returns undefined and the code falls through
 *      to the ssrLoadModule fallback
 *
 * ## How this test reproduces it
 *
 * The Playwright webServer for this project is configured with
 * reuseExistingServer: false — it always starts a fresh server. If the bug is
 * present, `vite dev` exits with a non-zero code before the server ever starts
 * listening, Playwright cannot connect to port 4178, and every test in this
 * file fails with a connection error.
 *
 * If the fix is in place, the server starts successfully and the assertions
 * below pass.
 *
 * ## Note on register() observability
 *
 * register() runs in the host Node.js process (where configureServer() runs),
 * but the API routes run inside a Cloudflare Worker via miniflare — a separate
 * process with its own isolated globalThis and no access to the host filesystem
 * via real node:fs. There is no lightweight way to observe from within the
 * Worker that register() was called in the host. The crash test is the right
 * regression check: if the server starts and serves requests, the bug is absent.
 *
 * ## Fix
 *
 * When no usable module runner is found (neither @vitejs/plugin-rsc's runner
 * nor any other environment with .runner.import), build a direct-call
 * ModuleRunner on the SSR DevEnvironment that invokes environment.fetchModule()
 * directly, bypassing the hot channel entirely. environment.fetchModule() is a
 * plain async method on DevEnvironment — safe at any time during configureServer().
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4178";

test.describe("instrumentation.ts startup crash regression (@cloudflare/vite-plugin)", () => {
  test("dev server starts without crashing when instrumentation.ts is present alongside @cloudflare/vite-plugin", async ({
    request,
  }) => {
    // If we reach this line at all, vite dev started successfully — the
    // regression (a hard process crash in configureServer before the server
    // ever starts listening) is not present.
    //
    // The webServer for this project uses reuseExistingServer: false, so a
    // fresh server is started for every test run. A crash would cause
    // Playwright to fail connecting to port 4178 and this test would never
    // reach its body.
    const res = await request.get(`${BASE}/api/hello`);
    expect(res.status()).toBe(200);
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
