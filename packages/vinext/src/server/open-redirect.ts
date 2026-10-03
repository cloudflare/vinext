/**
 * Returns true if a request pathname looks like a protocol-relative open
 * redirect, in either literal or percent-encoded form.
 *
 * A pathname is considered "open redirect shaped" when its first segment,
 * after decoding backslashes and encoded delimiters, would cause a browser
 * to resolve a `Location` containing the pathname as protocol-relative —
 * which requires something after the leading double slash that looks like a
 * host. A bare double slash (nothing after it, in either form) has no
 * host-like segment to redirect to: Next.js serves "//" as the index route,
 * not a 404 (see test/e2e/hydration).
 */
export function isOpenRedirectShaped(rawPathname: string): boolean {
  if (!rawPathname.startsWith("/")) return false;

  // Browsers treat backslashes as forward slashes in URL paths.
  const afterSlash = rawPathname.slice(1);
  let rest: string | null = null;
  if (afterSlash.startsWith("/") || afterSlash.startsWith("\\")) {
    rest = afterSlash.slice(1);
  } else if (afterSlash.length >= 3 && afterSlash[0] === "%") {
    // Percent escapes are case-insensitive per RFC 3986 section 2.1.
    const encoded = afterSlash.slice(0, 3).toLowerCase();
    if (encoded === "%5c" || encoded === "%2f") {
      rest = afterSlash.slice(3);
    }
  }
  if (rest === null) return false;

  return rest.length > 0;
}
