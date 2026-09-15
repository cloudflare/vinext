import { test, expect, type APIRequestContext } from "@playwright/test";
import type {
  ReportedSentryError as ReportedError,
  ReportedSentryTransaction as ReportedTransaction,
} from "../../fixtures/sentry-test-state";

async function expectReportedError(request: APIRequestContext, message: string) {
  const state: { errors: ReportedError[] } = { errors: [] };

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

async function expectErrorTraceCorrelation(
  request: APIRequestContext,
  error: ReportedError,
): Promise<void> {
  expect(error.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(error.spanId).toMatch(/^[0-9a-f]{16}$/);
  await expect
    .poll(async () => {
      const stateRes = await request.get("/api/sentry-test-state");
      expect(stateRes.status()).toBe(200);
      const state = (await stateRes.json()) as { transactions: ReportedTransaction[] };
      return state.transactions.some(
        (transaction) =>
          transaction.traceId === error.traceId &&
          [transaction.spanId, ...transaction.spans.map(({ spanId }) => spanId)].includes(
            error.spanId ?? "",
          ),
      );
    })
    .toBe(true);
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

test.describe("Sentry on Cloudflare Workers Pages Router", () => {
  // Ported from Next.js: test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts
  test.beforeEach(async ({ request }) => {
    const res = await request.delete("/api/sentry-test-state");
    expect(res.status()).toBe(200);
  });

  test("reports a thrown route error through real @sentry/nextjs", async ({ request }) => {
    const errorRes = await request.get("/api/error-route");
    expect(errorRes.status()).toBe(500);

    const state = await expectReportedError(request, "Intentional Sentry Pages Router error");

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
    await expectErrorTraceCorrelation(
      request,
      state.errors.find(({ message }) => message === "Intentional Sentry Pages Router error")!,
    );
  });

  test("reports proxy errors with Next.js context and trace correlation", async ({ request }) => {
    const errorRes = await request.get("/proxy-error");
    expect(errorRes.status()).toBe(500);

    const state = await expectReportedError(request, "Intentional Sentry Pages Router proxy error");
    const error = state.errors.find(
      ({ message }) => message === "Intentional Sentry Pages Router proxy error",
    )!;
    expect(error).toMatchObject({
      projectId: "1",
      requestPath: "/proxy-error",
      routerKind: "Pages Router",
      routerPath: "/proxy",
      routeType: "proxy",
      sdkName: "sentry.javascript.nextjs",
    });
    await expectErrorTraceCorrelation(request, error);
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

    const handlerSpan = transaction.spans.find(
      ({ attributes }) => attributes["next.span_type"] === "Node.runHandler",
    );
    expect(handlerSpan).toMatchObject({
      attributes: expect.objectContaining({
        "next.span_name": "executing api route (pages) /api/trace/[slug]",
        "next.span_type": "Node.runHandler",
      }),
      name: "executing api route (pages) /api/trace/[slug]",
      parentSpanId: transaction.spanId,
      traceId: transaction.traceId,
    });
    expect(transaction.spans).toContainEqual(
      expect.objectContaining({
        name: "fixture.pages.child",
        traceId: transaction.traceId,
        parentSpanId: handlerSpan?.spanId,
        operation: "fixture.child",
        attributes: expect.objectContaining({
          "fixture.router": "pages",
          "fixture.slug": "product-42",
        }),
      }),
    );
  });

  // Ported from Next.js: test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts
  test("parents getServerSideProps application spans beneath the framework span", async ({
    request,
  }) => {
    const traceRes = await request.get("/trace-gssp/product-42");
    expect(traceRes.status()).toBe(200);

    const transaction = await expectReportedTransaction(request, "GET /trace-gssp/[slug]");
    const dataSpan = transaction.spans.find(
      ({ attributes }) => attributes["next.span_type"] === "Render.getServerSideProps",
    );
    expect(dataSpan).toMatchObject({
      attributes: expect.objectContaining({
        "next.route": "/trace-gssp/[slug]",
        "next.span_name": "getServerSideProps /trace-gssp/[slug]",
        "next.span_type": "Render.getServerSideProps",
      }),
      name: "getServerSideProps /trace-gssp/[slug]",
      parentSpanId: transaction.spanId,
      traceId: transaction.traceId,
    });
    expect(transaction.spans).toContainEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({ "fixture.slug": "product-42" }),
        name: "fixture.pages.gssp.child",
        operation: "fixture.gssp",
        parentSpanId: dataSpan?.spanId,
        traceId: transaction.traceId,
      }),
    );
  });

  test("traces request-time getStaticProps for a blocking fallback", async ({ request }) => {
    const slug = `runtime-${Date.now()}`;
    const traceRes = await request.get(`/trace-gsp/${slug}`);
    expect(traceRes.status()).toBe(200);

    const transaction = await expectReportedTransaction(request, "GET /trace-gsp/[slug]");
    const dataSpan = transaction.spans.find(
      ({ attributes }) => attributes["next.span_type"] === "Render.getStaticProps",
    );
    expect(dataSpan).toMatchObject({
      attributes: expect.objectContaining({
        "next.route": "/trace-gsp/[slug]",
        "next.span_name": "getStaticProps /trace-gsp/[slug]",
        "next.span_type": "Render.getStaticProps",
      }),
      name: "getStaticProps /trace-gsp/[slug]",
      parentSpanId: transaction.spanId,
      traceId: transaction.traceId,
    });
    expect(transaction.spans).toContainEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({ "fixture.slug": slug }),
        name: "fixture.pages.gsp.child",
        operation: "fixture.gsp",
        parentSpanId: dataSpan?.spanId,
        traceId: transaction.traceId,
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

    const state = await expectReportedError(
      request,
      "Intentional Sentry Pages Router render error",
    );

    expect(state.errors).toContainEqual(
      expect.objectContaining({
        message: "Intentional Sentry Pages Router render error",
        projectId: "1",
        requestPath: "/render-error",
        routerKind: "Pages Router",
        routerPath: "/render-error",
        routeType: "render",
        sdkName: "sentry.javascript.nextjs",
      }),
    );
    await expectErrorTraceCorrelation(
      request,
      state.errors.find(
        ({ message }) => message === "Intentional Sentry Pages Router render error",
      )!,
    );
  });

  test("reports a browser error through instrumentation-client Sentry.init", async ({
    page,
    request,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/");
    await page.waitForFunction(() => window.__VINEXT_HYDRATED_AT !== undefined);
    await page.getByRole("button", { name: "Trigger client error" }).click();

    await expect
      .poll(() =>
        pageErrors.some((message) =>
          message.includes("Intentional Sentry Pages Router client error"),
        ),
      )
      .toBe(true);

    const state = await expectReportedError(
      request,
      "Intentional Sentry Pages Router client error",
    );

    expect(state.errors).toContainEqual(
      expect.objectContaining({
        message: "Intentional Sentry Pages Router client error",
        projectId: "1",
        sdkName: "sentry.javascript.nextjs",
      }),
    );
  });
});
