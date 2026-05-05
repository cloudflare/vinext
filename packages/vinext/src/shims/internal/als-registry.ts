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
 * Get (or lazily create) the AsyncLocalStorage registered on `globalThis`
 * under `Symbol.for(key)`. Multiple callers — including callers in different
 * module instances — that pass the same `key` receive the same ALS instance.
 *
 * @param key - String key fed to `Symbol.for(...)`. By convention vinext
 *   shims use a dotted namespace such as `"vinext.cache.als"`.
 */
export function getOrCreateAls<T>(key: string): AsyncLocalStorage<T> {
  const sym = Symbol.for(key);
  return (_g[sym] ??= new AsyncLocalStorage<T>()) as AsyncLocalStorage<T>;
}
