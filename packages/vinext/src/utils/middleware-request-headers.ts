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
 * override and leaves the request unchanged.
 */
export function buildRequestHeadersFromMiddlewareResponse(
  _baseHeaders: Headers,
  middlewareHeaders: MiddlewareHeaderSource,
): Headers | null {
  const rawOverrideHeader = getMiddlewareHeaderValue(
    middlewareHeaders,
    MIDDLEWARE_OVERRIDE_HEADERS,
  );
  // Next.js guards the entire mutation block with this header's truthiness.
  // Missing and empty values therefore ignore even stray forwarded headers
  // from malformed combinations that our encoder cannot produce.
  if (!rawOverrideHeader) return null;

  const overrideHeaderNames = parseOverrideHeaderNames(rawOverrideHeader);
  const forwardedHeaders = getForwardedRequestHeaders(middlewareHeaders);
  const nextHeaders = new Headers();

  for (const key of overrideHeaderNames) {
    const value = forwardedHeaders.get(key);
    if (value !== undefined) {
      nextHeaders.set(key, value);
    }
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
