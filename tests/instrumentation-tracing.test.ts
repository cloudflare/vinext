import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  FrameworkTracingBackendSpan,
  ResolvedFrameworkSpanDescriptor,
} from "../packages/vinext/src/server/framework-tracer.js";
import { ensureInstrumentationRegistered } from "../packages/vinext/src/server/instrumentation-runtime.js";
import { runInstrumentation } from "../packages/vinext/src/server/instrumentation.js";
import { extendTracerProviderForCacheComponents } from "../packages/vinext/src/server/otel-tracer-extension.js";
import { registerFrameworkTracingIntegration } from "../packages/vinext/src/server/tracer.js";

// Ported from Next.js: test/e2e/app-dir/otel-middleware-trace/otel-middleware-trace.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/otel-middleware-trace/otel-middleware-trace.test.ts
// ("traces instrumentation registration in the triggering request": `next
// start` registers `instrumentation.ts` outside of any request, so its
// lifecycle spans are roots). Next.js source:
// packages/next/src/server/lib/router-utils/instrumentation-globals.external.ts

type RecordedSpan = {
  descriptor: ResolvedFrameworkSpanDescriptor;
  detached: boolean;
  errors: unknown[];
  status?: string;
};

vi.mock("../packages/vinext/src/server/otel-tracer-extension.js", () => ({
  extendTracerProviderForCacheComponents: vi.fn(),
}));

const context = new AsyncLocalStorage<{ detached: boolean }>();
const spans: RecordedSpan[] = [];
let failSpans = false;
let onSpanEnd: ((descriptor: ResolvedFrameworkSpanDescriptor) => void) | undefined;

registerFrameworkTracingIntegration({
  id: "instrumentation-tracing-test",
  runWithDetachedContext: (callback) => context.run({ detached: true }, callback),
  enterSpan<T>(
    descriptor: ResolvedFrameworkSpanDescriptor,
    callback: (span: FrameworkTracingBackendSpan) => T,
  ): T {
    const recorded: RecordedSpan = {
      descriptor,
      detached: context.getStore()?.detached ?? false,
      errors: [],
    };
    spans.push(recorded);
    if (failSpans) throw new Error("exporter failed");
    try {
      return callback({
        recordException: (error) => recorded.errors.push(error),
        setAttribute() {},
        setErrorStatus: (message) => {
          recorded.status = message ?? "error";
        },
      });
    } finally {
      // Like OTel span processors, which run synchronously in span.end().
      onSpanEnd?.(descriptor);
    }
  },
});

afterEach(() => {
  spans.length = 0;
  onSpanEnd = undefined;
  failSpans = false;
  vi.restoreAllMocks();
  vi.mocked(extendTracerProviderForCacheComponents).mockReset();
});

function lifecycleSpans() {
  return spans.filter(({ descriptor }) => descriptor.type.startsWith("Instrumentation."));
}

describe("instrumentation lifecycle spans", () => {
  it("emits the load and register spans as roots once register() returns", async () => {
    let spansDuringRegister = -1;
    const instrumentation = {
      register() {
        spansDuringRegister = lifecycleSpans().length;
      },
    };
    const loadTiming = { startTime: 1_000, endTime: 1_250 };

    await ensureInstrumentationRegistered(instrumentation, undefined, loadTiming);
    await ensureInstrumentationRegistered(instrumentation, undefined, loadTiming);

    // register() commonly installs the tracer provider, so nothing is emitted
    // before it returns.
    expect(spansDuringRegister).toBe(0);
    const recorded = lifecycleSpans();
    expect(
      recorded.map(({ descriptor, detached }) => [descriptor.name, descriptor.type, detached]),
    ).toEqual([
      ["load instrumentation module", "Instrumentation.loadModule", true],
      ["register instrumentation", "Instrumentation.register", true],
    ]);
    expect(recorded[0]?.descriptor).toMatchObject(loadTiming);
    const register = recorded[1]?.descriptor;
    expect(register?.startTime).toBeGreaterThanOrEqual(loadTiming.endTime);
    expect(register?.endTime).toBeGreaterThanOrEqual(register?.startTime ?? Infinity);
  });

  it("records a failing register() on its span", async () => {
    const failure = new Error("register failed");
    const instrumentation = {
      register() {
        throw failure;
      },
    };

    await expect(ensureInstrumentationRegistered(instrumentation)).rejects.toBe(failure);

    expect(
      lifecycleSpans().map(({ descriptor, errors, status }) => [descriptor.type, errors, status]),
    ).toEqual([
      ["Instrumentation.loadModule", [], undefined],
      [
        "Instrumentation.register",
        [failure],
        "An error occurred while loading instrumentation hook: register failed",
      ],
    ]);
  });

  it("emits only the load span without register()", async () => {
    await ensureInstrumentationRegistered({});

    expect(lifecycleSpans().map(({ descriptor }) => descriptor.type)).toEqual([
      "Instrumentation.loadModule",
    ]);
  });

  it("times the tracer provider extension as part of register()", async () => {
    const failure = new Error("extension failed");
    let registered = false;
    vi.mocked(extendTracerProviderForCacheComponents).mockImplementation(() => {
      expect(registered).toBe(true);
      // Nothing is emitted before registration completes.
      expect(lifecycleSpans()).toEqual([]);
      throw failure;
    });
    const instrumentation = {
      register() {
        registered = true;
      },
    };

    await expect(ensureInstrumentationRegistered(instrumentation)).rejects.toBe(failure);

    expect(
      lifecycleSpans().map(({ descriptor, errors, status }) => [descriptor.type, errors, status]),
    ).toEqual([
      ["Instrumentation.loadModule", [], undefined],
      [
        "Instrumentation.register",
        [failure],
        "An error occurred while loading instrumentation hook: extension failed",
      ],
    ]);
  });

  it("emits a failed load span when importing the module throws", async () => {
    const failure = new Error("import failed");
    const runner = { import: () => Promise.reject(failure) };

    await expect(runInstrumentation(runner, "/app/instrumentation.ts")).rejects.toBe(failure);

    const recorded = lifecycleSpans();
    expect(
      recorded.map(({ descriptor, detached, errors, status }) => [
        descriptor.type,
        detached,
        errors,
        status,
      ]),
    ).toEqual([["Instrumentation.loadModule", true, [failure], "import failed"]]);
    expect(recorded[0]?.descriptor.endTime).toBeGreaterThanOrEqual(
      recorded[0]?.descriptor.startTime ?? Infinity,
    );
  });

  it("ends the register span before emitting the lifecycle spans", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const instrumentation = {
      register() {
        clock += 10;
      },
    };
    // Exporting the load span takes time of its own.
    onSpanEnd = (descriptor) => {
      if (descriptor.type === "Instrumentation.loadModule") clock += 1_000;
    };

    await ensureInstrumentationRegistered(instrumentation);

    const register = lifecycleSpans().find(
      ({ descriptor }) => descriptor.type === "Instrumentation.register",
    )?.descriptor;
    expect((register?.endTime ?? 0) - (register?.startTime ?? 0)).toBe(10);
  });

  it("keeps a throwing tracing integration from changing how registration ends", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    failSpans = true;
    const failure = new Error("register failed");
    await expect(
      ensureInstrumentationRegistered({
        register() {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    // Without register(), registration still completes.
    const onRequestError = vi.fn();
    await expect(ensureInstrumentationRegistered({ onRequestError })).resolves.toBeUndefined();
    expect(globalThis.__VINEXT_onRequestErrorHandler__).toBe(onRequestError);
    expect(consoleError).toHaveBeenCalled();
  });
});
