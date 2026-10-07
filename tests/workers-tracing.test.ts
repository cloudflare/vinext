import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vite-plus/test";
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
  status?: { code: "error"; message?: string };
};

function fakeTracing(spans: RecordedSpan[], isTraced = true) {
  const active = new AsyncLocalStorage<{ recorded: RecordedSpan; span: WorkersTracingSpan }>();
  return {
    getActiveSpan: () => active.getStore()?.span,
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
        recordException: (exception) => {
          if (isTraced) recorded.exceptions.push(exception);
        },
        setAttribute: (key, value) => {
          recorded.attributes[key] = value;
        },
        setStatus: (status) => {
          recorded.status = status;
        },
        updateName: (nextName) => {
          recorded.name = nextName;
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
        name: "RSC GET /products/[id]",
        parent: undefined,
      },
    ]);
  });

  // Next.js propagates the matched route to the enclosing platform span:
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/base-server.ts
  // Route assertions ported from Next.js:
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/otel-parent-span-propagation/otel-parent-span-propagation.test.ts
  it("annotates the native parent and finalizes the request name and error status", async () => {
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
        attributes: { "http.route": "/products/[id]" },
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
        name: "GET /products/[id]",
        parent: "worker.handler",
        status: { code: "error" },
      },
      {
        attributes: {
          "next.span_category": "nextjs",
          "next.span_name": "start response",
          "next.span_type": "NextNodeServer.startResponse",
        },
        exceptions: [],
        name: "start response",
        parent: "GET /products/[id]",
      },
    ]);
  });

  it("annotates the invocation root returned outside a custom span", () => {
    const root = { isTraced: true, setAttribute: vi.fn() };
    const tracing = {
      ...fakeTracing([]),
      getActiveSpan() {
        expect(this).toBe(tracing);
        return root;
      },
    };
    const tracer = createFrameworkTracer([createWorkersTracingIntegration(tracing)]);

    tracer.getActiveScopeSpan()?.setAttribute("http.route", "/");

    expect(root.setAttribute).toHaveBeenCalledWith("http.route", "/");
  });

  it("uses the active async scope without leaking between concurrent requests", async () => {
    const spans: RecordedSpan[] = [];
    const tracer = createFrameworkTracer([createWorkersTracingIntegration(fakeTracing(spans))]);
    expect(tracer.getActiveScopeSpan()).toBeUndefined();

    await Promise.all(
      ["first", "second"].map((name) =>
        tracer.trace({ type: "BaseServer.handleRequest", name }, async () => {
          await Promise.resolve();
          tracer.getActiveScopeSpan()?.setAttribute("request", name);
        }),
      ),
    );

    expect(spans.map(({ name, attributes }) => [name, attributes.request])).toEqual([
      ["first", "first"],
      ["second", "second"],
    ]);
    expect(tracer.getActiveScopeSpan()).toBeUndefined();
  });

  it.each([
    ["string", "failed", "failed"],
    [
      "structured",
      { code: "RATE_LIMITED", message: "retry later" },
      { code: "RATE_LIMITED", message: "retry later" },
    ],
    ["numeric code", { code: 0 }, { code: 0 }],
    ["name only", { name: "Unavailable" }, { name: "Unavailable" }],
    [
      "stack",
      { message: "failed", stack: "application stack" },
      { message: "failed", stack: "application stack" },
    ],
    ["number", 42, "42"],
    ["null", null, "null"],
    ["undefined", undefined, "undefined"],
    ["unsupported object", { unrelated: true }, "[object Object]"],
  ])(
    "preserves %s exceptions and rethrows the original value",
    async (_name, failure, expected) => {
      const spans: RecordedSpan[] = [];
      const tracer = createFrameworkTracer([createWorkersTracingIntegration(fakeTracing(spans))]);

      await expect(
        tracer.trace({ type: "AppRender.getBodyResult" }, () => Promise.reject(failure)),
      ).rejects.toBe(failure);

      expect(spans[0]?.exceptions).toEqual([expected]);
      expect(spans[0]?.status).toEqual({ code: "error" });
    },
  );

  it("preserves an Error's code, name, message, and stack", () => {
    const failure = Object.assign(new TypeError("broken"), { code: "ERR_TEST" });
    const spans: RecordedSpan[] = [];
    const tracer = createFrameworkTracer([createWorkersTracingIntegration(fakeTracing(spans))]);

    expect(() =>
      tracer.trace({ type: "AppRender.getBodyResult" }, () => {
        throw failure;
      }),
    ).toThrow(failure);

    expect(spans[0]?.exceptions).toEqual([
      { code: "ERR_TEST", name: "TypeError", message: "broken", stack: failure.stack },
    ]);
    expect(spans[0]?.status).toEqual({ code: "error", message: "broken" });
  });

  it("does not replace the application error when reading exception metadata fails", async () => {
    const failure = new Error("original failure");
    Object.defineProperty(failure, "code", {
      get() {
        throw new Error("code lookup failed");
      },
    });
    const spans: RecordedSpan[] = [];
    const tracer = createFrameworkTracer([createWorkersTracingIntegration(fakeTracing(spans))]);

    await expect(
      tracer.trace({ type: "AppRender.getBodyResult" }, () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(spans[0]?.exceptions).toEqual([
      { name: "Error", message: "original failure", stack: failure.stack },
    ]);
    expect(spans[0]?.attributes["error.type"]).toBe("Error");
    expect(spans[0]?.status).toEqual({ code: "error", message: "original failure" });
  });

  it.each(["code", "name", "message", "stack"])(
    "preserves other exception fields when the %s getter throws",
    async (field) => {
      const fields: Record<string, string> = {
        code: "ERR_TEST",
        name: "TestFailure",
        message: "original failure",
        stack: "application stack",
      };
      const failure = Object.defineProperty({ ...fields }, field, {
        get() {
          throw new Error("metadata lookup failed");
        },
      });
      const spans: RecordedSpan[] = [];
      const tracer = createFrameworkTracer([createWorkersTracingIntegration(fakeTracing(spans))]);

      await expect(
        tracer.trace({ type: "AppRender.getBodyResult" }, () => Promise.reject(failure)),
      ).rejects.toBe(failure);
      delete fields[field];
      expect(spans[0]?.exceptions).toEqual([fields]);
    },
  );

  it("keeps older runtimes working without optional span APIs", async () => {
    const attributes: Record<string, boolean | number | string> = {};
    const tracer = createFrameworkTracer([
      createWorkersTracingIntegration({
        enterSpan: (_name, callback) =>
          callback({
            isTraced: false,
            setAttribute: (key, value) => {
              attributes[key] = value;
            },
          }),
      }),
    ]);
    expect(tracer.getActiveScopeSpan()).toBeUndefined();
    expect(
      tracer.trace({ type: "BaseServer.handleRequest" }, (span) => {
        span.updateName("GET /products/[id]");
        span.setErrorStatus("failed");
        span.recordException(new Error("failed"));
        return 42;
      }),
    ).toBe(42);
    expect(attributes["next.span_name"]).toBe("GET /products/[id]");
    const failure = new Error("failed");
    await expect(
      tracer.trace({ type: "AppRender.getBodyResult" }, () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(attributes["error.type"]).toBe("Error");
  });

  it("executes unsampled work without inspecting or recording exception metadata", async () => {
    const spans: RecordedSpan[] = [];
    const tracer = createFrameworkTracer([
      createWorkersTracingIntegration(fakeTracing(spans, false)),
    ]);
    const readMetadata = vi.fn(() => "broken");
    const failure = Object.defineProperties(
      {},
      Object.fromEntries(
        ["code", "name", "message", "stack"].map((key) => [key, { get: readMetadata }]),
      ),
    );
    let calls = 0;

    await expect(
      tracer.trace({ type: "AppRender.getBodyResult" }, async () => {
        calls++;
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(calls).toBe(1);
    expect(readMetadata).not.toHaveBeenCalled();
    expect(spans[0]?.exceptions).toEqual([]);
  });

  it("loads the Node tracer without evaluating cloudflare:workers", async () => {
    await expect(import("../packages/vinext/src/server/tracer.js")).resolves.toHaveProperty(
      "frameworkTracer",
    );
  });
});
