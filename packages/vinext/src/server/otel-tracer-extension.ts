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

// Track which provider objects have already been extended so that if the
// registered provider is swapped out (e.g. during testing or HMR), the new
// provider gets wrapped.  Using a WeakSet mirrors the upstream approach for
// per-tracer deduplication and is safer than a module-level boolean which
// would leave a replaced provider unwrapped forever.
const extendedProviders = new WeakSet<object>();

// Symbol used by registerCachedFunction (cache-runtime.ts) to tag "use cache"
// wrapper functions.  Keeping the check inline here avoids importing the full
// cache-runtime module (which carries many heavy deps) into this lightweight
// server helper.
const USE_CACHE_FUNCTION_SYMBOL = Symbol.for("vinext.useCacheFunction");

function isUseCacheFn(fn: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof fn === "function" && (fn as any)[USE_CACHE_FUNCTION_SYMBOL] === true;
}

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
  let api:
    | {
        trace: {
          getTracerProvider(): {
            getTracer: (...args: unknown[]) => unknown;
          };
        };
      }
    | undefined;

  try {
    // Use globalThis.require so the call is safe in ESM Worker bundles where
    // bare `require` is undefined.  This matches the pattern used by
    // client-trace-metadata.ts for the same optional dependency.
    const req = (globalThis as { require?: (id: string) => unknown }).require;
    if (typeof req === "function") {
      api = req("@opentelemetry/api") as typeof api;
    }
  } catch {
    // @opentelemetry/api is not installed — OTel is not in use; no-op.
    return;
  }

  if (!api) return;

  const provider = api.trace.getTracerProvider();
  if (!provider || typeof provider.getTracer !== "function") return;

  // Already extended this exact provider object — skip.
  if (extendedProviders.has(provider as object)) return;
  extendedProviders.add(provider as object);

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
          // Warn when the user passes a "use cache" function directly to
          // startActiveSpan.  A cached function receives a Span argument on
          // every invocation which means the argument changes every time the
          // span is created, leading to cache misses on every call.  This
          // mirrors the upstream warning in instrumentation-node-extensions.ts.
          if (isUseCacheFn(originalFn)) {
            console.error(
              "A Cache Function (`use cache`) was passed to startActiveSpan which means it will receive a Span argument with a possibly random ID on every invocation leading to cache misses. Provide a wrapping function around the Cache Function that does not forward the Span argument to avoid this issue.",
            );
          }
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
