/**
 * Per-request key-value store for user-defined data.
 *
 * Backed by vinext's unified AsyncLocalStorage scope — values are
 * automatically isolated per request and garbage-collected when the
 * request completes. No manual cleanup needed.
 *
 * Primary use case: per-request database clients (Prisma, Drizzle, etc.)
 * on Cloudflare Workers, where global singletons cause alternating
 * connection failures (see https://github.com/cloudflare/vinext/issues/537).
 *
 * @example
 * ```ts
 * import { getRequestStore } from "vinext/request-store";
 * import { PrismaClient } from "@prisma/client";
 * import { PrismaPg } from "@prisma/adapter-pg";
 * import { Pool } from "@neondatabase/serverless";
 *
 * export function getPrisma(connectionString: string): PrismaClient {
 *   const store = getRequestStore();
 *   let prisma = store.get("prisma") as PrismaClient | undefined;
 *   if (!prisma) {
 *     const pool = new Pool({ connectionString });
 *     prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
 *     store.set("prisma", prisma);
 *   }
 *   return prisma;
 * }
 * ```
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getRequestContext, isInsideUnifiedScope } from "./unified-request-context.js";
import { getRequestExecutionContext } from "./request-context.js";

// Fallback ALS for code paths that have an ExecutionContext but not a
// unified scope (e.g. Pages Router middleware). Keyed on the execution
// context identity so stores don't leak across requests.
const _FALLBACK_KEY = Symbol.for("vinext.requestStore.fallback");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _fallbackAls = (_g[_FALLBACK_KEY] ??=
  new AsyncLocalStorage<Map<string, unknown>>()) as AsyncLocalStorage<Map<string, unknown>>;

/**
 * Get the per-request key-value store.
 *
 * Resolution order:
 * 1. Unified scope (App Router, Pages Router API routes) → userStore from context
 * 2. ExecutionContext scope (middleware) → fallback ALS store
 * 3. Outside any scope (tests, top-level) → fresh empty Map
 *
 * @returns A Map<string, unknown> scoped to the current request.
 */
export function getRequestStore(): Map<string, unknown> {
  // Preferred: unified request context (App Router + Pages Router API routes)
  if (isInsideUnifiedScope()) {
    return getRequestContext().userStore;
  }
  // Fallback: ExecutionContext scope (middleware)
  const fallbackStore = _fallbackAls.getStore();
  if (fallbackStore) {
    return fallbackStore;
  }
  // Outside any request scope: return a detached empty Map.
  // Callers should not rely on persistence here.
  return new Map();
}

/**
 * Run `fn` with a request store available via `getRequestStore()`.
 *
 * Use this in code paths that have an ExecutionContext but no unified
 * scope (e.g. custom worker entries wrapping middleware). The store is
 * isolated per call and cleaned up when `fn` resolves.
 *
 * Not needed for App Router or Pages Router API routes — those are
 * already wrapped by vinext's unified request context.
 */
export function runWithRequestStore<T>(fn: () => T | Promise<T>): T | Promise<T> {
  return _fallbackAls.run(new Map(), fn);
}
