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

// Split cache-control on the commas between directives. A comma inside a
// quoted extension value belongs to that value, so it is kept verbatim.
function splitDirectives(cacheControl: string): string[] {
  const directives: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < cacheControl.length; index++) {
    const character = cacheControl[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      directives.push(cacheControl.slice(start, index));
      start = index + 1;
    }
  }
  directives.push(cacheControl.slice(start));
  return directives;
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
  for (const part of cacheControl ? splitDirectives(cacheControl) : []) {
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
  return splitDirectives(cacheControl)
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

// Directives that keep a browser from assigning heuristic freshness: a
// lifetime of its own, or a rule against reusing the response unvalidated.
// `s-maxage` applies only to shared caches, so it is not one of them.
const CLIENT_FRESHNESS_DIRECTIVES = new Set(["max-age", "no-cache", "no-store"]);

function hasClientFreshness(cacheControl: string): boolean {
  return splitDirectives(cacheControl).some((part) =>
    CLIENT_FRESHNESS_DIRECTIVES.has(part.split("=")[0]!.trim().toLowerCase()),
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TIME = String.raw`(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})`;
const MONTH = "(?<month>[A-Z][a-z]{2})";
const HTTP_DATE_FORMATS = [
  // IMF-fixdate: Sun, 06 Nov 1994 08:49:37 GMT
  new RegExp(
    String.raw`^(?<weekday>Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?<day>\d{2}) ${MONTH} (?<year>\d{4}) ${TIME} GMT$`,
  ),
  // Obsolete rfc850-date: Sunday, 06-Nov-94 08:49:37 GMT
  new RegExp(
    String.raw`^(?<weekday>Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, (?<day>\d{2})-${MONTH}-(?<year>\d{2}) ${TIME} GMT$`,
  ),
  // Obsolete asctime-date: Sun Nov  6 08:49:37 1994
  new RegExp(
    String.raw`^(?<weekday>Mon|Tue|Wed|Thu|Fri|Sat|Sun) ${MONTH} (?<day> \d|\d{2}) ${TIME} (?<year>\d{4})$`,
  ),
];

/**
 * Parses an RFC 9110 HTTP-date. `Date.parse` also accepts values outside its
 * grammar, such as `2099-01-01`, which a cache must treat as already expired.
 */
function parseHttpDate(value: string, now: number): number {
  const fields = HTTP_DATE_FORMATS.map((format) => format.exec(value)?.groups).find(Boolean);
  const month = MONTHS.indexOf(fields?.month ?? "");
  if (!fields || month === -1) return Number.NaN;
  const [day, hour, minute, second] = [fields.day, fields.hour, fields.minute, fields.second].map(
    Number,
  ) as [number, number, number, number];
  // 60 is a leap second.
  if (hour > 23 || minute > 59 || second > 60) return Number.NaN;

  const midnight = (year: number) => {
    const date = new Date(0);
    date.setUTCFullYear(year, month, day);
    return date;
  };
  const time = ((hour * 60 + minute) * 60 + second) * 1000;
  let year = Number(fields.year);
  if (fields.year!.length === 2) {
    // A two-digit year that looks more than 50 years ahead is the latest past
    // year with those digits.
    const current = new Date(now).getUTCFullYear();
    year += current - (current % 100);
    const limit = new Date(now);
    limit.setUTCFullYear(current + 50);
    if (midnight(year).getTime() + time > limit.getTime()) year -= 100;
  }

  // The setter rolls a day such as 31 Feb into the next month, so the date
  // must read back unchanged, on the weekday it names.
  const date = midnight(year);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    WEEKDAYS[date.getUTCDay()] !== fields.weekday!.slice(0, 3)
  ) {
    return Number.NaN;
  }
  return date.getTime() + time;
}

/**
 * Headers served for an entry re-stored after its regeneration failed. Like
 * Next.js, it is served as new: a stored `Date` moves to the re-store time, and
 * forwarded freshness, including a later `Expires`, is capped at the retry
 * window so no downstream cache keeps the entry past the next retry.
 */
export function failedRegenerationHeaders(
  headers: [string, string][],
  retrySeconds: number,
  now = Date.now(),
): [string, string][] {
  const date = new Date(now).toUTCString();
  const retryUntil = now + retrySeconds * 1000;
  const restored = headers.map(([name, value]): [string, string] => {
    const lower = name.toLowerCase();
    if (lower === "date") return [name, date];
    // An invalid `Expires` already means expired, so only a later date moves.
    if (lower === "expires" && parseHttpDate(value, now) > retryUntil) {
      return [name, new Date(retryUntil).toUTCString()];
    }
    if (POLICY_HEADERS.has(lower)) return [name, capFreshness(value, retrySeconds)];
    return [name, value];
  });

  // Without an explicit lifetime, a browser may derive heuristic freshness
  // from `Last-Modified` and `Date`, and the new `Date` restarts it too. Cap
  // it the same way, by giving such a response the retry window as its
  // lifetime.
  if (restored.some(([name]) => name.toLowerCase() === "expires")) return restored;
  const index = restored.findIndex(([name]) => name.toLowerCase() === "cache-control");
  const cap = `max-age=${retrySeconds}`;
  if (index === -1) return [...restored, ["cache-control", cap]];
  const [name, value] = restored[index]!;
  if (hasClientFreshness(value)) return restored;
  restored[index] = [name, value ? `${value}, ${cap}` : cap];
  return restored;
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
