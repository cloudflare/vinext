import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { executeMiddleware } from "../packages/vinext/src/server/middleware-runtime.js";
import type {
  FrameworkTracingBackendSpan,
  ResolvedFrameworkSpanDescriptor,
} from "../packages/vinext/src/server/framework-tracer.js";
import { registerFrameworkTracingIntegration } from "../packages/vinext/src/server/tracer.js";

type RecordedSpan = {
  descriptor: ResolvedFrameworkSpanDescriptor;
  detached: boolean;
  errors: unknown[];
  propagated: boolean;
  status?: string;
};

const context = new AsyncLocalStorage<{ detached: boolean; propagated: boolean }>();
const spans: RecordedSpan[] = [];

registerFrameworkTracingIntegration({
  id: "middleware-tracing-test",
  runWithDetachedContext: (callback) =>
    context.run({ detached: true, propagated: false }, callback),
  withPropagatedContext: (_headers, callback) =>
    context.run({ detached: context.getStore()?.detached ?? false, propagated: true }, callback),
  enterSpan<T>(
    descriptor: ResolvedFrameworkSpanDescriptor,
    callback: (span: FrameworkTracingBackendSpan) => T,
  ): T {
    const active = context.getStore();
    const recorded: RecordedSpan = {
      descriptor,
      detached: active?.detached ?? false,
      errors: [],
      propagated: active?.propagated ?? false,
    };
    spans.push(recorded);
    return callback({
      recordException: (error) => recorded.errors.push(error),
      setAttribute: (key, value) => {
        recorded.descriptor.attributes = { ...recorded.descriptor.attributes, [key]: value };
      },
      setErrorStatus: (message) => {
        recorded.status = message ?? "error";
      },
    });
  },
});

afterEach(() => {
  spans.length = 0;
});

describe("middleware tracing", () => {
  it("emits the Next.js Middleware.execute span after matcher acceptance", async () => {
    await executeMiddleware({
      isProxy: false,
      module: { default: () => new Response(null, { headers: { "x-middleware-next": "1" } }) },
      request: new Request("https://example.com/products/42"),
    });

    expect(spans).toEqual([
      expect.objectContaining({
        descriptor: {
          attributes: {
            "http.method": "GET",
            "http.target": "/products/42",
            "next.span_category": "nextjs",
            "next.span_name": "middleware GET",
            "next.span_type": "Middleware.execute",
          },
          kind: "internal",
          name: "middleware GET",
          type: "Middleware.execute",
        },
        detached: true,
        propagated: true,
      }),
    ]);
  });

  it("does not trace matcher misses", async () => {
    await executeMiddleware({
      isProxy: false,
      module: { config: { matcher: "/matched" }, default: () => undefined },
      request: new Request("https://example.com/missed"),
    });

    expect(spans).toEqual([]);
  });

  it("records middleware failures before converting them to a 500 response", async () => {
    const failure = new TypeError("middleware failed");
    const result = await executeMiddleware({
      isProxy: false,
      module: {
        default() {
          throw failure;
        },
      },
      request: new Request("https://example.com/failure"),
    });

    expect(result.response?.status).toBe(500);
    expect(spans[0]).toMatchObject({
      errors: [failure],
      status: "middleware failed",
    });
    expect(spans[0]?.descriptor.attributes["error.type"]).toBe("TypeError");
  });
});
