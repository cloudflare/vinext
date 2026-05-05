/**
 * Shared Set-Cookie serialization for the next/headers and next/server shims.
 *
 * Two call sites — `cookies().set()` in headers.ts and `ResponseCookies.set()`
 * in server.ts — produce identical Set-Cookie header strings. Keep the
 * encoding, attribute order, and validation in one place so subtle RFC 6265
 * details (escaping, attribute ordering, etc.) cannot drift between them.
 *
 * Note: this is a value-encoding helper for response cookies only. The
 * request `Cookie:` header serialization in `RequestCookies._serialize`
 * (server.ts) intentionally lives separately — it builds a different format
 * (no attributes, just `name=value; name=value`) and shouldn't share this
 * code.
 */

type SerializeSetCookieOptions = {
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

/**
 * RFC 6265 §4.1.1: cookie-name is a token (RFC 2616 §2.2).
 * Allowed: any visible ASCII (0x21-0x7E) except separators: ()<>@,;:\"/[]?={}
 */
const VALID_COOKIE_NAME_RE =
  /^[\x21\x23-\x27\x2A\x2B\x2D\x2E\x30-\x39\x41-\x5A\x5E-\x7A\x7C\x7E]+$/;

export function validateCookieName(name: string): void {
  if (!name || !VALID_COOKIE_NAME_RE.test(name)) {
    throw new Error(`Invalid cookie name: ${JSON.stringify(name)}`);
  }
}

/**
 * Validate cookie attribute values (path, domain) to prevent injection
 * via semicolons, newlines, or other control characters.
 */
export function validateCookieAttributeValue(value: string, attributeName: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || value[i] === ";") {
      throw new Error(`Invalid cookie ${attributeName} value: ${JSON.stringify(value)}`);
    }
  }
}

/**
 * Build a Set-Cookie header string from a cookie name, value, and attributes.
 *
 * - Encodes the value with `encodeURIComponent`.
 * - Defaults `Path` to `/` (matching @edge-runtime/cookies and Next.js).
 * - Validates path/domain to reject control characters and semicolons.
 * - Emits attributes in the order: Path, Domain, Max-Age, Expires, HttpOnly,
 *   Secure, SameSite.
 *
 * The caller is responsible for validating the cookie name (typically before
 * mutating any internal state) via `validateCookieName`.
 */
export function serializeSetCookie(
  name: string,
  value: string,
  options?: SerializeSetCookieOptions,
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  const path = options?.path ?? "/";
  validateCookieAttributeValue(path, "Path");
  parts.push(`Path=${path}`);
  if (options?.domain) {
    validateCookieAttributeValue(options.domain, "Domain");
    parts.push(`Domain=${options.domain}`);
  }
  if (options?.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options?.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options?.httpOnly) parts.push("HttpOnly");
  if (options?.secure) parts.push("Secure");
  if (options?.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}
