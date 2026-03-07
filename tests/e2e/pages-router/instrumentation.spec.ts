/**
 * E2E tests for instrumentation.ts support in Pages Router apps.
 *
 * ## Regression covered
 *
 * Pages Router apps have no RSC environment, so the loader selection in
 * index.ts falls back to `server` (i.e. `server.ssrLoadModule`). In Vite 7,
 * calling `ssrLoadModule` during `configureServer` — before the dev server is
 * listening — crashes with:
 *
 *   TypeError: Cannot read properties of undefined (reading 'outsideEmitter')
 *
 * because `SSRCompatModuleRunner` requires a hot channel that only exists
 * after the server is fully set up. The fix must avoid using `ssrLoadModule`
 * at startup for Pages Router apps.
 *
 * If the regression is present, the dev server crashes on startup and the
 * test below can never pass (Playwright's webServer will fail to connect).
 *
 * References:
 * - https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

/**
 * Startup test — must NOT reset before running, because register() is called
 * once at server startup. If the server crashed before it started listening
 * (the regression), Playwright would never reach this test.
 */
test.describe("instrumentation.ts startup (Pages Router)", () => {
  test("dev server starts without crashing when instrumentation.ts is present", async ({
    request,
  }) => {
    // If we reach this line at all, the server started successfully —
    // the startup crash regression is not present.
    const res = await request.get(`${BASE}/api/instrumentation-test`);
    expect(res.status()).toBe(200);
  });

  test("register() was called before the first request", async ({
    request,
  }) => {
    // Do NOT reset first — register() fires once at startup and won't be
    // re-invoked after a DELETE reset.
    const res = await request.get(`${BASE}/api/instrumentation-test`);
    expect(res.status()).toBe(200);

    const data = await res.json();
    // register() must have been invoked once when the dev server started.
    expect(data.registerCalled).toBe(true);
    expect(Array.isArray(data.errors)).toBe(true);
  });
});

test.describe("instrumentation.ts onRequestError (Pages Router)", () => {
  test.beforeEach(async ({ request }) => {
    // Reset captured state before each test so errors from earlier tests
    // don't bleed through. Note: this also resets registerCalled, which is
    // why the startup tests live in a separate describe block above.
    const res = await request.delete(`${BASE}/api/instrumentation-test`);
    expect(res.status()).toBe(200);
  });

  test("successful requests do not trigger onRequestError()", async ({
    request,
  }) => {
    const okRes = await request.get(`${BASE}/api/hello`);
    expect(okRes.status()).toBe(200);

    // Give any async reportRequestError() call a moment to settle.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const stateRes = await request.get(`${BASE}/api/instrumentation-test`);
    const data = await stateRes.json();
    // After the reset in beforeEach, no errors should have been recorded
    // by the successful /api/hello request.
    expect(data.errors.length).toBe(0);
  });

  test("onRequestError() is called when a route handler throws", async ({
    request,
  }) => {
    // /api/error-route throws an unhandled Error — vinext should invoke
    // the onRequestError handler registered in instrumentation.ts.
    const errorRes = await request.get(`${BASE}/api/error-route`);
    expect(errorRes.status()).toBe(500);

    // Give the async reportRequestError() call a moment to complete.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const stateRes = await request.get(`${BASE}/api/instrumentation-test`);
    expect(stateRes.status()).toBe(200);

    const data = await stateRes.json();
    expect(data.errors.length).toBeGreaterThanOrEqual(1);

    const err = data.errors[data.errors.length - 1];
    expect(err.message).toBe("Intentional route handler error");
    expect(err.path).toBe("/api/error-route");
    expect(err.method).toBe("GET");
    expect(err.routerKind).toBe("Pages Router");
    expect(err.routeType).toBe("route");
	});

  test("onRequestError() receives the correct route path pattern", async ({
    request,
  }) => {
    const errorRes = await request.get(`${BASE}/api/error-route`);
    expect(errorRes.status()).toBe(500);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const stateRes = await request.get(`${BASE}/api/instrumentation-test`);
    const data = await stateRes.json();
    expect(data.errors.length).toBeGreaterThanOrEqual(1);

    const err = data.errors[data.errors.length - 1];
    // The routePath should be the file-system route pattern, not the concrete URL.
    expect(err.routePath).toContain("error-route");
  });

  test("multiple errors are captured independently", async ({ request }) => {
    // Fire the error route twice and verify both entries are recorded.
    await request.get(`${BASE}/api/error-route`);
    await request.get(`${BASE}/api/error-route`);

    await new Promise((resolve) => setTimeout(resolve, 400));

    const stateRes = await request.get(`${BASE}/api/instrumentation-test`);
    const data = await stateRes.json();
    expect(data.errors.length).toBeGreaterThanOrEqual(2);
  });
});
