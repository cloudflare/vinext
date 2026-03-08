/**
 * E2E tests for instrumentation.ts onRequestError in Pages Router apps.
 *
 * These tests require all request handling to run in the same process as
 * instrumentation.ts so that reportRequestError() can call the registered
 * onRequestError handler and have the result visible to the API route that
 * reads state.
 *
 * This file is intentionally NOT shared with cloudflare-pages-router-dev:
 * when @cloudflare/vite-plugin is present, all requests are dispatched to
 * miniflare (a subprocess), so reportRequestError() never fires from the
 * host and state written by the host is not readable from inside workerd.
 *
 * For the Cloudflare dev case, see instrumentation-startup.spec.ts which
 * only asserts that the server starts without crashing.
 *
 * References:
 * - https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

import { test, expect } from "@playwright/test";

test.describe("instrumentation.ts onRequestError (Pages Router)", () => {
  test.beforeEach(async ({ request }) => {
    // Reset captured state before each test so errors from earlier tests
    // don't bleed through.
    const res = await request.delete("/api/instrumentation-test");
    expect(res.status()).toBe(200);
  });

  test("successful requests do not trigger onRequestError()", async ({
    request,
  }) => {
    const okRes = await request.get("/api/hello");
    expect(okRes.status()).toBe(200);

    // Give any async reportRequestError() call a moment to settle.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const stateRes = await request.get("/api/instrumentation-test");
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
    const errorRes = await request.get("/api/error-route");
    expect(errorRes.status()).toBe(500);

    // Give the async reportRequestError() call a moment to complete.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const stateRes = await request.get("/api/instrumentation-test");
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
    const errorRes = await request.get("/api/error-route");
    expect(errorRes.status()).toBe(500);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const stateRes = await request.get("/api/instrumentation-test");
    const data = await stateRes.json();
    expect(data.errors.length).toBeGreaterThanOrEqual(1);

    const err = data.errors[data.errors.length - 1];
    // The routePath should be the file-system route pattern, not the concrete URL.
    expect(err.routePath).toContain("error-route");
  });

  test("multiple errors are captured independently", async ({ request }) => {
    // Fire the error route twice and verify both entries are recorded.
    await request.get("/api/error-route");
    await request.get("/api/error-route");

    await new Promise((resolve) => setTimeout(resolve, 400));

    const stateRes = await request.get("/api/instrumentation-test");
    const data = await stateRes.json();
    expect(data.errors.length).toBeGreaterThanOrEqual(2);
  });
});
