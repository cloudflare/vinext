import { test, expect, type APIRequestContext } from "@playwright/test";
import type {
  ReportedSentryError as ReportedError,
  ReportedSentryTransaction as ReportedTransaction,
} from "../../fixtures/sentry-test-state";
import { waitForAppRouterHydration } from "../helpers";

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
    await expectErrorTraceCorrelation(
      request,
      state.errors.find(({ message }) => message === "Intentional Sentry App Router error")!,
    );
    const transaction = await expectReportedTransaction(request, "GET /api/error-route");
    const handlerSpan = transaction.spans.find(
      ({ attributes }) => attributes["next.span_type"] === "AppRouteRouteHandlers.runHandler",
    );
    expect(handlerSpan?.status).toEqual(expect.any(String));
    expect(handlerSpan?.status).not.toBe("ok");
  });

  test("reports proxy errors with Next.js context and trace correlation", async ({ request }) => {
    const errorRes = await request.get("/proxy-error");
    expect(errorRes.status()).toBe(500);

    const state = await expectReportedError(request, "Intentional Sentry App Router proxy error");
    const error = state.errors.find(
      ({ message }) => message === "Intentional Sentry App Router proxy error",
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

  test("parents Route Handler application spans beneath the framework span", async ({
    request,
  }) => {
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
      ({ attributes }) => attributes["next.span_type"] === "AppRouteRouteHandlers.runHandler",
    );
    expect(handlerSpan).toMatchObject({
      attributes: expect.objectContaining({
        "next.route": "/api/trace/[slug]",
        "next.span_name": "executing api route (app) /api/trace/[slug]",
        "next.span_type": "AppRouteRouteHandlers.runHandler",
      }),
      name: "executing api route (app) /api/trace/[slug]",
      parentSpanId: transaction.spanId,
      traceId: transaction.traceId,
    });

    expect(transaction.spans).toContainEqual(
      expect.objectContaining({
        name: "fixture.app.child",
        traceId: transaction.traceId,
        parentSpanId: handlerSpan?.spanId,
        operation: "fixture.child",
        attributes: expect.objectContaining({
          "fixture.router": "app",
          "fixture.slug": "product-42",
        }),
      }),
    );
  });

  test("retains application spans created while streaming the response", async ({ request }) => {
    const traceRes = await request.get("/api/trace-stream");
    expect(traceRes.status()).toBe(200);
    expect(await traceRes.text()).toBe("streamed");

    const transaction = await expectReportedTransaction(request, "GET /api/trace-stream");
    const handlerSpan = transaction.spans.find(
      ({ attributes }) => attributes["next.span_type"] === "AppRouteRouteHandlers.runHandler",
    );
    expect(transaction.spans).toContainEqual(
      expect.objectContaining({
        name: "fixture.app.stream.child",
        operation: "fixture.stream",
        parentSpanId: handlerSpan?.spanId,
        traceId: transaction.traceId,
      }),
    );
  });

  test("parents App Page application spans beneath the render framework span", async ({
    request,
  }) => {
    const traceRes = await request.get("/trace-page/product-42");
    expect(traceRes.status()).toBe(200);

    const transaction = await expectReportedTransaction(request, "GET /trace-page/[slug]");
    const renderSpan = transaction.spans.find(
      ({ attributes }) => attributes["next.span_type"] === "AppRender.getBodyResult",
    );
    expect(renderSpan).toMatchObject({
      attributes: expect.objectContaining({
        "next.route": "/trace-page/[slug]",
        "next.span_name": "render route (app) /trace-page/[slug]",
        "next.span_type": "AppRender.getBodyResult",
      }),
      name: "render route (app) /trace-page/[slug]",
      parentSpanId: transaction.spanId,
      traceId: transaction.traceId,
    });
    expect(transaction.spans).toContainEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({
          "fixture.router": "app-page",
          "fixture.slug": "product-42",
        }),
        name: "fixture.app.page.child",
        operation: "fixture.page",
        parentSpanId: renderSpan?.spanId,
        traceId: transaction.traceId,
      }),
    );
  });

  test("reports App Page fetches beneath the render framework span", async ({ request }) => {
    const traceRes = await request.get("/trace-fetch/product-42");
    expect(traceRes.status()).toBe(200);

    const transaction = await expectReportedTransaction(request, "GET /trace-fetch/[slug]");
    const renderSpan = transaction.spans.find(
      ({ attributes }) => attributes["next.span_type"] === "AppRender.getBodyResult",
    );
    const fetchSpan = transaction.spans.find(
      ({ attributes }) => attributes["next.span_type"] === "AppRender.fetch",
    );
    expect(fetchSpan).toMatchObject({
      attributes: expect.objectContaining({
        "http.method": "GET",
        "http.status_code": 200,
        "http.url": "https://example.com/",
        "net.peer.name": "example.com",
        "next.fetch.cache_reason": "cache: no-store",
        "next.fetch.cache_status": "skip",
        "next.fetch.idx": 2,
        "next.span_name": "fetch GET https://example.com/",
        "next.span_type": "AppRender.fetch",
      }),
      // Sentry derives the display name from the HTTP semantic attributes;
      // next.span_name above retains the framework's Next.js-compatible name.
      name: "GET https://example.com/",
      operation: "http.client",
      parentSpanId: renderSpan?.spanId,
      traceId: transaction.traceId,
    });
  });

  test("does not emit an App render span for an RSC payload request", async ({ request }) => {
    const traceRes = await request.get("/trace-page/product-42?_rsc", {
      headers: { Accept: "text/x-component", RSC: "1" },
    });
    expect(traceRes.status()).toBe(200);

    const transaction = await expectReportedTransaction(request, "GET /trace-page/[slug]");
    expect(transaction.attributes["next.span_name"]).toBe("RSC GET /trace-page/[slug]");
    expect(transaction.spans).not.toContainEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({
          "next.span_type": "AppRender.getBodyResult",
        }),
      }),
    );
  });

  test("uses the prerender span for an on-demand static App Page", async ({ request }) => {
    const traceRes = await request.get("/trace-static/product-42");
    expect(traceRes.status()).toBe(200);

    const transaction = await expectReportedTransaction(request, "GET /trace-static/[slug]");
    const renderSpan = transaction.spans.find(
      ({ attributes }) => attributes["next.span_type"] === "AppRender.getBodyResult",
    );
    expect(renderSpan).toMatchObject({
      attributes: expect.objectContaining({
        "next.route": "/trace-static/[slug]",
        "next.span_name": "prerender route (app) /trace-static/[slug]",
      }),
      name: "prerender route (app) /trace-static/[slug]",
      parentSpanId: transaction.spanId,
    });
  });

  test("uses the render span when an auto-dynamic App Page reads request data", async ({
    request,
  }) => {
    const traceRes = await request.get(`/trace-auto/product-${Date.now()}`, {
      headers: { Cookie: "fixture=present" },
    });
    expect(traceRes.status()).toBe(200);

    const transaction = await expectReportedTransaction(request, "GET /trace-auto/[slug]");
    const renderSpan = transaction.spans.find(
      ({ attributes }) => attributes["next.span_type"] === "AppRender.getBodyResult",
    );
    expect(renderSpan).toMatchObject({
      attributes: expect.objectContaining({
        "next.span_name": "render route (app) /trace-auto/[slug]",
      }),
      name: "render route (app) /trace-auto/[slug]",
    });
  });

  test("keeps Route Handler control responses successful inside the framework span", async ({
    request,
  }) => {
    const traceRes = await request.get("/api/trace-redirect", { maxRedirects: 0 });
    expect(traceRes.status()).toBe(307);

    const transaction = await expectReportedTransaction(request, "GET /api/trace-redirect");
    const handlerSpan = transaction.spans.find(
      ({ attributes }) => attributes["next.span_type"] === "AppRouteRouteHandlers.runHandler",
    );
    expect(handlerSpan).toMatchObject({
      name: "executing api route (app) /api/trace-redirect",
      parentSpanId: transaction.spanId,
    });
    expect([undefined, "ok"]).toContain(handlerSpan?.status);
  });

  test("keeps the handler span successful when response validation fails afterward", async ({
    request,
  }) => {
    const traceRes = await request.get("/api/trace-invalid-response");
    expect(traceRes.status()).toBe(500);

    const transaction = await expectReportedTransaction(request, "GET /api/trace-invalid-response");
    const handlerSpan = transaction.spans.find(
      ({ attributes }) => attributes["next.span_type"] === "AppRouteRouteHandlers.runHandler",
    );
    expect([undefined, "ok"]).toContain(handlerSpan?.status);
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
    await expectErrorTraceCorrelation(
      request,
      state.errors.find(({ message }) => message === "Intentional Sentry App Router render error")!,
    );
    const transaction = await expectReportedTransaction(request, "GET /render-error");
    const renderSpan = transaction.spans.find(
      ({ attributes }) => attributes["next.span_type"] === "AppRender.getBodyResult",
    );
    expect(renderSpan?.status).toEqual(expect.any(String));
    expect(renderSpan?.status).not.toBe("ok");
  });

  // Ported from Next.js: test/e2e/on-request-error/basic/basic.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/on-request-error/basic/basic.test.ts
  test("reports client component SSR errors in the request trace", async ({ request }) => {
    const errorRes = await request.get("/ssr-render-error");
    expect(errorRes.status()).toBe(500);

    const state = await expectReportedError(
      request,
      "Intentional Sentry App Router SSR render error",
    );
    const error = state.errors.find(
      ({ message }) => message === "Intentional Sentry App Router SSR render error",
    )!;
    expect(error).toMatchObject({
      projectId: "1",
      requestPath: "/ssr-render-error",
      routerKind: "App Router",
      routerPath: "/ssr-render-error",
      routeType: "render",
      sdkName: "sentry.javascript.nextjs",
    });
    await expectErrorTraceCorrelation(request, error);
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
