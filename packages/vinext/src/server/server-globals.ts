/**
 * Server runtime global setup shared by vinext's generated server entries.
 *
 * This module intentionally runs its installer at import time. Generated entry
 * modules import user pages and layouts as static dependencies, so any global
 * correction that must happen before user module evaluation has to live in a
 * side-effect dependency. A runtime function call from the generated entry
 * body would run after static user imports have already evaluated.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getRequestExecutionContext } from "vinext/shims/request-context";

const CACHEABILITY_REQUEST_STATE = Symbol.for("vinext.cacheabilityRequestState");
const PHASE_PRODUCTION_BUILD = "phase-production-build";

type BrowserGlobalName = "window" | "document";

type ConsoleTaskLike = { name: string; run: <T>(fn: () => T) => T };

type ConsoleWithCreateTask = typeof console & {
  createTask?: unknown;
};

function clearBrowserGlobal(name: BrowserGlobalName): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);

  if (!descriptor && typeof Reflect.get(globalThis, name) === "undefined") return;

  if (!descriptor) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: undefined,
      writable: true,
    });
  } else if (descriptor.configurable) {
    Reflect.deleteProperty(globalThis, name);
  } else {
    Reflect.set(globalThis, name, undefined);
  }

  if (typeof Reflect.get(globalThis, name) !== "undefined") {
    throw new Error(
      `[vinext] Server runtime exposes a non-removable \`${name}\` global. ` +
        "This breaks Next.js SSR semantics where browser globals must be absent.",
    );
  }
}

/**
 * Fall back to a synchronous passthrough when `console.createTask` is inert.
 *
 * workerd's console exposes `createTask` but throws "not implemented" when it
 * is called, and React's development builds call it at module initialization
 * and during rendering (scheduler task tracing). The combination crashes every
 * server environment on Workers, so probe the runtime implementation once and
 * replace it with a passthrough when it cannot execute. A working
 * implementation (Node's task tracer) is left untouched.
 */
function installCreateTaskFallback(): void {
  const existing = (console as ConsoleWithCreateTask).createTask;
  if (typeof existing !== "function") return;

  try {
    (existing as (name: string) => ConsoleTaskLike)("vinext:createTask-probe").run(() => {});
  } catch {
    (console as ConsoleWithCreateTask).createTask = (name: string): ConsoleTaskLike => ({
      name,
      run: (fn) => fn(),
    });
  }
}

export function installServerGlobals(): void {
  clearBrowserGlobal("window");
  clearBrowserGlobal("document");

  // Next.js's edge sandbox exposes AsyncLocalStorage as a global. Cloudflare
  // Workers exposes it via node:async_hooks under nodejs_compat, so mirror the
  // global binding for user code written against Next.js's runtime.
  if (typeof Reflect.get(globalThis, "AsyncLocalStorage") === "undefined") {
    Object.defineProperty(globalThis, "AsyncLocalStorage", {
      configurable: true,
      value: AsyncLocalStorage,
      writable: true,
    });
  }

  installCreateTaskFallback();

  const nextPhaseDescriptor = Object.getOwnPropertyDescriptor(globalThis, "__VINEXT_NEXT_PHASE");
  if (!nextPhaseDescriptor || nextPhaseDescriptor.configurable) {
    Object.defineProperty(globalThis, "__VINEXT_NEXT_PHASE", {
      configurable: true,
      get() {
        const context = getRequestExecutionContext();
        const state = context ? Reflect.get(context, CACHEABILITY_REQUEST_STATE) : undefined;
        if (
          context?.isPrerenderPathDiscovery === true ||
          Reflect.get(state ?? {}, "mode") === "probe"
        ) {
          return PHASE_PRODUCTION_BUILD;
        }
        return Reflect.get(process.env, "NEXT_PHASE");
      },
    });
  }
}

installServerGlobals();
