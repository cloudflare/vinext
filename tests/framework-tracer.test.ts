import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createFrameworkTracer,
  type FrameworkTracingBackendSpan,
  type FrameworkTracingIntegration,
  type ResolvedFrameworkSpanDescriptor,
} from "../packages/vinext/src/server/framework-tracer.js";
import { openTelemetryTracingIntegration } from "../packages/vinext/src/server/opentelemetry-tracing.js";
import { isPromiseLike } from "../packages/vinext/src/utils/promise.js";

// Next.js reference:
// packages/next/src/server/lib/trace/tracer.ts
// test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts

type RecordedSpan = {
  attributes: Record<string, string | number | boolean>;
  ended: boolean;
  errors: unknown[];
  name: string;
  parent: string | undefined;
  status: string | undefined;
};

function recordingIntegration(spans: RecordedSpan[]): FrameworkTracingIntegration {
  const active = new AsyncLocalStorage<string>();
  return {
    id: `recording-${spans.length}-${crypto.randomUUID()}`,
    enterSpan<T>(
      descriptor: ResolvedFrameworkSpanDescriptor,
      callback: (span: FrameworkTracingBackendSpan) => T,
    ): T {
      const recorded: RecordedSpan = {
        attributes: { ...descriptor.attributes },
        ended: false,
        errors: [],
        name: descriptor.name,
        parent: active.getStore(),
        status: undefined,
      };
      spans.push(recorded);
      let result: T;
      try {
        result = active.run(descriptor.name, () =>
          callback({
            recordException: (error) => recorded.errors.push(error),
            setAttribute: (key, value) => {
              recorded.attributes[key] = value;
            },
            setErrorStatus: (message) => {
              recorded.status = message ?? "error";
            },
            updateName: (name) => {
              recorded.name = name;
            },
          }),
        );
      } catch (error) {
        recorded.ended = true;
        throw error;
      }
      if (isPromiseLike(result)) {
        return Promise.resolve(result).finally(() => {
          recorded.ended = true;
        }) as T;
      }
      recorded.ended = true;
      return result;
    },
  };
}

const apiSymbol = Symbol.for("opentelemetry.js.api.1");
const originalApi = (globalThis as Record<symbol, unknown>)[apiSymbol];
const originalRequire = (globalThis as { require?: unknown }).require;

afterEach(() => {
  if (originalApi === undefined) delete (globalThis as Record<symbol, unknown>)[apiSymbol];
  else (globalThis as Record<symbol, unknown>)[apiSymbol] = originalApi;
  if (originalRequire === undefined) delete (globalThis as { require?: unknown }).require;
  else (globalThis as { require?: unknown }).require = originalRequire;
});

describe("framework tracer", () => {
  it("exposes the process-wide tracer as a no-op without a provider", async () => {
    delete (globalThis as Record<symbol, unknown>)[apiSymbol];
    const { frameworkTracer } = await import("../packages/vinext/src/server/tracer.js");

    expect(frameworkTracer.trace({ type: "BaseServer.handleRequest" }, () => "ok")).toBe("ok");
  });

  it("sends one logical span and the stable Next.js attributes to every integration", () => {
    const first: RecordedSpan[] = [];
    const second: RecordedSpan[] = [];
    const tracer = createFrameworkTracer([
      recordingIntegration(first),
      recordingIntegration(second),
    ]);
    let calls = 0;

    const result = tracer.trace(
      {
        attributes: { "next.route": "/products/[id]", "next.rsc": true },
        name: "GET /products/[id]",
        type: "BaseServer.handleRequest",
      },
      (span) => {
        calls++;
        span.setAttribute("http.status_code", 200);
        return 42;
      },
    );

    expect(result).toBe(42);
    expect(calls).toBe(1);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      attributes: {
        "http.status_code": 200,
        "next.route": "/products/[id]",
        "next.rsc": true,
        "next.span_category": "nextjs",
        "next.span_name": "GET /products/[id]",
        "next.span_type": "BaseServer.handleRequest",
      },
      ended: true,
      name: "GET /products/[id]",
    });
  });

  it("preserves sync and async nesting and concurrent context isolation", async () => {
    const spans: RecordedSpan[] = [];
    const tracer = createFrameworkTracer([recordingIntegration(spans)]);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = tracer.trace({ type: "outer-one" }, async () => {
      await firstGate;
      return tracer.trace({ type: "inner-one" }, async () => "first");
    });
    const second = tracer.trace({ type: "outer-two" }, async () =>
      tracer.trace({ type: "inner-two" }, () => "second"),
    );
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(spans.map(({ name, parent }) => [name, parent])).toEqual([
      ["outer-one", undefined],
      ["outer-two", undefined],
      ["inner-two", "outer-two"],
      ["inner-one", "outer-one"],
    ]);
    expect(spans.every(({ ended }) => ended)).toBe(true);
  });

  it.each([
    ["synchronous", false],
    ["asynchronous", true],
  ])("records and rethrows %s failures", async (_label, asynchronous) => {
    const first: RecordedSpan[] = [];
    const second: RecordedSpan[] = [];
    const tracer = createFrameworkTracer([
      recordingIntegration(first),
      recordingIntegration(second),
    ]);
    const failure = new TypeError("broken");

    if (asynchronous) {
      await expect(
        tracer.trace({ type: "failing" }, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
    } else {
      expect(() =>
        tracer.trace({ type: "failing" }, () => {
          throw failure;
        }),
      ).toThrow(failure);
    }

    for (const recorded of [...first, ...second]) {
      expect(recorded.errors).toEqual([failure]);
      expect(recorded.attributes["error.type"]).toBe("TypeError");
      expect(recorded.status).toBe("broken");
      expect(recorded.ended).toBe(true);
    }
  });

  it("runs normally without integrations", async () => {
    const tracer = createFrameworkTracer([]);
    expect(tracer.trace({ type: "sync" }, () => "ok")).toBe("ok");
    await expect(tracer.trace({ type: "async" }, async () => "ok")).resolves.toBe("ok");
  });
});

