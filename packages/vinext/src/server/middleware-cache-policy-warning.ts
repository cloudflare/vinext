import { DefaultCdnCacheAdapter, getCdnCacheAdapter } from "vinext/shims/cdn-cache";
import { isVinextRscVaryField } from "./app-rsc-vary.js";
import { isCdnResponsePolicyHeader } from "./cache-control.js";
import { MIDDLEWARE_HEADER_PREFIX } from "./headers.js";

const CACHE_TAG_HEADER = "cache-tag";
const VARY_HEADER = "vary";

const emittedCachePolicyWarnings = new Set<string>();

/**
 * Custom `Vary` fields middleware asked the shared cache to partition on.
 * Framework RSC selectors are excluded: the adapter derives those vary
 * dimensions itself, so a framework-only `Vary` is not middleware-owned.
 */
function customVaryFields(value: string): string[] {
  const fields: string[] = [];
  for (const rawField of value.split(",")) {
    const field = rawField.trim();
    if (!field) continue;
    if (field === "*" || !isVinextRscVaryField(field)) fields.push(field);
  }
  return [...new Set(fields)];
}

function warningMessage(fileName: string, names: string[], varyFields: string[]): string {
  const lines = [
    `[vinext] ${fileName} set response cache headers (${names.join(", ")}) that the configured CDN cache adapter owns.`,
    "  Middleware runs above the cached response stage, so the adapter derives the client-visible Cache-Control, CDN-Cache-Control, and Cache-Tag headers from the framework's own route policy and these values are not delivered as authored.",
    '  Set the cache policy on the route (export const revalidate, cacheLife, or "use cache") instead, or remove the CDN adapter if middleware should own these headers.',
  ];
  if (varyFields.length > 0) {
    lines.push(
      `  Vary: ${varyFields.join(", ")} cannot partition stored responses either — middleware runs above the cache, and a cached response that carries Cache-Tag plus a custom Vary field is served with Cache-Control: no-store.`,
    );
  }
  lines.push("  See docs/caching.md.");
  return lines.join("\n");
}

/**
 * Warn in development when middleware authored response cache headers that the
 * active CDN cache adapter owns: the adapter re-derives the client-visible
 * cache policy from the framework's route policy, so these values never reach
 * the client as written. Deduped per distinct offending header set, mirroring
 * `warnConfigOnce` in `config/next-config.ts`.
 */
export function warnOnUnreachableMiddlewareCachePolicy(
  headers: Headers,
  options: { fileName: string },
): void {
  if (process.env.NODE_ENV === "production") return;

  // The default adapter is a pass-through: it stamps the framework's route
  // policy onto `Cache-Control` and leaves every other header untouched, so
  // middleware-authored headers survive. Every configured CDN adapter instead
  // re-derives the client-visible policy (and its provider headers) from the
  // route policy, discarding what middleware authored.
  if (getCdnCacheAdapter() instanceof DefaultCdnCacheAdapter) return;

  const names: string[] = [];
  let varyFields: string[] = [];
  for (const [name] of headers) {
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith(MIDDLEWARE_HEADER_PREFIX)) continue;
    if (lowerName === VARY_HEADER) {
      const fields = customVaryFields(headers.get(name) ?? "");
      if (fields.length === 0) continue;
      names.push(name);
      varyFields = fields;
      continue;
    }
    if (lowerName === CACHE_TAG_HEADER || isCdnResponsePolicyHeader(name)) {
      names.push(name);
    }
  }
  if (names.length === 0) return;

  const dedupeKey = `${names.join(",")}\u0000${varyFields.join(",")}`;
  if (emittedCachePolicyWarnings.has(dedupeKey)) return;
  emittedCachePolicyWarnings.add(dedupeKey);
  console.warn(warningMessage(options.fileName, names, varyFields));
}
