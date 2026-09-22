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

export function deriveCachePolicy(headers: Headers, now = Date.now()): CachePolicy {
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

  const maxAge =
    cacheStorageForbidden || directives.has("no-cache")
      ? 0
      : (parseSeconds(directives.get("s-maxage")) ?? parseSeconds(directives.get("max-age")) ?? 0);
  const initialAge = parseSeconds(headers.get("Age") ?? undefined) ?? 0;
  const remainingFreshSeconds = Math.max(0, maxAge - initialAge);
  const freshUntil = now + remainingFreshSeconds * 1000;

  const staleWhileRevalidate =
    cacheStorageForbidden || staleServingForbidden
      ? 0
      : (parseSeconds(directives.get("stale-while-revalidate")) ?? 0);

  return {
    createdAt: now,
    initialAge,
    freshUntil,
    swrUntil: freshUntil + staleWhileRevalidate * 1000,
  };
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
