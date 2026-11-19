/**
 * Extra request headers for the requests a warm-cache deploy sends to the
 * deployed Worker (discovery, readiness, warming, certification and
 * cacheability probes), such as Cloudflare Access service-token headers.
 * Header values are secrets: no message in this module ever includes one.
 */

/** One `Name: value` header per line. Keeps secrets out of argv and shell history. */
export const VINEXT_WARM_CACHE_HEADERS_ENV = "VINEXT_WARM_CACHE_HEADERS";

export type WarmCacheRequestHeaders = readonly (readonly [name: string, value: string])[];

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Header values are ByteStrings without NUL, CR or LF. Checking here keeps the
// Headers constructor from throwing an error that quotes the value.
const INVALID_HEADER_VALUE = /[^\t\x20-\x7e\x80-\xff]/;

// Headers vinext sets, or deliberately omits, to choose what each request asks
// for: the representation (Accept, RSC and Next-Router-*), the Worker version,
// the prerender secret, the deployment ID, and cache revalidation. Server
// action and middleware headers make the Worker treat a request as uncacheable,
// and conditional or range headers turn a full fill into a 304 or 206. A user
// value would change which cache entry is filled or which Worker answers, so
// these names are rejected rather than silently overridden.
const RESERVED_HEADER_NAMES = new Set([
  "accept",
  "cache-control",
  "cloudflare-workers-version-overrides",
  "host",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "if-unmodified-since",
  "pragma",
  "range",
  "rsc",
  "user-agent",
  "x-deployment-id",
  "x-rsc-action",
]);
const RESERVED_HEADER_PREFIXES = ["next-", "x-middleware-", "x-nextjs-", "x-vinext-"];
// Node's fetch() throws for these at request time, after the version is staged.
const FETCH_REJECTED_HEADER_NAMES = new Set([
  "connection",
  "content-length",
  "expect",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

function isReservedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    RESERVED_HEADER_NAMES.has(lower) ||
    RESERVED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

/** Throws for a header name or value that cannot be sent; never echoes the value. */
export function validateWarmCacheRequestHeader(name: string, value: string, source: string): void {
  if (!HEADER_NAME.test(name)) {
    throw new Error(`${source} has an invalid header name.`);
  }
  if (FETCH_REJECTED_HEADER_NAMES.has(name.toLowerCase())) {
    throw new Error(`${source} cannot set "${name}": fetch() does not allow it.`);
  }
  if (isReservedHeaderName(name)) {
    throw new Error(
      `${source} cannot set "${name}": vinext controls this header on warm-up requests.`,
    );
  }
  if (INVALID_HEADER_VALUE.test(value)) {
    throw new Error(`${source} has an invalid value for header "${name}".`);
  }
}

function parseHeaderLine(line: string, source: string): [string, string] {
  const colon = line.indexOf(":");
  if (colon === -1) {
    throw new Error(`${source} expects "Name: value", but the entry has no colon.`);
  }
  const name = line.slice(0, colon).trim();
  // Trim only HTTP whitespace: String#trim would also drop valid bytes like NBSP.
  const value = line.slice(colon + 1).replace(/^[\t ]+|[\t ]+$/g, "");
  validateWarmCacheRequestHeader(name, value, source);
  return [name, value];
}

// A later entry replaces an earlier one with the same name.
function mergeHeaders(
  entries: readonly (readonly [string, string])[],
): WarmCacheRequestHeaders | undefined {
  const headers = new Map(entries.map((header) => [header[0].toLowerCase(), header]));
  return headers.size === 0 ? undefined : [...headers.values()];
}

/** Parse repeated `--warm-cache-header "Name: value"` flags. */
export function parseWarmCacheHeaderFlags(
  flagValues: readonly string[] | undefined,
): WarmCacheRequestHeaders | undefined {
  return mergeHeaders(
    (flagValues ?? []).map((value) => parseHeaderLine(value, "--warm-cache-header")),
  );
}

/**
 * Combine `VINEXT_WARM_CACHE_HEADERS` with the parsed flags. A flag replaces an
 * env entry with the same name.
 */
export function resolveWarmCacheRequestHeaders(
  envValue: string | undefined,
  flagHeaders: WarmCacheRequestHeaders | undefined,
): WarmCacheRequestHeaders | undefined {
  const envHeaders = (envValue ?? "")
    .split(/\r?\n/)
    .flatMap((line, index) =>
      line.trim() === ""
        ? []
        : [parseHeaderLine(line, `${VINEXT_WARM_CACHE_HEADERS_ENV} line ${index + 1}`)],
    );
  return mergeHeaders([...envHeaders, ...(flagHeaders ?? [])]);
}

/**
 * Build the base headers for a request to the deployed Worker. User headers go
 * underneath vinext's, and every request site sets its own headers on top.
 */
export function withWarmCacheRequestHeaders(
  userHeaders: WarmCacheRequestHeaders | undefined,
  vinextHeaders: HeadersInit,
): HeadersInit;
export function withWarmCacheRequestHeaders(
  userHeaders: WarmCacheRequestHeaders | undefined,
): HeadersInit | undefined;
export function withWarmCacheRequestHeaders(
  userHeaders: WarmCacheRequestHeaders | undefined,
  vinextHeaders?: HeadersInit,
): HeadersInit | undefined {
  if (!userHeaders?.length) return vinextHeaders;
  const headers = new Headers(userHeaders.map(([name, value]) => [name, value]));
  new Headers(vinextHeaders).forEach((value, name) => headers.set(name, value));
  return headers;
}
