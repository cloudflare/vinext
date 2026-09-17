import { isUnknownRecord } from "./record.js";

export type CacheLifeConfig = {
  stale?: number;
  revalidate?: number;
  expire?: number;
};

const INFINITE_CACHE = 4294967294;

const builtInCacheLifeProfiles: Record<string, CacheLifeConfig> = {
  default: { revalidate: 900, expire: INFINITE_CACHE },
  seconds: { stale: 30, revalidate: 1, expire: 60 },
  minutes: { stale: 300, revalidate: 60, expire: 3600 },
  hours: { stale: 300, revalidate: 3600, expire: 86400 },
  days: { stale: 300, revalidate: 86400, expire: 604800 },
  weeks: { stale: 300, revalidate: 604800, expire: 2592000 },
  max: { stale: 300, revalidate: 2592000, expire: 31536000 },
};

/** Each caller owns its profiles, including the nested built-in objects. */
export function createDefaultCacheLifeProfiles(): Record<string, CacheLifeConfig> {
  return structuredClone(builtInCacheLifeProfiles);
}

/** Fill omitted durations only when a consumer has resolved its explicit values. */
export function fillCacheLifeDefaults(
  profile: CacheLifeConfig,
  defaultProfile: CacheLifeConfig,
): CacheLifeConfig {
  const resolved = { ...profile };
  for (const key of ["stale", "revalidate", "expire"] as const) {
    if (resolved[key] === undefined && defaultProfile[key] !== undefined) {
      resolved[key] = defaultProfile[key];
    }
  }
  return resolved;
}

// Matches Next.js's validateAndNormalizeCacheLifeProfile:
// https://github.com/vercel/next.js/blob/f464e32ec092c5a00c967e64cba40121a2992224/packages/next/src/server/use-cache/cache-life-profile.ts
function normalizeCacheLifeValue(
  profileName: string,
  key: keyof CacheLifeConfig,
  value: unknown,
): number | undefined {
  if (value === undefined) return undefined;

  if (value === false) {
    if (key === "stale") {
      throw new Error(
        "Pass `Infinity` instead of `false` if you want to cache on the client forever " +
          "without checking with the server.",
      );
    }
    if (key === "revalidate") {
      throw new Error(
        "Pass `Infinity` instead of `false` if you do not want to revalidate by time.",
      );
    }
    throw new Error(
      "Pass `Infinity` instead of `false` if you want to cache on the server forever " +
        "without checking with the origin.",
    );
  }

  if (typeof value !== "number") {
    throw new Error(`The ${key} option must be a number of seconds.`);
  }

  // Infinity would become null when configuration crosses a JSON boundary.
  if (value === Infinity) return INFINITE_CACHE;

  if (!Number.isFinite(value)) {
    throw new Error(
      `Invalid "cacheLife.${profileName}.${key}" provided, expected a finite number of seconds or Infinity, received ${value}`,
    );
  }

  return value;
}

function normalizeCacheLifeProfile(profileName: string, profile: unknown): CacheLifeConfig {
  if (!isUnknownRecord(profile)) {
    throw new Error(`Invalid "cacheLife.${profileName}" provided, expected an object.`);
  }

  const normalized: CacheLifeConfig = { ...profile };
  for (const key of ["stale", "revalidate", "expire"] as const) {
    const value = normalizeCacheLifeValue(profileName, key, profile[key]);
    if (value !== undefined) normalized[key] = value;
  }

  if (
    normalized.revalidate !== undefined &&
    normalized.expire !== undefined &&
    normalized.revalidate > normalized.expire
  ) {
    throw new Error(
      "If providing both the revalidate and expire options, " +
        "the expire option must be greater than the revalidate option. " +
        "The expire option indicates how many seconds from the start " +
        "until it can no longer be used.",
    );
  }

  return normalized;
}

/** Replace profiles by name, leaving ordinary profiles' omitted fields intact. */
export function resolveCacheLifeProfiles(
  cacheLife?: unknown,
  options: { defaultStale?: number; defaultExpire?: number } = {},
): Record<string, CacheLifeConfig> {
  const profiles = createDefaultCacheLifeProfiles();
  if (cacheLife === undefined) return profiles;

  if (!isUnknownRecord(cacheLife)) {
    throw new Error('Invalid "cacheLife" provided, expected an object of profiles.');
  }

  const configured = Object.fromEntries(
    Object.entries(cacheLife).map(([name, profile]): [string, CacheLifeConfig] => [
      name,
      normalizeCacheLifeProfile(name, profile),
    ]),
  );
  const resolved: Record<string, CacheLifeConfig> = { ...profiles, ...configured };

  // Validate the explicit values first, then fill only an overridden default.
  // https://github.com/vercel/next.js/blob/f464e32ec092c5a00c967e64cba40121a2992224/packages/next/src/server/config.ts#L1441
  if (Object.hasOwn(cacheLife, "default")) {
    resolved.default.stale ??= normalizeCacheLifeValue(
      "default",
      "stale",
      options.defaultStale ?? 300,
    );
    resolved.default.revalidate ??= profiles.default.revalidate;
    resolved.default.expire ??= normalizeCacheLifeValue(
      "default",
      "expire",
      options.defaultExpire ?? profiles.default.expire,
    );
  }

  return resolved;
}
