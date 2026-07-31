import { isUnknownRecord } from "./record.js";

function readRecordField(
  ctx: Record<string, unknown> | undefined,
  field: string,
): Record<string, unknown> | undefined {
  const value = ctx?.[field];
  return isUnknownRecord(value) ? value : undefined;
}

export function readCacheControlNumberField(
  ctx: Record<string, unknown> | undefined,
  field: string,
): number | undefined {
  const cacheControl = readRecordField(ctx, "cacheControl");
  const value = cacheControl?.[field] ?? ctx?.[field];
  return typeof value === "number" ? value : undefined;
}

export function readCacheControlRevalidateField(
  ctx: Record<string, unknown> | undefined,
): number | false | undefined {
  const cacheControl = readRecordField(ctx, "cacheControl");
  const value = cacheControl?.revalidate ?? ctx?.revalidate;
  return typeof value === "number" || value === false ? value : undefined;
}

function isFiniteNonNegative(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Client-reuse seconds from a resolved `cacheLife`. Shared by every emitter
 * (ISR write, hit replay, prerender seed, done-script) so warm hits claim what
 * the producing render claimed. Two rules: never synthesize `stale` from
 * `revalidate`/`expire` (the `default` profile would license ~136y of reuse),
 * and never clamp it by them (Next.js replays the stored value verbatim;
 * `expire` is a serve-side ceiling, not a client bound). A literal `stale: 0`
 * is still a real client claim; it must not be treated as absent.
 */
export function resolveClientStaleTimeSeconds(
  cacheLife: { stale?: number } | null | undefined,
): number | undefined {
  const stale = cacheLife?.stale;
  return isFiniteNonNegative(stale) ? stale : undefined;
}
