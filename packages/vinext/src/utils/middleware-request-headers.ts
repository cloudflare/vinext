import {
  MIDDLEWARE_CACHE_HEADER,
  MIDDLEWARE_OVERRIDE_HEADERS,
  MIDDLEWARE_REQUEST_HEADER_PREFIX,
  MIDDLEWARE_SET_COOKIE_HEADER,
} from "./protocol-headers.js";

type MiddlewareHeaderValue = string | string[];
type MiddlewareHeaderSource = Headers | Record<string, MiddlewareHeaderValue>;

function getMiddlewareHeaderValue(source: MiddlewareHeaderSource, key: string): string | null {
  if (source instanceof Headers) {
    return source.get(key);
  }

  const value = source[key];
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function parseOverrideHeaderNames(rawValue: string): string[] {
  return rawValue
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

function getForwardedRequestHeaders(source: MiddlewareHeaderSource): Map<string, string> {
  const forwardedHeaders = new Map<string, string>();

  if (source instanceof Headers) {
    for (const [key, value] of source.entries()) {
      if (key.startsWith(MIDDLEWARE_REQUEST_HEADER_PREFIX)) {
        forwardedHeaders.set(key.slice(MIDDLEWARE_REQUEST_HEADER_PREFIX.length), value);
      }
    }
    return forwardedHeaders;
  }

  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(MIDDLEWARE_REQUEST_HEADER_PREFIX)) continue;
    const normalizedValue = Array.isArray(value) ? (value[0] ?? "") : value;
    forwardedHeaders.set(key.slice(MIDDLEWARE_REQUEST_HEADER_PREFIX.length), normalizedValue);
  }

  return forwardedHeaders;
}

/**
 * Return truthy forwarded values that Next.js does not consume through the
 * override list. Its subsequent generic middleware-header merge exposes these
 * under their literal protocol-header names on both the request and response.
 */
export function getUnconsumedMiddlewareRequestHeaders(
  source: MiddlewareHeaderSource,
): Map<string, string> {
  const rawOverrideHeader = getMiddlewareHeaderValue(source, MIDDLEWARE_OVERRIDE_HEADERS);
  const overriddenHeaders = rawOverrideHeader
    ? new Set(parseOverrideHeaderNames(rawOverrideHeader))
    : null;
  const unconsumedHeaders = new Map<string, string>();

  for (const [key, value] of getForwardedRequestHeaders(source)) {
    if (value && !overriddenHeaders?.has(key)) {
      unconsumedHeaders.set(`${MIDDLEWARE_REQUEST_HEADER_PREFIX}${key}`, value);
    }
  }

  return unconsumedHeaders;
}

export function encodeMiddlewareRequestHeaders(
  targetHeaders: Headers,
  requestHeaders: Headers,
): void {
  const overrideHeaderNames = [...requestHeaders.keys()];
  targetHeaders.set(MIDDLEWARE_OVERRIDE_HEADERS, overrideHeaderNames.join(","));

  for (const [key, value] of requestHeaders.entries()) {
    targetHeaders.set(`${MIDDLEWARE_REQUEST_HEADER_PREFIX}${key}`, value);
  }
}

/**
 * A non-empty `x-middleware-override-headers` value lists the complete
 * post-middleware header set, so any name absent from it was deleted by
 * middleware. Never re-add absent headers from the base request — that would
 * resurrect credentials the app explicitly stripped before an external
 * rewrite. Next.js treats the empty value emitted for `new Headers()` as no
 * override. Any unconsumed `x-middleware-request-*` values are subsequently
 * copied to the request under their literal protocol-header names.
 */
export function buildRequestHeadersFromMiddlewareResponse(
  baseHeaders: Headers,
  middlewareHeaders: MiddlewareHeaderSource,
): Headers | null {
  const forwardedHeaders = getForwardedRequestHeaders(middlewareHeaders);
  const unconsumedHeaders = getUnconsumedMiddlewareRequestHeaders(middlewareHeaders);
  const rawOverrideHeader = getMiddlewareHeaderValue(
    middlewareHeaders,
    MIDDLEWARE_OVERRIDE_HEADERS,
  );

  // Next.js guards the override translation block with this header's
  // truthiness. Unconsumed x-middleware-request-* headers still pass through
  // its subsequent generic middleware-header merge under their literal names.
  if (!rawOverrideHeader) {
    if (unconsumedHeaders.size === 0) return null;

    const nextHeaders = new Headers(baseHeaders);
    for (const [key, value] of unconsumedHeaders) {
      nextHeaders.set(key, value);
    }
    return nextHeaders;
  }

  const overrideHeaderNames = parseOverrideHeaderNames(rawOverrideHeader);
  const nextHeaders = new Headers();

  for (const key of overrideHeaderNames) {
    const value = forwardedHeaders.get(key);
    if (value !== undefined) {
      nextHeaders.set(key, value);
    }
  }

  // Values named by the override list were consumed above. Any stray values
  // remain ordinary middleware response headers in Next.js and are copied to
  // the request literally by resolve-routes.ts's generic merge.
  for (const [key, value] of unconsumedHeaders) {
    nextHeaders.set(key, value);
  }

  return nextHeaders;
}

export function shouldKeepMiddlewareHeader(key: string): boolean {
  return (
    key === MIDDLEWARE_OVERRIDE_HEADERS ||
    key === MIDDLEWARE_CACHE_HEADER ||
    key === MIDDLEWARE_SET_COOKIE_HEADER ||
    key.startsWith(MIDDLEWARE_REQUEST_HEADER_PREFIX)
  );
}
