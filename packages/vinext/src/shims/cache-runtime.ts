/**
 * "use cache" runtime
 *
 * This module provides the runtime for "use cache" directive support.
 * Functions marked with "use cache" are transformed by the vinext:use-cache
 * Vite plugin to wrap them with `registerCachedFunction()`.
 *
 * The runtime:
 * 1. Generates a cache key from function identity + serialized arguments
 * 2. Checks the CacheHandler for a cached value
 * 3. On HIT: returns the cached value (deserialized)
 * 4. On MISS: creates an AsyncLocalStorage context for cacheLife/cacheTag,
 *    calls the original function, collects metadata, stores the result
 *
 * Cache variants:
 * - "use cache"           — shared cache (default profile)
 * - "use cache: remote"   — shared cache (explicit)
 * - "use cache: private"  — per-request cache (not shared across requests)
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getCacheHandler, cacheLifeProfiles, _registerCacheContextAccessor, type CacheLifeConfig } from "./cache.js";

// ---------------------------------------------------------------------------
// Cache execution context — AsyncLocalStorage for cacheLife/cacheTag
// ---------------------------------------------------------------------------

export interface CacheContext {
  /** Tags collected via cacheTag() during execution */
  tags: string[];
  /** Cache life configs collected via cacheLife() — minimum-wins rule applies */
  lifeConfigs: CacheLifeConfig[];
  /** Cache variant: "default" | "remote" | "private" */
  variant: string;
}

export const cacheContextStorage = new AsyncLocalStorage<CacheContext>();

// Register the context accessor so cacheLife()/cacheTag() in cache.ts can
// access the context without a circular import.
_registerCacheContextAccessor(() => cacheContextStorage.getStore() ?? null);

/**
 * Get the current cache context. Returns null if not inside a "use cache" function.
 */
export function getCacheContext(): CacheContext | null {
  return cacheContextStorage.getStore() ?? null;
}

// ---------------------------------------------------------------------------
// Minimum-wins resolution for cacheLife
// ---------------------------------------------------------------------------

/**
 * Resolve collected cacheLife configs into a single effective config.
 * The "minimum-wins" rule: if multiple cacheLife() calls are made,
 * each field takes the smallest value across all calls.
 */
