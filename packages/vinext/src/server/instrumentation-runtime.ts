/**
 * Idempotent instrumentation initialisation.
 *
 * Generated production entries call this before evaluating user route,
 * middleware, and boundary modules. Request handlers call it again so
 * development and split-stage entry points keep the same guarantee. Keeping
 * the shared-promise bookkeeping here leaves generated entries as wiring and
 * makes concurrent initialization directly testable.
 *
 * ## Why idempotent?
 *
 * The same handler may be invoked concurrently (e.g. on a warm Worker).
 * Process-wide state keyed by the imported instrumentation module, plus a
 * shared promise, ensures that `register()` is called exactly once even when
 * multiple requests or bundled runtime copies race. Keying by module avoids
 * suppressing registration for another app loaded in the same process.
 *
 * ## Next.js semantics
 *
 * Next.js calls `register()` once before user server modules are evaluated and
 * before request handling. Production entries await this helper from a cached
 * request-time initializer before dynamically importing those user modules.
 *
 * References:
 * - https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

import type { OnRequestErrorHandler } from "./instrumentation.js";
import { recordFrameworkSpanError } from "./framework-tracer.js";
import { extendTracerProviderForCacheComponents } from "./otel-tracer-extension.js";
import { frameworkTracer } from "./tracer.js";

/** When loading the instrumentation module started and finished (epoch milliseconds). */
export type InstrumentationLoadTiming = {
  endTime: number;
  startTime: number;
};

