import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import * as schema from "./schema";

type CloudflareEnv = {
  DB: D1Database;
  COMPAT_INGEST_SECRET?: string;
};

/**
 * Drizzle client bound to the D1 binding declared in wrangler.jsonc.
 *
 * Both server components (RSC) and route handlers import this. The Cloudflare
 * vite plugin makes `cloudflare:workers` available in dev and production.
 */
export function getDb() {
  return drizzle((env as CloudflareEnv).DB, { schema });
}

export function getIngestSecret(): string | undefined {
  return (env as CloudflareEnv).COMPAT_INGEST_SECRET;
}
