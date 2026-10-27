/**
 * Small internal helpers for reading cache-control metadata off the loosely
 * typed `ctx` object the cache layer passes around. Kept local to this package
 * so the Cloudflare adapters stay self-contained (these mirror the equivalent
 * helpers in the vinext core).
 */

export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRecordField(
  ctx: Record<string, unknown> | undefined,
  field: string,
): Record<string, unknown> | undefined {
  const value = ctx?.[field];
  return isUnknownRecord(value) ? value : undefined;
}

/**
 * When a `"use cache"` entry's generation started (`ctx.timestamp`), which dates
 * the entry like Next.js does. Absent, malformed or future values fall back to `now`.
 */
export function readCacheTimestamp(ctx: Record<string, unknown> | undefined, now: number): number {
  const value = ctx?.timestamp;
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= now
    ? value
    : now;
}

export function readCacheControlNumberField(
  ctx: Record<string, unknown> | undefined,
  field: string,
): number | undefined {
  const cacheControl = readRecordField(ctx, "cacheControl");
  const value = cacheControl?.[field] ?? ctx?.[field];
  return typeof value === "number" ? value : undefined;
}
