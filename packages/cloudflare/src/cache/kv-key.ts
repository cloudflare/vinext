import { fnv1a64 } from "vinext/internal/utils/hash";

/** Key prefix for tag invalidation timestamps. */
const TAG_PREFIX = "__tag:";

/** Key prefix for cache entries. */
export const ENTRY_PREFIX = "cache:";

/** Cloudflare KV's maximum UTF-8 encoded key length. */
const KV_KEY_MAX_BYTES = 512;

/** Marker for logical keys that must be hashed to fit in KV. */
const HASHED_KEY_PREFIX = "__hash:";

const KV_KEY_ENCODER = new TextEncoder();

/** KV rejects an expiration TTL below 60 seconds. */
const MIN_KV_EXPIRATION_TTL_SECONDS = 60;

/** Default KV TTL for entries and prerender seeds. */
const DEFAULT_KV_EXPIRATION_TTL_SECONDS = 30 * 24 * 3600;

/**
 * The KV TTL for a configured `ttlSeconds`, shared by the runtime adapter and
 * deploy seeding. A missing, non-finite or nonpositive value falls back to 30
 * days, and a smaller value is raised to KV's minimum.
 */
export function resolveKvExpirationTtlSeconds(ttlSeconds: number | undefined): number {
  const configured =
    typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds) && ttlSeconds > 0
      ? ttlSeconds
      : DEFAULT_KV_EXPIRATION_TTL_SECONDS;
  return Math.max(MIN_KV_EXPIRATION_TTL_SECONDS, configured);
}

export type KvKeySpace = {
  /** Prefix shared by every cache entry, including entries with hashed logical keys. */
  entryPrefix: string;
  entryKey(logicalKey: string): string;
  tagKey(tag: string): string;
};

function kvKeyByteLength(key: string): number {
  return KV_KEY_ENCODER.encode(key).length;
}

/**
 * Keep short app prefixes readable, but bound the namespace portion so a
 * hashed entry or tag key is always able to fit within Cloudflare KV's limit.
 */
function normalizeAppPrefix(appPrefix: string | undefined): string {
  if (!appPrefix) return "";

  const prefix = `${appPrefix}:`;
  const longestCategoryPrefix =
    ENTRY_PREFIX.length >= TAG_PREFIX.length ? ENTRY_PREFIX : TAG_PREFIX;
  const shortestHashedKey = `${prefix}${longestCategoryPrefix}${HASHED_KEY_PREFIX}${fnv1a64("")}`;
  if (kvKeyByteLength(shortestHashedKey) <= KV_KEY_MAX_BYTES) return prefix;

  return `__app:${fnv1a64(appPrefix)}:`;
}

function buildStorageKey(prefix: string, categoryPrefix: string, logicalKey: string): string {
  const key = `${prefix}${categoryPrefix}${logicalKey}`;
  if (kvKeyByteLength(key) <= KV_KEY_MAX_BYTES) return key;

  return `${prefix}${categoryPrefix}${HASHED_KEY_PREFIX}${fnv1a64(logicalKey)}`;
}

/** Create the deterministic key namespace for runtime cache operations. */
export function createKvKeySpace(appPrefix: string | undefined): KvKeySpace {
  const prefix = normalizeAppPrefix(appPrefix);
  return {
    entryPrefix: `${prefix}${ENTRY_PREFIX}`,
    entryKey: (logicalKey) => buildStorageKey(prefix, ENTRY_PREFIX, logicalKey),
    tagKey: (tag) => buildStorageKey(prefix, TAG_PREFIX, tag),
  };
}
