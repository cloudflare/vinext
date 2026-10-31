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
 * fields filled: `stale` from `staleTimes.static`, `revalidate` from the
 * built-in, `expire` from `expireTime`. That includes the built-in `default`,
 * whose `stale` is unset in Next.js's defaults too. The other profiles keep
 * their gaps, which the "use cache" store resolves from `default`.
 *
 * Next.js only schema-checks these profiles (fields must be numbers) and
 * warns; `revalidate > expire` is checked for `cacheLife({...})` calls, not
 * for config profiles.
 */
export function resolveCacheLifeProfiles(
  userProfiles: unknown,
  defaults: { expireTime: number; staticStaleTime: number },
  warn: (message: string) => void,
): Record<string, CacheLifeConfig> {
  const profiles = copyBuiltInProfiles();

  for (const [name, rawProfile] of Object.entries(
    isUnknownRecord(userProfiles) ? userProfiles : {},
  )) {
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
  defaultProfile.stale ??= defaults.staticStaleTime;
  defaultProfile.revalidate ??= BUILT_IN_CACHE_LIFE_PROFILES.default.revalidate;
  defaultProfile.expire ??= defaults.expireTime;
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

/**
 * Read the `__VINEXT_CACHE_LIFE_PROFILES` define. When absent, the profiles a
 * next.config without `cacheLife` resolves to.
 */
export function parseCacheLifeProfiles(
  serialized: string | undefined,
): Record<string, CacheLifeConfig> {
  if (!serialized) {
    const profiles = copyBuiltInProfiles();
    // The default `experimental.staleTimes.static`.
    profiles.default.stale = 300;
    return profiles;
  }
  return JSON.parse(serialized, decodeNonFiniteNumber) as Record<string, CacheLifeConfig>;
}