describe("OpenTelemetry integration", () => {
  it("uses a provider registered through the real API without requiring the package", async () => {
    type TestSpan = {
      end(): void;
      isRecording(): boolean;
      recordException(error: unknown): void;
      setAttribute(key: string, value: string | number | boolean): void;
      setStatus(status: { message?: string }): void;
      spanContext(): unknown;
      updateName(name: string): void;
    };
    const spans: RecordedSpan[] = [];
    const requireFromSentry = createRequire(import.meta.resolve("@sentry/nextjs/package.json"));
    const api = requireFromSentry("@opentelemetry/api") as {
      trace: {
        disable(): void;
        setGlobalTracerProvider(provider: {
          getTracer(
            name: string,
            version?: string,
          ): {
            startActiveSpan<T>(
              name: string,
              options: {
                attributes: Record<string, string | number | boolean>;
                kind: number;
              },
              callback: (span: TestSpan) => T,
            ): T;
          };
        }): boolean;
      };
    };

    api.trace.disable();
    expect(
      api.trace.setGlobalTracerProvider({
        getTracer(name, version) {
          expect([name, version]).toEqual(["next.js", "0.0.1"]);
          return {
            startActiveSpan(spanName, options, callback) {
              expect(options.kind).toBe(2);
              const recorded: RecordedSpan = {
                attributes: { ...options.attributes },
                ended: false,
                errors: [],
                name: spanName,
                parent: undefined,
                status: undefined,
              };
              spans.push(recorded);
              const span: TestSpan = {
                end: () => {
                  recorded.ended = true;
                },
                isRecording: () => true,
                recordException: (error) => recorded.errors.push(error),
                setAttribute: (key, value) => {
                  recorded.attributes[key] = value;
                },
                setStatus: ({ message }) => {
                  recorded.status = message ?? "error";
                },
                spanContext: () => ({}),
                updateName: (updatedName) => {
                  recorded.name = updatedName;
                },
              };
              return callback(span);
            },
          };
        },
      }),
    ).toBe(true);

    try {
      const tracer = createFrameworkTracer([openTelemetryTracingIntegration]);
      await tracer.trace({ kind: "client", type: "AppRender.fetch" }, async (span) => {
        span.updateName("fetch https://example.com");
      });
    } finally {
      api.trace.disable();
    }

    expect(spans).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          "next.span_name": "fetch https://example.com",
          "next.span_type": "AppRender.fetch",
        }),
        ended: true,
        name: "fetch https://example.com",
      }),
    ]);
  });

  it("extracts incoming propagation only when no span is already active", () => {
    const spanKey = Symbol.for("OpenTelemetry Context Key SPAN");
    type TestContext = {
      deleteValue(key: symbol): TestContext;
      getValue(key: symbol): unknown;
      remote?: string;
      setValue(key: symbol, value: unknown): TestContext;
    };
    const createContext = (remote?: string, span?: { spanContext(): unknown }): TestContext => ({
      deleteValue: (key) => (key === spanKey ? createContext(remote) : createContext(remote, span)),
      getValue: (key) => (key === spanKey ? span : undefined),
      remote,
      setValue: (key, value) =>
        key === spanKey
          ? createContext(remote, value as { spanContext(): unknown })
          : createContext(remote, span),
    });
    let activeContext = createContext();
    let extractions = 0;
    (globalThis as Record<symbol, unknown>)[apiSymbol] = {
      context: {
        active: () => activeContext,
        with<T>(context: typeof activeContext, callback: () => T): T {
          const previous = activeContext;
          activeContext = context;
          try {
            return callback();
          } finally {
            activeContext = previous;
          }
        },
      },
      propagation: {
        extract(
          context: typeof activeContext,
          headers: Headers,
          getter: { get(carrier: Headers, key: string): string | undefined },
        ) {
          extractions++;
          return createContext(getter.get(headers, "traceparent"));
        },
      },
      trace: {
        getTracer: () => ({ startActiveSpan: () => undefined }),
        getDelegate: () => ({ constructor: { name: "ApplicationTracerProvider" } }),
      },
    };
    const tracer = createFrameworkTracer([openTelemetryTracingIntegration]);

    expect(
      tracer.withPropagatedContext(
        new Headers({ traceparent: "00-remote" }),
        () => activeContext.remote,
      ),
    ).toBe("00-remote");
    let voidCalls = 0;
    tracer.withPropagatedContext(new Headers(), () => {
      voidCalls++;
    });
    expect(voidCalls).toBe(1);
    const activeSpan = { isRecording: () => true, spanContext: () => ({}) };
    activeContext = createContext(undefined, activeSpan);
    expect(tracer.withPropagatedContext(new Headers(), () => activeContext.getValue(spanKey))).toBe(
      activeSpan,
    );
    expect(extractions).toBe(2);
  });

  it("extracts a valid W3C traceparent with the registered propagator", () => {
    type TestContext = {
      deleteValue(key: symbol): TestContext;
      getValue(key: symbol): unknown;
      setValue(key: symbol, value: unknown): TestContext;
    };
    type TestSpanContext = {
      isRemote?: boolean;
      spanId: string;
      traceFlags: number;
      traceId: string;
    };
    const requireFromSentry = createRequire(import.meta.resolve("@sentry/nextjs/package.json"));
    const { ROOT_CONTEXT } = requireFromSentry("@opentelemetry/api") as {
      ROOT_CONTEXT: TestContext;
    };
    const { W3CTraceContextPropagator } = requireFromSentry("@opentelemetry/core") as {
      W3CTraceContextPropagator: new () => {
        extract(
          context: TestContext,
          carrier: Headers,
          getter: {
            get(carrier: Headers, key: string): string | undefined;
            keys(carrier: Headers): string[];
          },
        ): TestContext;
      };
    };
    const propagator = new W3CTraceContextPropagator();
    const spanKey = Symbol.for("OpenTelemetry Context Key SPAN");
    let activeContext = ROOT_CONTEXT;
    (globalThis as Record<symbol, unknown>)[apiSymbol] = {
      context: {
        active: () => activeContext,
        with<T>(context: TestContext, callback: () => T): T {
          const previous = activeContext;
          activeContext = context;
          try {
            return callback();
          } finally {
            activeContext = previous;
          }
        },
      },
      propagation: {
        extract: (
          context: TestContext,
          carrier: Headers,
          getter: Parameters<typeof propagator.extract>[2],
        ) => propagator.extract(context, carrier, getter),
      },
      trace: {
        getDelegate: () => ({ constructor: { name: "ApplicationTracerProvider" } }),
        getTracer: () => ({ startActiveSpan: () => undefined }),
      },
    };
    const tracer = createFrameworkTracer([openTelemetryTracingIntegration]);
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";

    const extracted = tracer.withPropagatedContext(
      new Headers({ traceparent: `00-${traceId}-${spanId}-01` }),
      () => (activeContext.getValue(spanKey) as { spanContext(): TestSpanContext }).spanContext(),
    );

    expect(extracted).toMatchObject({ isRemote: true, spanId, traceFlags: 1, traceId });
  });

  it("does not extract propagation when the registered provider is disabled", () => {
    const context = {
      deleteValue: () => context,
      getValue: () => undefined,
      setValue: () => context,
    };
    const extract = () => {
      throw new Error("disabled propagation must not run");
    };
    (globalThis as Record<symbol, unknown>)[apiSymbol] = {
      context: { active: () => context, with: () => undefined },
      propagation: { extract },
      trace: {
        getDelegate: () => ({ constructor: { name: "NoopTracerProvider" } }),
        getTracer: () => ({ startActiveSpan: () => undefined }),
      },
    };
    const tracer = createFrameworkTracer([openTelemetryTracingIntegration]);

    expect(tracer.withPropagatedContext(new Headers(), () => "ok")).toBe("ok");
  });

  it("is a cheap no-op when no API or provider is registered", () => {
    delete (globalThis as Record<symbol, unknown>)[apiSymbol];
    delete (globalThis as { require?: unknown }).require;
    const tracer = createFrameworkTracer([openTelemetryTracingIntegration]);
    let calls = 0;

    expect(
      tracer.trace({ type: "BaseServer.handleRequest" }, () => {
        calls++;
        return "ok";
      }),
    ).toBe("ok");
    expect(calls).toBe(1);
  });
});
