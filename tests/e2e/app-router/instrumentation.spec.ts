/**
 * E2E tests for instrumentation.ts support.
 *
 * Next.js calls register() once at server startup and onRequestError() whenever
 * an unhandled error occurs during request handling.
 *
 * The app-basic fixture has instrumentation.ts at the project root which:
 *   - Sets a flag when register() is called
 *   - Records errors passed to onRequestError()
 *
 * The /api/instrumentation-test route exposes that state for assertions.
 *
 * References:
 * - https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

import { test, expect } from "@playwright/test";

/**
 * Tests that verify the startup state — these must NOT reset before running,
 * because register() is called once at server startup and the flag won't be
 * re-set after a DELETE reset.
 */
test.describe("instrumentation.ts startup", () => {
  test("register() was called before the first request", async ({
    request,
  }) => {
    // Do NOT reset first — we want to see the state from server startup.
    const res = await request.get("/api/instrumentation-test");
    expect(res.status()).toBe(200);

    const data = await res.json();
    // register() must have been invoked once when the dev server started.
    expect(data.registerCalled).toBe(true);
    expect(Array.isArray(data.errors)).toBe(true);
  });
});

/**
 * Tests for onRequestError() behaviour — each test resets state first so
 * errors from earlier tests don't bleed through.
 */
test.describe("instrumentation.ts onRequestError", () => {
  test.beforeEach(async ({ request }) => {
    // Reset captured state before each test so tests are independent.
    // Note: this also resets registerCalled, which is why register() startup
    // tests live in a separate describe block above.
    const res = await request.delete("/api/instrumentation-test");
    expect(res.status()).toBe(200);
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
    expect(err.routerKind).toBe("App Router");
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

  test("successful requests do not trigger onRequestError()", async ({
    request,
  }) => {
    // A normal successful API request should not produce an error entry.
    const okRes = await request.get("/api/hello");
    expect(okRes.status()).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const stateRes = await request.get("/api/instrumentation-test");
    const data = await stateRes.json();
    // After the reset in beforeEach, no new errors should have been recorded
    // by the successful /api/hello request.
    expect(data.errors.length).toBe(0);
  });
});
