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
