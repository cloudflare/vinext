export type CachePolicy = {
  createdAt: number;
  initialAge: number;
  freshUntil: number;
  swrUntil: number;
};

function parseSeconds(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const match = /^(?:"(\d+)"|(\d+))$/.exec(value);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[1] ?? match[2]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

type CacheLifetime = {
  maxAge: number;
  reuseForbidden: boolean;
  staleServingForbidden: boolean;
  staleWhileRevalidate: number;
};

// Vinext stores `revalidate = false` as this one-year value.
const STATIC_REVALIDATE_SECONDS = 31_536_000;
const MIN_RETRY_SECONDS = 3;
const MAX_RETRY_SECONDS = 30;

function parseCacheLifetime(headers: Headers): CacheLifetime {
  const cacheControl =
    headers.get("Cloudflare-CDN-Cache-Control") ??
    headers.get("CDN-Cache-Control") ??
    headers.get("Cache-Control");

  const directives = new Map<string, string | undefined>();
  for (const part of cacheControl?.split(",") ?? []) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) {
      continue;
    }

    directives.set(rawName.toLowerCase(), rawValue.length ? rawValue.join("=").trim() : undefined);
  }

  const cacheStorageForbidden = directives.has("no-store") || directives.has("private");
  const staleServingForbidden =
    directives.has("s-maxage") ||
    directives.has("must-revalidate") ||
    directives.has("proxy-revalidate");

  const reuseForbidden = cacheStorageForbidden || directives.has("no-cache");
  const maxAge = reuseForbidden
    ? 0
    : (parseSeconds(directives.get("s-maxage")) ?? parseSeconds(directives.get("max-age")) ?? 0);
  const staleWhileRevalidate =
    cacheStorageForbidden || staleServingForbidden
      ? 0
      : (parseSeconds(directives.get("stale-while-revalidate")) ?? 0);

  return { maxAge, reuseForbidden, staleServingForbidden, staleWhileRevalidate };
}

export function deriveCachePolicy(headers: Headers, now = Date.now()): CachePolicy {
  const { maxAge, staleWhileRevalidate } = parseCacheLifetime(headers);
  const initialAge = parseSeconds(headers.get("Age") ?? undefined) ?? 0;
  const remainingFreshSeconds = Math.max(0, maxAge - initialAge);
  const freshUntil = now + remainingFreshSeconds * 1000;

  return {
    createdAt: now,
    initialAge,
    freshUntil,
    swrUntil: freshUntil + staleWhileRevalidate * 1000,
  };
}

/**
 * Freshness for an entry re-stored after its regeneration failed, following
 * Next.js: retry after `revalidate` clamped to 3-30 s, and keep serving for at
 * least 3 s beyond that or the entry's original stale window. Policies that
 * forbid stale serving (`s-maxage`, `must-revalidate`, `proxy-revalidate`) get
 * the retry window but no stale window, so they still hard-expire.
 *
 * Returns null for an entry that must not be reused: `private`, `no-store`,
 * `no-cache`, or a zero lifetime with no stale window. Next.js has no cache
 * control to re-store for those, and a retry window would make them fresh and
 * cacheable at the edge.
 */
export function deriveFailedRegenerationPolicy(
  headers: Headers,
  now = Date.now(),
): (Pick<CachePolicy, "freshUntil" | "swrUntil"> & { retrySeconds: number }) | null {
  const { maxAge, reuseForbidden, staleServingForbidden, staleWhileRevalidate } =
    parseCacheLifetime(headers);
  if (reuseForbidden || (maxAge === 0 && staleWhileRevalidate === 0)) return null;
  // Next.js retries `revalidate = false` entries after 3 s. An explicit
  // one-year revalidate is indistinguishable here and also retries after 3 s
  // rather than 30 s; only the retry cadence differs.
  const revalidate = maxAge === STATIC_REVALIDATE_SECONDS ? MIN_RETRY_SECONDS : maxAge;
  const retrySeconds = Math.min(Math.max(revalidate, MIN_RETRY_SECONDS), MAX_RETRY_SECONDS);
  const expireSeconds = staleServingForbidden
    ? retrySeconds
    : Math.max(retrySeconds + 3, maxAge + staleWhileRevalidate);

  return {
    freshUntil: now + retrySeconds * 1000,
    retrySeconds,
    swrUntil: now + expireSeconds * 1000,
  };
}

const POLICY_HEADERS = new Set([
  "cache-control",
  "cdn-cache-control",
  "cloudflare-cdn-cache-control",
]);

function capFreshness(cacheControl: string, maxSeconds: number): string {
  return cacheControl
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && part.toLowerCase() !== "immutable")
    .map((part) => {
      const [rawName, ...rawValue] = part.split("=");
      const name = rawName.trim().toLowerCase();
      if (name !== "max-age" && name !== "s-maxage") return part;
      const seconds = parseSeconds(rawValue.join("=").trim());
      return seconds !== undefined && seconds > maxSeconds
        ? `${rawName.trim()}=${maxSeconds}`
        : part;
    })
    .join(", ");
}

/**
 * Headers served for an entry re-stored after its regeneration failed. Like
 * Next.js, it is served as new: a stored `Date` moves to the re-store time, and
 * forwarded freshness is capped at the retry window so no downstream cache
 * keeps the entry past the next retry.
 */
export function failedRegenerationHeaders(
  headers: [string, string][],
  retrySeconds: number,
  now = Date.now(),
): [string, string][] {
  const date = new Date(now).toUTCString();
  return headers.map(([name, value]) => {
    const lower = name.toLowerCase();
    if (lower === "date") return [name, date];
    if (POLICY_HEADERS.has(lower)) return [name, capFreshness(value, retrySeconds)];
    return [name, value];
  });
}

export function representationAge(createdAt: number, initialAge: number, now = Date.now()): number {
  return initialAge + Math.max(0, Math.floor((now - createdAt) / 1000));
}

export function edgeCacheControl(freshUntil: number, swrUntil: number, now = Date.now()): string {
  if (now < freshUntil) {
    const remainingFreshSeconds = Math.max(0, Math.ceil((freshUntil - now) / 1000));
    const staleWhileRevalidateSeconds = Math.max(0, Math.ceil((swrUntil - freshUntil) / 1000));
    return `max-age=${remainingFreshSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`;
  }

  const remainingStaleSeconds = Math.max(0, Math.ceil((swrUntil - now) / 1000));
  return `max-age=0, stale-while-revalidate=${remainingStaleSeconds}`;
}
