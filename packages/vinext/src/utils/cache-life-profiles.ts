import { isUnknownRecord } from "./record.js";

export type CacheLifeConfig = {
  stale?: number;
  revalidate?: number;
  expire?: number;
};

/** Next.js's built-in profiles (`defaultConfig.cacheLife` in config-shared.ts). */
export const BUILT_IN_CACHE_LIFE_PROFILES: Readonly<Record<string, Readonly<CacheLifeConfig>>> = {
  default: { revalidate: 900, expire: 4294967294 },
  seconds: { stale: 30, revalidate: 1, expire: 60 },
  minutes: { stale: 300, revalidate: 60, expire: 3600 },
  hours: { stale: 300, revalidate: 3600, expire: 86400 },
  days: { stale: 300, revalidate: 86400, expire: 604800 },
  weeks: { stale: 300, revalidate: 604800, expire: 2592000 },
  max: { stale: 300, revalidate: 2592000, expire: 31536000 },
};

const CACHE_LIFE_FIELDS = ["stale", "revalidate", "expire"] as const;

function copyBuiltInProfiles(): Record<string, CacheLifeConfig> {
  const profiles: Record<string, CacheLifeConfig> = {};
  for (const [name, profile] of Object.entries(BUILT_IN_CACHE_LIFE_PROFILES)) {
    profiles[name] = { ...profile };
  }
  return profiles;
}

/**
 * Merge next.config `cacheLife` profiles over the built-ins, as Next.js does
 * in `assignDefaultsAndValidate` (server/config.ts): a user profile replaces
 * the built-in of the same name whole, and only `default` gets its missing
 * `revalidate` / `expire` filled (`expire` from `expireTime`). The other
 * profiles keep their gaps, which Next.js's "use cache" store resolves from
 * `default`.
 *
 * Next.js also fills a missing `default.stale` from `staleTimes.static`.
 * vinext's built-in `default` already leaves `stale` unset to mean exactly
 * that, so a user `default` keeps the same representation.
 *
 * Next.js only schema-checks these profiles (fields must be numbers) and
 * warns; `revalidate > expire` is checked for `cacheLife({...})` calls, not
 * for config profiles.
 */
export function resolveCacheLifeProfiles(
  userProfiles: unknown,
  expireTime: number,
  warn: (message: string) => void,
): Record<string, CacheLifeConfig> {
  const profiles = copyBuiltInProfiles();
  if (!isUnknownRecord(userProfiles)) return profiles;

  for (const [name, rawProfile] of Object.entries(userProfiles)) {
    if (!isUnknownRecord(rawProfile)) {
      warn(`[vinext] Invalid next.config option \`cacheLife.${name}\`: expected an object.`);
      continue;
    }
    const profile: CacheLifeConfig = {};
    for (const field of CACHE_LIFE_FIELDS) {
      const value = rawProfile[field];
      if (value === undefined) continue;
      // Like Next.js's zod schema: NaN is not a number of seconds; Infinity is.
      if (typeof value !== "number" || Number.isNaN(value)) {
        warn(
          `[vinext] Invalid next.config option \`cacheLife.${name}.${field}\`: expected a number of seconds.`,
        );
        continue;
      }
      profile[field] = value;
    }
    profiles[name] = profile;
  }

  const defaultProfile = profiles.default;
  defaultProfile.revalidate ??= BUILT_IN_CACHE_LIFE_PROFILES.default.revalidate;
  defaultProfile.expire ??= expireTime;
  return profiles;
}

// JSON has no Infinity, which `cacheLife` accepts for "never".
function encodeNonFiniteNumber(_key: string, value: unknown): unknown {
  return value === Infinity || value === -Infinity ? String(value) : value;
}

function decodeNonFiniteNumber(_key: string, value: unknown): unknown {
  return value === "Infinity" || value === "-Infinity" ? Number(value) : value;
}

/** Serialize resolved profiles for the `__VINEXT_CACHE_LIFE_PROFILES` define. */
export function serializeCacheLifeProfiles(profiles: Record<string, CacheLifeConfig>): string {
  return JSON.stringify(profiles, encodeNonFiniteNumber);
}

/** Read the `__VINEXT_CACHE_LIFE_PROFILES` define; the built-ins when absent. */
export function parseCacheLifeProfiles(
  serialized: string | undefined,
): Record<string, CacheLifeConfig> {
  if (!serialized) return copyBuiltInProfiles();
  return JSON.parse(serialized, decodeNonFiniteNumber) as Record<string, CacheLifeConfig>;
}
