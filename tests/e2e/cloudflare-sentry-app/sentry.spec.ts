import { test, expect, type APIRequestContext } from "@playwright/test";
import type { ReportedSentryTransaction as ReportedTransaction } from "../../fixtures/sentry-test-state";
import { waitForAppRouterHydration } from "../helpers";

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

async function expectReportedTransaction(request: APIRequestContext, name: string) {
  let transaction: ReportedTransaction | undefined;

  await expect
    .poll(async () => {
      const stateRes = await request.get("/api/sentry-test-state");
      expect(stateRes.status()).toBe(200);
      const state = (await stateRes.json()) as { transactions: ReportedTransaction[] };
      transaction = state.transactions.find((candidate) => candidate.name === name);
      return transaction !== undefined;
    })
    .toBe(true);

  if (!transaction) throw new Error(`Sentry transaction was not reported: ${name}`);
  return transaction;
}

test.describe("Sentry on Cloudflare Workers App Router", () => {
  // Ported from Next.js: test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts
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

  test("records transaction envelopes and nested application spans", async ({ request }) => {
    const traceRes = await request.get("/api/trace/product-42");
    expect(traceRes.status()).toBe(200);

    const transaction = await expectReportedTransaction(request, "GET /api/trace/[slug]");
    expect(transaction).toMatchObject({
      attributes: expect.objectContaining({
        "http.route": "/api/trace/[slug]",
        "http.status_code": 200,
        "next.route": "/api/trace/[slug]",
        "next.span_type": "BaseServer.handleRequest",
      }),
    });
    expect(transaction.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(transaction.spanId).toMatch(/^[0-9a-f]{16}$/);

    expect(transaction.spans).toContainEqual(
      expect.objectContaining({
        name: "fixture.app.child",
        traceId: transaction.traceId,
        parentSpanId: transaction.spanId,
        operation: "fixture.child",
        attributes: expect.objectContaining({
          "fixture.router": "app",
          "fixture.slug": "product-42",
        }),
      }),
    );
  });

  test("continues incoming Sentry traces without leaking parallel request context", async ({
    request,
  }) => {
    const firstTraceId = "11111111111111111111111111111111";
    const secondTraceId = "22222222222222222222222222222222";
    await Promise.all([
      request.get("/api/trace/first", {
        headers: { "sentry-trace": `${firstTraceId}-aaaaaaaaaaaaaaaa-1` },
      }),
      request.get("/api/trace/second", {
        headers: { "sentry-trace": `${secondTraceId}-bbbbbbbbbbbbbbbb-1` },
      }),
    ]);

    await expect
      .poll(async () => {
        const stateRes = await request.get("/api/sentry-test-state");
        expect(stateRes.status()).toBe(200);
        const state = (await stateRes.json()) as { transactions: ReportedTransaction[] };
        return state.transactions
          .filter(({ name }) => name === "GET /api/trace/[slug]")
          .map(({ traceId }) => traceId)
          .sort();
      })
      .toEqual([firstTraceId, secondTraceId]);
  });

  test("marks 500 framework transactions as failed", async ({ request }) => {
    const res = await request.get("/api/trace-failure/test");
    expect(res.status()).toBe(500);

    const transaction = await expectReportedTransaction(request, "GET /api/trace-failure/[slug]");
    expect(transaction).toMatchObject({ status: expect.any(String) });
    expect(transaction.status).not.toBe("ok");
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

  test("reports a browser error through instrumentation-client Sentry.init", async ({
    page,
    request,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/");
    await waitForAppRouterHydration(page);
    await page.getByRole("button", { name: "Trigger client error" }).click();

    await expect
      .poll(() =>
        pageErrors.some((message) =>
          message.includes("Intentional Sentry App Router client error"),
        ),
      )
      .toBe(true);

    const state = await expectReportedError(request, "Intentional Sentry App Router client error");

    expect(state.errors).toContainEqual(
      expect.objectContaining({
        message: "Intentional Sentry App Router client error",
        projectId: "1",
        sdkName: "sentry.javascript.nextjs",
      }),
    );
  });
});
