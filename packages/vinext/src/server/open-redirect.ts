/**
 * Returns true if a request pathname looks like a protocol-relative open
 * redirect, in either literal or percent-encoded form.
 *
 * A pathname is considered "open redirect shaped" when its first segment,
 * after decoding backslashes and encoded delimiters, would cause a browser
 * to resolve a `Location` containing the pathname as protocol-relative.
 */
export function isOpenRedirectShaped(rawPathname: string): boolean {
  if (!rawPathname.startsWith("/")) return false;

  // Browsers treat backslashes as forward slashes in URL paths.
  const afterSlash = rawPathname.slice(1);
  if (afterSlash.startsWith("/") || afterSlash.startsWith("\\")) return true;

  // Percent escapes are case-insensitive per RFC 3986 section 2.1.
  if (afterSlash.length >= 3 && afterSlash[0] === "%") {
    const encoded = afterSlash.slice(0, 3).toLowerCase();
    if (encoded === "%5c" || encoded === "%2f") return true;
  }

  return false;
}