function getInstrumentationTimestamp(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * Emits a lifecycle span of `instrumentation.ts` after the fact, as Next.js
 * does (`traceBackdatedInstrumentationSpan` in
 * server/lib/router-utils/instrumentation-globals.external.ts): `register()`
 * commonly installs the tracer provider, so the spans can only be emitted
 * once it returns, with their original timestamps. Like `next start`, which
 * registers at startup, they are emitted outside of any request's trace.
 */
function traceInstrumentationLifecycleSpan(
  type: "Instrumentation.loadModule" | "Instrumentation.register",
  name: string,
  timing: InstrumentationLoadTiming,
  error?: unknown,
): void {
  // Telemetry must not change how registration ends: a throwing tracing
  // integration would otherwise replace register()'s own error, or reject the
  // one-shot registration for every later request.
  try {
    frameworkTracer.runWithDetachedContext(() =>
      frameworkTracer.trace(
        { endTime: timing.endTime, name, recordErrors: false, startTime: timing.startTime, type },
        (span) => {
          if (error !== undefined) recordFrameworkSpanError(span, error);
        },
      ),
    );
  } catch (traceError) {
    console.error(`[vinext] Failed to emit the ${type} span:`, traceError);
  }
}

/**
 * Emits the failed `load instrumentation module` span when importing
 * `instrumentation.ts` threw. Like Next.js, it is only exported when a tracer
 * provider was already installed, since `register()` never ran.
 */
export function traceInstrumentationModuleLoadError(
  timing: InstrumentationLoadTiming,
  error: unknown,
): void {
  traceInstrumentationLifecycleSpan(
    "Instrumentation.loadModule",
    "load instrumentation module",
    timing,
    error,
  );
}

type InstrumentationState = {
  initialized: boolean;
  initPromise: Promise<void> | null;
};

type InstrumentationStates = {
  byId: Map<string, InstrumentationState>;
  byModule: WeakMap<Record<string, unknown>, InstrumentationState>;
};

const INSTRUMENTATION_STATE_KEY = Symbol.for("vinext.instrumentation.state");

function getInstrumentationState(
  instrumentationModule: Record<string, unknown>,
  instrumentationId: string | undefined,
): InstrumentationState {
  const globals = globalThis as typeof globalThis & {
    [INSTRUMENTATION_STATE_KEY]?: InstrumentationStates;
  };
  const states = (globals[INSTRUMENTATION_STATE_KEY] ??= {
    byId: new Map(),
    byModule: new WeakMap(),
  });
  const existing = instrumentationId
    ? states.byId.get(instrumentationId)
    : states.byModule.get(instrumentationModule);
  if (existing) return existing;
  const state = {
    initialized: false,
    initPromise: null,
  };
  if (instrumentationId) states.byId.set(instrumentationId, state);
  else states.byModule.set(instrumentationModule, state);
  return state;
}

function isOnRequestErrorHandler(value: unknown): value is OnRequestErrorHandler {
  return typeof value === "function";
}

/**
 * Ensure the instrumentation module's `register()` and `onRequestError`
 * hooks have been applied exactly once.
 *
 * After `register()` runs, we extend the OTel tracer provider so that spans
 * created inside Cache Component renders (warmup / fallback-resume phases) use
 * a fresh OTel context rather than inheriting the prerender work unit store.
 * This mirrors Next.js's `afterRegistration()` call in
 * `instrumentation-node-extensions.ts`.
 *
 * @param instrumentationModule - The imported `instrumentation.ts` module.
 *   Passed as an argument so the generated entry can import it normally
 *   without this helper needing to know the module path.
 * @param instrumentationId - Stable source path used to deduplicate the same
 *   instrumentation file when Vite evaluates it in separate environments.
 * @param loadTiming - When importing the module started and finished, when the
 *   caller imported it itself. Generated server entries import it statically,
 *   so it was evaluated with the entry and its load has no separate duration.
 */
export async function ensureInstrumentationRegistered(
  instrumentationModule: Record<string, unknown>,
  instrumentationId?: string,
  loadTiming?: InstrumentationLoadTiming,
): Promise<void> {
  if (process.env.VINEXT_PRERENDER === "1") return;
  const state = getInstrumentationState(instrumentationModule, instrumentationId);
  if (state.initialized) return;
  if (state.initPromise) return state.initPromise;

  state.initPromise = (async () => {
    const loadedAt = getInstrumentationTimestamp();
    const moduleLoadTiming = loadTiming ?? { startTime: loadedAt, endTime: loadedAt };
    if (typeof instrumentationModule.register === "function") {
      const startTime = getInstrumentationTimestamp();
      let error: unknown;
      try {
        await instrumentationModule.register();
        // Extend the OTel tracer provider so that span creation inside Cache
        // Component renders exits the workUnitAsyncStorage context. Without
        // this, spans created during prerender / fallback-resume phases would
        // inherit the frozen prerender work unit store, causing span IDs to be
        // reused across requests or not generated at all. Like Next.js's
        // afterRegistration() (instrumentation-node-extensions.ts), it is part
        // of the timed registration.
        extendTracerProviderForCacheComponents();
      } catch (err) {
        // Like Next.js, name the failing hook on the error it records and throws.
        if (err instanceof Error) {
          err.message = `An error occurred while loading instrumentation hook: ${err.message}`;
        }
        error = err;
        throw err;
      } finally {
        // Before emitting: span processors run synchronously in span.end().
        const endTime = getInstrumentationTimestamp();
        traceInstrumentationLifecycleSpan(
          "Instrumentation.loadModule",
          "load instrumentation module",
          moduleLoadTiming,
        );
        traceInstrumentationLifecycleSpan(
          "Instrumentation.register",
          "register instrumentation",
          { startTime, endTime },
          error,
        );
      }
    } else {
      traceInstrumentationLifecycleSpan(
        "Instrumentation.loadModule",
        "load instrumentation module",
        moduleLoadTiming,
      );
      extendTracerProviderForCacheComponents();
    }

    // Store the onRequestError handler on globalThis so it is visible to
    // reportRequestError() regardless of which Vite environment module graph
    // it is called from. With @vitejs/plugin-rsc the RSC and SSR environments
    // run in the same Node.js process and share globalThis. With
    // @cloudflare/vite-plugin everything runs inside the Worker so globalThis
    // is the Worker's global — also correct.
    if (isOnRequestErrorHandler(instrumentationModule.onRequestError)) {
      globalThis.__VINEXT_onRequestErrorHandler__ = instrumentationModule.onRequestError;
    }

    state.initialized = true;
  })();

  return state.initPromise;
}