function resolveCacheLife(configs: CacheLifeConfig[]): CacheLifeConfig {
  if (configs.length === 0) {
    // Default profile
    return { ...cacheLifeProfiles.default };
  }

  if (configs.length === 1) {
    return { ...configs[0] };
  }

  // Minimum-wins across all fields
  const result: CacheLifeConfig = {};

  for (const config of configs) {
    if (config.stale !== undefined) {
      result.stale = result.stale !== undefined
        ? Math.min(result.stale, config.stale)
        : config.stale;
    }
    if (config.revalidate !== undefined) {
      result.revalidate = result.revalidate !== undefined
        ? Math.min(result.revalidate, config.revalidate)
        : config.revalidate;
    }
    if (config.expire !== undefined) {
      result.expire = result.expire !== undefined
        ? Math.min(result.expire, config.expire)
        : config.expire;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Private per-request cache for "use cache: private"
// ---------------------------------------------------------------------------

const privateRequestCache = new Map<string, unknown>();

/**
 * Clear the private per-request cache. Should be called at the start of each request.
 */
export function clearPrivateCache(): void {
  privateRequestCache.clear();
}

// ---------------------------------------------------------------------------
// Core runtime: registerCachedFunction
// ---------------------------------------------------------------------------

/**
 * Register a function as a cached function. This is called by the Vite
 * transform for each "use cache" function.
 *
 * @param fn - The original async function
 * @param id - A stable identifier for the function (module path + export name)
 * @param variant - Cache variant: "" (default/shared), "remote", "private"
 * @returns A wrapper function that checks cache before calling the original
 */
export function registerCachedFunction<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  id: string,
  variant?: string,
): T {
  const cacheVariant = variant ?? "";

  const cachedFn = async (...args: any[]): Promise<any> => {
    // Build the cache key.  If the arguments contain non-serializable values
    // (React elements, functions, Symbols, circular references, etc.) we skip
    // caching entirely and just run the function directly.  This keeps
    // "use cache" on component functions (which return JSX) harmless.
    let cacheKey: string;
    try {
      const argsKey = args.length > 0 ? ":" + stableStringify(args) : "";
      cacheKey = `use-cache:${id}${argsKey}`;
    } catch {
      // Non-serializable arguments — run without caching
      return fn(...args);
    }

    // "use cache: private" uses per-request in-memory cache
    if (cacheVariant === "private") {
      const privateHit = privateRequestCache.get(cacheKey);
      if (privateHit !== undefined) {
        return privateHit;
      }

      const result = await executeWithContext(fn, args, cacheVariant);
      privateRequestCache.set(cacheKey, result);
      return result;
    }

    // Shared cache ("use cache" / "use cache: remote")
    const handler = getCacheHandler();

    // Check cache
    const existing = await handler.get(cacheKey, { kind: "FETCH" });
    if (existing?.value && existing.value.kind === "FETCH" && existing.cacheState !== "stale") {
      try {
        return JSON.parse(existing.value.data.body);
      } catch {
        // Corrupted entry, fall through to re-execute
      }
    }

    // Cache miss (or stale) — execute with context
    const ctx: CacheContext = {
      tags: [],
      lifeConfigs: [],
      variant: cacheVariant || "default",
    };

    const result = await cacheContextStorage.run(ctx, () => fn(...args));

    // Resolve effective cache life from collected configs
    const effectiveLife = resolveCacheLife(ctx.lifeConfigs);
    const revalidateSeconds = effectiveLife.revalidate ?? cacheLifeProfiles.default.revalidate ?? 900;

    // Store in cache — skip if the result is a React element or otherwise
    // not safely JSON-serializable.  React elements have a $$typeof Symbol
    // that JSON.stringify silently drops, producing corrupt data on parse-back.
    if (!isReactElement(result)) {
      try {
        const body = JSON.stringify(result);
        if (body !== undefined) {
          const cacheValue = {
            kind: "FETCH" as const,
            data: {
              headers: {},
              body,
              url: cacheKey,
            },
            tags: ctx.tags,
            revalidate: revalidateSeconds,
          };

          await handler.set(cacheKey, cacheValue, {
            fetchCache: true,
            tags: ctx.tags,
            revalidate: revalidateSeconds,
          });
        }
      } catch {
        // Result not serializable (circular refs, etc.) — skip caching
      }
    }

    return result;
  };

  return cachedFn as T;
}

// ---------------------------------------------------------------------------
// Helper: detect React elements (which can't be safely JSON-serialized)
// ---------------------------------------------------------------------------

// React element $$typeof symbols — check both the internal Symbol values
// used by different React versions.
const REACT_ELEMENT_SYMBOL = Symbol.for("react.element");
const REACT_TRANSITIONAL_ELEMENT_SYMBOL = Symbol.for("react.transitional.element");

function isReactElement(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== "object") return false;
  const v = value as Record<string | symbol, unknown>;
  return v.$$typeof === REACT_ELEMENT_SYMBOL || v.$$typeof === REACT_TRANSITIONAL_ELEMENT_SYMBOL;
}

// ---------------------------------------------------------------------------
// Helper: execute function within cache context
// ---------------------------------------------------------------------------

async function executeWithContext<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  args: any[],
  variant: string,
): Promise<any> {
  const ctx: CacheContext = {
    tags: [],
    lifeConfigs: [],
    variant: variant || "default",
  };

  return cacheContextStorage.run(ctx, () => fn(...args));
}

// ---------------------------------------------------------------------------
// Stable JSON serialization (handles undefined, Date, etc.)
// ---------------------------------------------------------------------------

function stableStringify(value: unknown, seen?: Set<unknown>): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";

  // Bail on non-serializable primitives so the caller can skip caching
  if (typeof value === "function") throw new Error("Cannot serialize function");
  if (typeof value === "symbol") throw new Error("Cannot serialize symbol");

  if (Array.isArray(value)) {
    // Circular reference detection
    if (!seen) seen = new Set();
    if (seen.has(value)) throw new Error("Circular reference");
    seen.add(value);
    const result = "[" + value.map(v => stableStringify(v, seen)).join(",") + "]";
    seen.delete(value);
    return result;
  }

  if (typeof value === "object" && value !== null) {
    if (value instanceof Date) {
      return `Date(${value.getTime()})`;
    }
    // Circular reference detection
    if (!seen) seen = new Set();
    if (seen.has(value)) throw new Error("Circular reference");
    seen.add(value);
    const keys = Object.keys(value).sort();
    const result = "{" + keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k], seen)}`).join(",") + "}";
    seen.delete(value);
    return result;
  }

  return JSON.stringify(value);
}
