import { VINEXT_SPECIAL_ERROR_STATUS_HEADER } from "./headers.js";

const ADDITIVE_RESPONSE_HEADER_NAMES = new Set(["set-cookie", "vary"]);

export function mergeVaryHeader(target: Headers, value: string): void {
  const existing = target.get("Vary");
  const tokens = (existing ? `${existing}, ${value}` : value)
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  // Per RFC 9110, `Vary: *` means the response varies on all request fields.
  // Combining `*` with field names changes semantics and may be treated
  // inconsistently by caches. Collapse to `*` if any token is `*`.
  if (tokens.some((token) => token === "*")) {
    target.set("Vary", "*");
    return;
  }

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    merged.push(token);
  }

  target.set("Vary", merged.join(", "));
}

/**
 * Merge middleware response headers into a target Headers object.
 *
 * Set-Cookie and Vary are accumulated (append) since multiple sources can
 * contribute values. All other headers use set() so middleware owns singular
 * response headers like Cache-Control.
 */
export function mergeMiddlewareResponseHeaders(
  target: Headers,
  middlewareHeaders: Headers | null,
): void {
  if (!middlewareHeaders) {
    return;
  }

  for (const [key, value] of middlewareHeaders) {
    const lowerName = key.toLowerCase();
    // vinext's own marker, which middleware can't forge.
    if (lowerName === VINEXT_SPECIAL_ERROR_STATUS_HEADER) continue;
    // Next.js only stages truthy middleware response-header values. Keep an
    // empty Link from erasing config or renderer-owned Link values.
    if (lowerName === "link" && !value) {
      continue;
    }

    if (lowerName === "vary") {
      mergeVaryHeader(target, value);
      continue;
    }

    if (ADDITIVE_RESPONSE_HEADER_NAMES.has(lowerName)) {
      target.append(key, value);
      continue;
    }

    target.set(key, value);
  }
}

// Next.js send-response.ts appends a response's own values for these after the
// middleware values already on the outgoing response. Vary is merged by
// mergeMiddlewareResponseHeaders; other response headers yield to middleware.
const RESPONSE_APPENDED_HEADER_NAMES = ["set-cookie", "www-authenticate", "proxy-authenticate"];
const RESPONSE_APPENDED_COOKIE_HEADER_NAMES = ["set-cookie"];

export type MiddlewareResponseMergeOptions = {
  /**
   * Keep the response's WWW-Authenticate and Proxy-Authenticate after
   * middleware's, as Next.js does for App route handlers. Pages API handlers
   * write to the Node response that already holds middleware's headers, so
   * their callers opt out.
   */
  appendResponseChallenges?: boolean;
};

/**
 * Merge middleware response headers onto an already-built response's headers.
 *
 * Next.js writes middleware response headers before the handler runs and then
 * appends the handler response's Set-Cookie, WWW-Authenticate and
 * Proxy-Authenticate values, so middleware values come first and the
 * response's own are kept. A handler's cookie for the same name (a logout
 * deletion or session rotation) is then the one the browser applies last.
 */
export function mergeMiddlewareResponseHeadersOntoResponse(
  target: Headers,
  middlewareHeaders: Headers | null,
  options: MiddlewareResponseMergeOptions = {},
): void {
  if (!middlewareHeaders) {
    return;
  }

  const responseValues: [string, string[]][] = [];
  const appendedNames =
    options.appendResponseChallenges === false
      ? RESPONSE_APPENDED_COOKIE_HEADER_NAMES
      : RESPONSE_APPENDED_HEADER_NAMES;
  for (const name of appendedNames) {
    if (!middlewareHeaders.has(name)) continue;
    const value = target.get(name);
    responseValues.push([
      name,
      name === "set-cookie" ? target.getSetCookie() : value === null ? [] : [value],
    ]);
    target.delete(name);
  }
  mergeMiddlewareResponseHeaders(target, middlewareHeaders);
  for (const [name, values] of responseValues) {
    // Next.js only stages truthy middleware header values.
    if (!middlewareHeaders.get(name)) target.delete(name);
    for (const value of values) {
      target.append(name, value);
    }
  }
}
