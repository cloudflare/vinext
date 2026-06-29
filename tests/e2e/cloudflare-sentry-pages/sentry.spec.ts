import { test, expect } from "@playwright/test";

test.describe("Sentry on Cloudflare Workers Pages Router", () => {
  test.beforeEach(async ({ request }) => {
    const res = await request.delete("/api/sentry-test-state");
    expect(res.status()).toBe(200);
  });

  test("reports a thrown route error through real @sentry/nextjs", async ({ request }) => {
    const errorRes = await request.get("/api/error-route");
    expect(errorRes.status()).toBe(500);

    const state: { errors: Array<{ message?: string }> } = { errors: [] };

    await expect
      .poll(async () => {
        const stateRes = await request.get("/api/sentry-test-state");
        expect(stateRes.status()).toBe(200);
        Object.assign(state, await stateRes.json());
        return state.errors.some(
          (error) => error.message === "Intentional Sentry Pages Router error",
        );
      })
      .toBe(true);

    expect(state.errors).toContainEqual(
      expect.objectContaining({
        message: "Intentional Sentry Pages Router error",
        projectId: "1",
        requestPath: "/api/error-route",
        routerKind: "Pages Router",
        routerPath: "/api/error-route",
        routeType: "route",
        sdkName: "sentry.javascript.nextjs",
      }),
    );
  });
});
