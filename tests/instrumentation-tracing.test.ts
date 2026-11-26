import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type {
  FrameworkTracingBackendSpan,
  ResolvedFrameworkSpanDescriptor,
} from "../packages/vinext/src/server/framework-tracer.js";
import { ensureInstrumentationRegistered } from "../packages/vinext/src/server/instrumentation-runtime.js";
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

const context = new AsyncLocalStorage<{ detached: boolean }>();
const spans: RecordedSpan[] = [];

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
    return callback({
      recordException: (error) => recorded.errors.push(error),
      setAttribute() {},
      setErrorStatus: (message) => {
        recorded.status = message ?? "error";
      },
    });
  },
});

afterEach(() => {
  spans.length = 0;
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
      ["Instrumentation.register", [failure], "register failed"],
    ]);
  });

  it("emits only the load span without register()", async () => {
    await ensureInstrumentationRegistered({});

    expect(lifecycleSpans().map(({ descriptor }) => descriptor.type)).toEqual([
      "Instrumentation.loadModule",
    ]);
  });
});
