/**
 * OpenTelemetry tracer provider extension for Cache Components.
 *
 * When `cacheComponents: true` is enabled in next.config, component renders
 * go through multiple phases (warmup → resume). During these phases, the
 * `workUnitAsyncStorage` carries a prerender or cache store. Without this
 * extension, calls to `tracer.startSpan()` / `tracer.startActiveSpan()` from
 * inside user RSC code would inherit that prerender context, causing:
 *
 *  1. Spans to reuse the same trace ID across requests (the frozen prerender
 *     context bleeds into the runtime resume render).
 *  2. Spans not being created at all during fallback resume (the work unit
 *     context gates span creation in some OTel SDK implementations).
 *
 * The fix mirrors Next.js's `instrumentation-node-extensions.ts`:
 *  - Wrap `tracer.startSpan` to exit `workUnitAsyncStorage` before creating
 *    the span, ensuring a clean context for span ID generation.
 *  - Wrap `tracer.startActiveSpan` similarly and re-enter the work unit store
 *    for the callback, so that the callback runs with the correct request
 *    context restored.
 *
 * This extension is intentionally a no-op when:
 *  - `@opentelemetry/api` is not installed (graceful degradation).
 *  - No OTel tracer provider has been registered (provider is the noop provider).
 *  - `workUnitAsyncStorage` has no active store (non-render contexts).
 *
 * References:
 *  - packages/next/src/server/lib/router-utils/instrumentation-node-extensions.ts
 *  - https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/router-utils/instrumentation-node-extensions.ts
 */

import { workUnitAsyncStorage } from "vinext/shims/internal/work-unit-async-storage";

// Keep track of tracers we have already wrapped to avoid double-wrapping on
// repeated calls (e.g. hot-module replacement in dev).
let tracerProviderExtended = false;

/**
 * Extend the registered OTel tracer provider so that `startSpan` and
 * `startActiveSpan` exit the `workUnitAsyncStorage` context before creating
 * spans. This prevents the prerender/cache work unit store from leaking into
 * span ID generation during Cache Component fallback resumes.
 *
 * Safe to call multiple times — subsequent calls are no-ops once the provider
 * has been wrapped.
 *
 * Must only be called in Node.js environments (not Edge runtime).
 */
export function extendTracerProviderForCacheComponents(): void {
  if (tracerProviderExtended) return;

  let api: {
    trace: {
      getTracerProvider(): {
        getTracer: (...args: unknown[]) => unknown;
      };
    };
  };

  try {
    // Prefer the user's installed @opentelemetry/api so that the tracer
    // instance matches the one used by the rest of their telemetry pipeline.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    api = require("@opentelemetry/api");
  } catch {
    // @opentelemetry/api is not installed — OTel is not in use; no-op.
    return;
  }

  const provider = api.trace.getTracerProvider();
  if (!provider || typeof provider.getTracer !== "function") return;

  // Mark as extended before patching to guard against re-entrant calls.
  tracerProviderExtended = true;

  const originalGetTracer = provider.getTracer.bind(provider);
  // Track wrapped tracer instances so we never double-wrap.
  const wrappedTracers = new WeakSet<object>();

  provider.getTracer = (...args: unknown[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tracer = (originalGetTracer as (...a: unknown[]) => any)(...args);
    if (!tracer || wrappedTracers.has(tracer as object)) {
      return tracer;
    }

    const originalStartSpan = tracer.startSpan;
    if (typeof originalStartSpan === "function") {
      tracer.startSpan = (...startSpanArgs: unknown[]) =>
        workUnitAsyncStorage.exit(() =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (originalStartSpan as (...a: unknown[]) => any).apply(tracer, startSpanArgs),
        );
    }

    const originalStartActiveSpan = tracer.startActiveSpan;
    if (typeof originalStartActiveSpan === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tracer.startActiveSpan = (...startActiveSpanArgs: any[]) => {
        const workUnitStore = workUnitAsyncStorage.getStore();
        if (!workUnitStore) {
          // Not inside a work unit context — forward unchanged.
          return (originalStartActiveSpan as (...a: unknown[]) => unknown).apply(
            tracer,
            startActiveSpanArgs,
          );
        }

        // Determine which positional argument is the user's callback.
        // startActiveSpan has these overloads:
        //   startActiveSpan(name, fn)
        //   startActiveSpan(name, options, fn)
        //   startActiveSpan(name, options, context, fn)
        let fnIdx = 0;
        if (startActiveSpanArgs.length === 2 && typeof startActiveSpanArgs[1] === "function") {
          fnIdx = 1;
        } else if (
          startActiveSpanArgs.length === 3 &&
          typeof startActiveSpanArgs[2] === "function"
        ) {
          fnIdx = 2;
        } else if (startActiveSpanArgs.length > 3 && typeof startActiveSpanArgs[3] === "function") {
          fnIdx = 3;
        }

        if (fnIdx > 0) {
          const originalFn = startActiveSpanArgs[fnIdx];
          // Re-enter the work unit store inside the callback so that the
          // callback runs with the correct request context (e.g. headers(),
          // cookies(), io() work correctly inside the span body).
          startActiveSpanArgs[fnIdx] = (...cbArgs: unknown[]) =>
            workUnitAsyncStorage.run(workUnitStore, originalFn, ...cbArgs);
        }

        // Exit the work unit context when creating the span so the span ID is
        // generated fresh and not tainted by the prerender/cache work unit.
        return workUnitAsyncStorage.exit(() =>
          (originalStartActiveSpan as (...a: unknown[]) => unknown).apply(
            tracer,
            startActiveSpanArgs,
          ),
        );
      };
    }

    wrappedTracers.add(tracer as object);
    return tracer;
  };
}
