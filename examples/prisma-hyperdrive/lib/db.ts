/**
 * Per-request Prisma client for Cloudflare Workers.
 *
 * Workers reuse isolates across requests, but each request has its own
 * I/O context. A global PrismaClient singleton causes alternating
 * connection failures (success, fail, success, fail...) because the
 * connection from Request A is invalid in Request B.
 *
 * Solution: create a fresh PrismaClient for every call. PrismaClient
 * construction is lightweight (~0.1ms) — the expensive part is the
 * actual query, which Hyperdrive accelerates via connection pooling.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { env } from "cloudflare:workers";

/**
 * Get a fresh PrismaClient for the current request.
 *
 * Each call creates a new client to guarantee request isolation.
 * Hyperdrive handles connection pooling at the edge — no need to
 * cache or reuse the client across calls.
 */
export function getPrisma(): PrismaClient {
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}
