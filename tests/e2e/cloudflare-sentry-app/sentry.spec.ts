import { test, expect, type APIRequestContext } from "@playwright/test";

async function expectReportedError(request: APIRequestContext, message: string) {
  const state: { errors: Array<{ message?: string }> } = { errors: [] };

  await expect
    .poll(async () => {
      const stateRes = await request.get("/api/sentry-test-state");
      expect(stateRes.status()).toBe(200);
      Object.assign(state, await stateRes.json());
      return state.errors.some((error) => error.message === message);
    })
    .toBe(true);

  return state;
}

test.describe("Sentry on Cloudflare Workers App Router", () => {
  test.beforeEach(async ({ request }) => {
    const res = await request.delete("/api/sentry-test-state");
    expect(res.status()).toBe(200);
  });

  test("reports a thrown route error through real @sentry/nextjs", async ({ request }) => {
    const errorRes = await request.get("/api/error-route");
    expect(errorRes.status()).toBe(500);

    const state = await expectReportedError(request, "Intentional Sentry App Router error");

    expect(state.errors).toContainEqual(
      expect.objectContaining({
        message: "Intentional Sentry App Router error",
        projectId: "1",
        requestPath: "/api/error-route",
        routerKind: "App Router",
        routerPath: "/api/error-route",
        routeType: "route",
        sdkName: "sentry.javascript.nextjs",
      }),
    );
  });

  test("reports a thrown render error through real @sentry/nextjs", async ({ request }) => {
    const errorRes = await request.get("/render-error");
    expect(errorRes.status()).toBe(500);

    const state = await expectReportedError(request, "Intentional Sentry App Router render error");

    expect(state.errors).toContainEqual(
      expect.objectContaining({
        message: "Intentional Sentry App Router render error",
        projectId: "1",
        requestPath: "/render-error",
        routerKind: "App Router",
        routerPath: "/render-error",
        routeType: "render",
        sdkName: "sentry.javascript.nextjs",
      }),
    );
  });
});
