/**
 * Shared helper for registering AsyncLocalStorage instances on `globalThis`
 * via `Symbol.for(...)` so that they survive multiple module instances.
 *
 * Why this helper exists
 * ----------------------
 * Vite's multi-environment setup (RSC / SSR / client) and HMR can load a
 * single source module under several different specifiers, producing more
 * than one module instance at runtime. If each instance kept its own
 * module-local `new AsyncLocalStorage()`, request-scoped state would silently
 * fork across instances — `headers()` in one environment wouldn't see what
 * `connection()` registered in another, concurrent requests would stomp each
 * other, etc.
 *
 * The fix every shim was applying inline:
 *
 *   const _ALS_KEY = Symbol.for("vinext.foo.als");
 *   const _g = globalThis as unknown as Record<PropertyKey, unknown>;
 *   const _als = (_g[_ALS_KEY] ??=
 *     new AsyncLocalStorage<T>()) as AsyncLocalStorage<T>;
 *
 * This helper packages that pattern.
 *
 * Cross-bundle singleton property — preserved
 * -------------------------------------------
 * - `Symbol.for(key)` consults the global symbol registry and returns the
 *   same symbol regardless of which module instance calls it.
 * - `globalThis[sym]` is a single slot shared by every module instance.
 * - `??=` only assigns when the slot is empty, so the first caller wins and
 *   every subsequent caller (in any module instance) reads the same ALS.
 *
 * The helper module itself never holds the ALS by reference — it always
 * round-trips through `globalThis`. So even if this helper file is itself
 * loaded under multiple module instances, every copy still hands back the
 * one true ALS for a given key.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const _g = globalThis as unknown as Record<PropertyKey, unknown>;

/**
 * Every ALS handed out by `getOrCreateAls`, so `runOutsideRequestScopes` can
 * exit all of them without an enumeration that goes stale as shims are added.
 * Shares the `globalThis` slot for the same cross-module-instance reason.
 */
const _REGISTRY_KEY = Symbol.for("vinext.als.registry");
const _registry = (_g[_REGISTRY_KEY] ??= new Set()) as Set<AsyncLocalStorage<unknown>>;

/**
 * No-op AsyncLocalStorage used when the runtime does not provide a usable
 * `AsyncLocalStorage` constructor.
 *
 * In browser/client bundles `node:async_hooks` can resolve to a stub without a
 * usable constructor (e.g. Vite's `__vite-browser-external`). Constructing such
 * a value with `new` throws `TypeError: AsyncLocalStorage is not a constructor`
 * at module-eval time, crashing every client-reachable shim that calls
 * `getOrCreateAls` on import (request-context, headers, cache, …).
 *
 * Mirrors Next.js' `FakeAsyncLocalStorage` (and this repo's
 * `async-hooks-stub.ts` client virtual module): `getStore()` returns
 * `undefined` so shims fall back to their non-ALS code path, and the mutating
 * methods are best-effort no-ops that still invoke the callback.
 * See: https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/async-local-storage.ts
 */
class NoopAsyncLocalStorage<T> {
  getStore(): T | undefined {
    return undefined;
  }
  run<R>(_store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    return fn(...args);
  }
  exit<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    return fn(...args);
  }
  enterWith(_store: T): void {}
  disable(): void {}
}

/**
 * Get (or lazily create) the AsyncLocalStorage registered on `globalThis`
 * under `Symbol.for(key)`. Multiple callers — including callers in different
 * module instances — that pass the same `key` receive the same ALS instance.
 *
 * @param key - String key fed to `Symbol.for(...)`. By convention vinext
 *   shims use a dotted namespace such as `"vinext.cache.als"`.
 */
export function getOrCreateAls<T>(key: string): AsyncLocalStorage<T> {
  const sym = Symbol.for(key);
  const als = (_g[sym] ??=
    typeof AsyncLocalStorage === "function"
      ? new AsyncLocalStorage<T>()
      : new NoopAsyncLocalStorage<T>()) as AsyncLocalStorage<T>;
  _registry.add(als as AsyncLocalStorage<unknown>);
  return als;
}

/**
 * Enrol an ALS that is *not* created through `getOrCreateAls` into the
 * scope-exit set. For stores that must stay module-local for identity reasons
 * (`workUnitAsyncStorage` is a Next.js-compat external module third parties
 * resolve by specifier) but still hold per-request state.
 *
 * Callers register themselves rather than being imported here, so this module
 * keeps importing nothing but `node:async_hooks` and stays safe to evaluate in
 * client bundles where that resolves to a constructor-less stub.
 */
export function registerAlsForScopeExit(als: AsyncLocalStorage<never>): void {
  _registry.add(als as unknown as AsyncLocalStorage<unknown>);
}

/**
 * Run `fn` — and every async continuation it starts — outside every
 * request-scoped AsyncLocalStorage vinext installs, so the callback observes no
 * request at all.
 *
 * For one-time module evaluation whose result is cached for the isolate's
 * lifetime: a dynamic `import()` propagates ALS into the imported module's
 * top-level evaluation, so without this the first request to reach a route
 * leaks into module scope and stays there for every request after it.
 *
 * Exiting a single store is not enough. The stores are entered at different
 * depths — the Cloudflare entry enters the standalone execution-context ALS
 * *outside* the unified request context, and prerendering enters the work-unit
 * store *inside* it — so anything left entered stays visible. `after()` in
 * particular takes its `getRequestExecutionContext()` fallback precisely when
 * the unified store is absent, so a partial exit would enable that path rather
 * than close it.
 */
export function runOutsideRequestScopes<T>(fn: () => T): T {
  let run = fn;
  for (const als of _registry) {
    const inner = run;
    run = () => als.exit(inner);
  }
  return run();
}
