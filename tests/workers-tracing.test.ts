import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vite-plus/test";
import { createFrameworkTracer } from "../packages/vinext/src/server/framework-tracer.js";
import {
  setFrameworkRequestRoute,
  traceFrameworkRequest,
} from "../packages/vinext/src/server/request-tracing.js";
import { registerFrameworkTracingIntegration } from "../packages/vinext/src/server/tracer.js";
import {
  createWorkersTracingIntegration,
  type WorkersTracingException,
  type WorkersTracingSpan,
} from "../packages/vinext/src/server/workers-tracing.js";
import {
  createAppPageRenderSpanDescriptor,
  resolveAppPageTraceOperation,
} from "../packages/vinext/src/server/app-page-tracing.js";
import { traceResponseStart } from "../packages/vinext/src/server/response-start-tracing.js";

// Cloudflare Workers custom spans API:
// https://developers.cloudflare.com/workers/observability/traces/custom-spans/

type RecordedSpan = {
  attributes: Record<string, boolean | number | string>;
  exceptions: WorkersTracingException[];
  name: string;
  parent?: string;
};

function fakeTracing(spans: RecordedSpan[], isTraced = true) {
  const active = new AsyncLocalStorage<{ recorded: RecordedSpan; span: WorkersTracingSpan }>();
  return {
    enterSpan<T>(name: string, callback: (span: WorkersTracingSpan) => T): T {
      const recorded: RecordedSpan = {
        attributes: {},
        exceptions: [],
        name,
        parent: active.getStore()?.recorded.name,
      };
      spans.push(recorded);
      const span: WorkersTracingSpan = {
        isTraced,
        recordException: (exception) => recorded.exceptions.push(exception),
        setAttribute: (key, value) => {
          recorded.attributes[key] = value;
        },
      };
      return active.run({ recorded, span }, () => callback(span));
    },
  };
}

describe("Workers framework tracing integration", () => {
  it("chooses an immutable render name for finite-revalidate auto-dynamic pages", () => {
    const spans: RecordedSpan[] = [];
    const tracer = createFrameworkTracer([createWorkersTracingIntegration(fakeTracing(spans))]);
    const operation = resolveAppPageTraceOperation({
      hasRequestSearchParams: false,
      isDynamicError: false,
      isForceStatic: false,
      isKnownPrerenderedRoute: false,
      isPrerender: false,
    });

    tracer.trace(createAppPageRenderSpanDescriptor("/products/:id", operation), () => {});

    expect(spans[0]).toMatchObject({
      attributes: {
        "next.span_name": "render route (app) /products/[id]",
      },
      name: "render route (app) /products/[id]",
    });
  });

  it("emits the shared Next.js descriptor and runs the callback once", async () => {
    const spans: RecordedSpan[] = [];
    const tracer = createFrameworkTracer([createWorkersTracingIntegration(fakeTracing(spans))]);
    let calls = 0;

    await expect(
      tracer.trace(
        {
          attributes: { "next.route": "/products/[id]", "next.rsc": true },
          name: "GET /products/[id]",
          type: "BaseServer.handleRequest",
        },
        async (span) => {
          calls++;
          span.setAttribute("http.status_code", 200);
          span.updateName("RSC GET /products/[id]");
          return "ok";
        },
      ),
    ).resolves.toBe("ok");

    expect(calls).toBe(1);
    expect(spans).toEqual([
      {
        attributes: {
          "http.status_code": 200,
          "next.route": "/products/[id]",
          "next.rsc": true,
          "next.span_category": "nextjs",
          "next.span_name": "RSC GET /products/[id]",
          "next.span_type": "BaseServer.handleRequest",
        },
        exceptions: [],
        name: "GET /products/[id]",
        parent: undefined,
      },
    ]);
  });

  it("keeps the request root beneath the active Worker span", async () => {
    const spans: RecordedSpan[] = [];
    const tracing = fakeTracing(spans);
    registerFrameworkTracingIntegration(createWorkersTracingIntegration(tracing));

    const response = await tracing.enterSpan("worker.handler", () =>
      traceFrameworkRequest({
        callback: async () => {
          setFrameworkRequestRoute("/products/[id]");
          return traceResponseStart(new Response("failed", { status: 500 }));
        },
        getStatus: (response) => response?.status,
        headers: new Headers(),
        method: "GET",
        target: "/products/42",
      }),
    );
    await response.text();

    expect(spans).toEqual([
      {
        attributes: {},
        exceptions: [],
        name: "worker.handler",
        parent: undefined,
      },
      {
        attributes: {
          "error.type": "500",
          "http.method": "GET",
          "http.route": "/products/[id]",
          "http.status_code": 500,
          "http.target": "/products/42",
          "next.route": "/products/[id]",
          "next.rsc": false,
          "next.span_category": "nextjs",
          "next.span_name": "GET /products/[id]",
          "next.span_type": "BaseServer.handleRequest",
        },
        exceptions: [],
        name: "GET",
        parent: "worker.handler",
      },
      {
        attributes: {
          "next.span_category": "nextjs",
          "next.span_name": "start response",
          "next.span_type": "NextNodeServer.startResponse",
        },
        exceptions: [],
        name: "start response",
        parent: "GET",
      },
    ]);
  });

  it("records failures and still executes work when the native span is not sampled", async () => {
    const spans: RecordedSpan[] = [];
    const tracer = createFrameworkTracer([
      createWorkersTracingIntegration(fakeTracing(spans, false)),
    ]);
    const failure = new TypeError("broken");
    let calls = 0;

    await expect(
      tracer.trace({ type: "AppRender.getBodyResult" }, async () => {
        calls++;
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(calls).toBe(1);
    expect(spans[0]?.attributes["error.type"]).toBe("TypeError");
    expect(spans[0]?.exceptions).toEqual([
      expect.objectContaining({ message: "broken", name: "TypeError" }),
    ]);
  });

  it("loads the Node tracer without evaluating cloudflare:workers", async () => {
    await expect(import("../packages/vinext/src/server/tracer.js")).resolves.toHaveProperty(
      "frameworkTracer",
    );
  });
});
