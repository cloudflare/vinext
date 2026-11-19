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
// action and middleware headers make the Worker treat a request as uncacheable.
// A user value would change which cache entry is filled or which Worker
// answers, so these names are rejected rather than silently overridden.
const RESERVED_HEADER_NAMES = new Set([
  "accept",
  "cache-control",
  "cloudflare-workers-version-overrides",
  "host",
  "pragma",
  "rsc",
  "user-agent",
  "x-deployment-id",
  "x-rsc-action",
]);
const RESERVED_HEADER_PREFIXES = ["next-", "x-middleware-", "x-nextjs-", "x-vinext-"];
// Node's fetch() throws for these at request time, after the version is staged.
const FETCH_REJECTED_HEADER_NAMES = new Set([
  "connection",
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
      `${source} cannot set "${name}": vinext sets this header itself on warm-up requests.`,
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

/**
 * Combine `VINEXT_WARM_CACHE_HEADERS` with repeated `--warm-cache-header`
 * flags. A later entry replaces an earlier one with the same name, so a flag
 * overrides the env var.
 */
export function parseWarmCacheRequestHeaders(
  flagValues: readonly string[] | undefined,
  envValue: string | undefined,
): WarmCacheRequestHeaders | undefined {
  const headers = new Map<string, [string, string]>();
  const add = (header: [string, string]) => headers.set(header[0].toLowerCase(), header);
  for (const [index, line] of (envValue ?? "").split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    add(parseHeaderLine(line, `${VINEXT_WARM_CACHE_HEADERS_ENV} line ${index + 1}`));
  }
  for (const value of flagValues ?? []) {
    add(parseHeaderLine(value, "--warm-cache-header"));
  }
  return headers.size === 0 ? undefined : [...headers.values()];
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
