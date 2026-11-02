import {
  MIDDLEWARE_CACHE_HEADER,
  MIDDLEWARE_HEADER_PREFIX,
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

// Next.js filters `ipcForbiddenHeaders` and skips `content-length` before its
// generic middleware-header merge.
const UNMERGED_MIDDLEWARE_RESPONSE_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-encoding",
  "content-length",
  "expect",
  "keep-alive",
  "keepalive",
  "transfer-encoding",
]);

/**
 * Return the truthy ordinary middleware response headers. Next.js's generic
 * middleware-header merge writes each of them to the request too, so a value
 * middleware sets replaces one the client sent under the same name. The
 * `x-middleware-*` namespace carries vinext's middleware protocol and is
 * handled separately.
 */
function getMergedMiddlewareResponseHeaders(source: MiddlewareHeaderSource): Headers {
  const mergedHeaders = new Headers();
  const entries =
    source instanceof Headers
      ? source
      : Object.entries(source).flatMap(([key, value]) =>
          Array.isArray(value)
            ? value.map((item) => [key, item] as const)
            : [[key, value] as const],
        );

  for (const [key, value] of entries) {
    const lowerKey = key.toLowerCase();
    if (
      value &&
      !lowerKey.startsWith(MIDDLEWARE_HEADER_PREFIX) &&
      !UNMERGED_MIDDLEWARE_RESPONSE_HEADERS.has(lowerKey)
    ) {
      mergedHeaders.append(lowerKey, value);
    }
  }

  return mergedHeaders;
}

function applyMergedMiddlewareHeaders(
  targetHeaders: Headers,
  unconsumedHeaders: Map<string, string>,
  mergedHeaders: Headers,
): void {
  for (const [key, value] of unconsumedHeaders) {
    targetHeaders.set(key, value);
  }
  for (const key of new Set(mergedHeaders.keys())) {
    targetHeaders.delete(key);
  }
  // Iteration yields each Set-Cookie value separately and joins the rest.
  for (const [key, value] of mergedHeaders) {
    targetHeaders.append(key, value);
  }
}

/**
 * `baseHeaders` with only Next.js's generic merge of ordinary middleware
 * response headers applied, without the request-header protocol.
 */
export function applyMiddlewareResponseHeadersToRequest(
  baseHeaders: Headers,
  middlewareHeaders: MiddlewareHeaderSource,
): Headers {
  const nextHeaders = new Headers(baseHeaders);
  applyMergedMiddlewareHeaders(
    nextHeaders,
    new Map(),
    getMergedMiddlewareResponseHeaders(middlewareHeaders),
  );
  return nextHeaders;
}

/**
 * Whether middleware changed the headers seen by downstream application code
 * through its request-header protocol. Ordinary response headers are copied to
 * the request as well, but like a client's own headers they do not opt a
 * render out of the shared response stage.
 */
export function hasMiddlewareRequestHeaderOverrides(
  source: MiddlewareHeaderSource | null,
): boolean {
  if (!source) return false;
  return (
    Boolean(getMiddlewareHeaderValue(source, MIDDLEWARE_OVERRIDE_HEADERS)) ||
    getUnconsumedMiddlewareRequestHeaders(source).size > 0
  );
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
 * override. Any unconsumed `x-middleware-request-*` values and every other
 * truthy middleware response header are subsequently copied to the request
 * under their literal names, replacing values the client sent.
 */
export function buildRequestHeadersFromMiddlewareResponse(
  baseHeaders: Headers,
  middlewareHeaders: MiddlewareHeaderSource,
): Headers | null {
  const forwardedHeaders = getForwardedRequestHeaders(middlewareHeaders);
  const unconsumedHeaders = getUnconsumedMiddlewareRequestHeaders(middlewareHeaders);
  const mergedHeaders = getMergedMiddlewareResponseHeaders(middlewareHeaders);
  const rawOverrideHeader = getMiddlewareHeaderValue(
    middlewareHeaders,
    MIDDLEWARE_OVERRIDE_HEADERS,
  );

  // Next.js guards the override translation block with this header's
  // truthiness. Unconsumed x-middleware-request-* headers and ordinary
  // response headers still pass through its subsequent generic
  // middleware-header merge under their literal names.
  if (!rawOverrideHeader) {
    if (unconsumedHeaders.size === 0 && mergedHeaders.keys().next().done) return null;

    const nextHeaders = new Headers(baseHeaders);
    applyMergedMiddlewareHeaders(nextHeaders, unconsumedHeaders, mergedHeaders);
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
  // remain ordinary middleware response headers in Next.js and, like those,
  // are copied to the request literally by resolve-routes.ts's generic merge,
  // which runs after the override translation and so takes precedence.
  applyMergedMiddlewareHeaders(nextHeaders, unconsumedHeaders, mergedHeaders);

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
