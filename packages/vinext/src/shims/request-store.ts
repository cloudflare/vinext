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
 * import { Pool } from "@neondatabase/serverless"; // or pg
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
 * @example
 * ```ts
 * // Works with Drizzle too:
 * import { getRequestStore } from "vinext/request-store";
 * import { drizzle } from "drizzle-orm/neon-http";
 *
 * export function getDb(connectionString: string) {
 *   const store = getRequestStore();
 *   let db = store.get("db");
 *   if (!db) {
 *     db = drizzle(connectionString);
 *     store.set("db", db);
 *   }
 *   return db;
 * }
 * ```
 *
 * @module
 */

import { getRequestContext, isInsideUnifiedScope } from "./unified-request-context.js";

/**
 * Get the per-request key-value store.
 *
 * Inside a request scope: returns the request-scoped Map (isolated, auto-cleaned).
 * Outside a request scope: returns a fresh empty Map each time to prevent
 * cross-call data leakage and unbounded growth.
 *
 * @returns A Map<string, unknown> scoped to the current request.
 */
export function getRequestStore(): Map<string, unknown> {
  if (!isInsideUnifiedScope()) {
    // Return a fresh Map — not a shared global — to prevent data leaking
    // across unrelated calls outside request scope (dev server, tests).
    return new Map();
  }
  return getRequestContext().userStore;
}
