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
import { GENERIC_RSC_ERROR } from "../action-error-sanitization";
import { waitForAppRouterHydration } from "../helpers";

/**
 * Tests that verify the startup state. register() is called once at server
 * startup; a DELETE reset keeps its flag.
 */
test.describe("instrumentation.ts startup", () => {
  test("register() was called before the first request", async ({ request }) => {
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
    const res = await request.delete("/api/instrumentation-test");
    expect(res.status()).toBe(200);
  });

  test("onRequestError() is called when a route handler throws", async ({ request }) => {
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

    const err = data.errors.find((e: { path: string }) => e.path === "/api/error-route");
    expect(err).toBeTruthy();
    expect(err.message).toBe("Intentional route handler error");
    expect(err.method).toBe("GET");
    expect(err.routerKind).toBe("App Router");
    expect(err.routeType).toBe("route");
  });

  test("onRequestError() receives the correct route path pattern", async ({ request }) => {
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

  // Next.js reports a thrown fetch action through the Flight render of its
  // rejected result, with routeType "action".
  // Reproduced against next@16.2.7: onRequestError() gets the thrown value as
  // an Error. In dev the browser gets React's description of it; a production
  // build sends only React's generic message and a digest.
  for (const { trigger, clientText, message } of [
    {
      trigger: "throw-error",
      clientText: "Error: connect postgres://admin:s3cret@10.0.0.5:5432/prod failed",
      message: "connect postgres://admin:s3cret@10.0.0.5:5432/prod failed",
    },
    {
      trigger: "throw-structured",
      clientText: "Error: {code: ..., connectionString: ..., stack: ...}",
      message:
        /^\{"code":"DB_CONNECTION_FAILED","connectionString":"postgres:\/\/admin:s3cret@10\.0\.0\.5:5432\/prod","stack":"Error: structured failure\\n/,
    },
  ]) {
    test(`onRequestError() is called when a fetch action throws (${trigger})`, async ({
      page,
      request,
    }, testInfo) => {
      // The only project that runs this spec against a production build.
      const production = testInfo.project.name === "cloudflare-workers";
      await page.goto("/action-error-sanitization");
      await waitForAppRouterHydration(page);
      await page.click(`#${trigger}`);
      await expect(page.locator("#error-text")).toHaveText(
        production ? GENERIC_RSC_ERROR : clientText,
      );
      await expect(page.locator("#error-digest")).toHaveText(/^\S+$/);
      await expect(page.locator("#error-keys")).toHaveText(
        production ? "digest" : "digest,environmentName,name",
      );

      await expect(async () => {
        const data = await (await request.get("/api/instrumentation-test")).json();
        const actionErrors = data.errors.filter(
          (error: { path: string }) => error.path === "/action-error-sanitization",
        );
        expect(actionErrors).toEqual([
          {
            message: typeof message === "string" ? message : expect.stringMatching(message),
            method: "POST",
            path: "/action-error-sanitization",
            routePath: "/action-error-sanitization",
            routeType: "action",
            routerKind: "App Router",
          },
        ]);
      }).toPass({ timeout: 5_000 });
    });
  }

  test("successful requests do not trigger onRequestError()", async ({ request }) => {
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
