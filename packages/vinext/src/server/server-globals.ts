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
import serverConsole from "node:console";
import { getRequestExecutionContext } from "vinext/shims/request-context";

const CACHEABILITY_REQUEST_STATE = Symbol.for("vinext.cacheabilityRequestState");
const PHASE_PRODUCTION_BUILD = "phase-production-build";

type BrowserGlobalName = "window" | "document";

type ConsoleTaskLike = { run: <T>(fn: () => T) => T };

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
 * Remove `console.createTask` when the runtime implementation is inert.
 *
 * workerd's console exposes `createTask` but throws "not implemented" when it
 * is called, and React's development builds call it at module initialization
 * and during rendering (scheduler task tracing). Importing `node:console`
 * above ensures workerd installs the method before we probe it. React already
 * falls back to no task tracing when the method is absent, while a working
 * implementation (Node's task tracer) is left untouched.
 */
function disableInertCreateTask(): void {
  // Some hosts replace the global console after loading `node:console`.
  const runtimeConsole = (
    serverConsole === console ? serverConsole : console
  ) as ConsoleWithCreateTask;
  let existing: unknown;

  try {
    existing = runtimeConsole.createTask;
  } catch {
    clearCreateTask(runtimeConsole);
    return;
  }

  // React uses a truthiness check before calling the method.
  if (!existing) return;
  if (typeof existing !== "function") {
    clearCreateTask(runtimeConsole);
    return;
  }

  try {
    const marker = {};
    const result = (existing as (name: string) => ConsoleTaskLike)("vinext:createTask-probe").run(
      () => marker,
    );
    if (result !== marker) clearCreateTask(runtimeConsole);
  } catch {
    clearCreateTask(runtimeConsole);
  }
}

function clearCreateTask(runtimeConsole: ConsoleWithCreateTask): void {
  const descriptor = Object.getOwnPropertyDescriptor(runtimeConsole, "createTask");
  const cleared = descriptor
    ? descriptor.configurable
      ? Reflect.deleteProperty(runtimeConsole, "createTask")
      : Reflect.defineProperty(runtimeConsole, "createTask", { value: undefined })
    : Reflect.defineProperty(runtimeConsole, "createTask", {
        configurable: true,
        value: undefined,
        writable: true,
      });

  if (!cleared) {
    throw new Error("[vinext] The server runtime exposes an unusable console.createTask method.");
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

  disableInertCreateTask();

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
