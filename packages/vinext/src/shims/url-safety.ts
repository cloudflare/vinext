/**
 * Shared URL safety utilities for Link, Form, and navigation shims.
 *
 * Centralizes dangerous URI scheme detection so all components and
 * navigation functions use the same validation logic.
 */

/**
 * Detect dangerous URI schemes that should never be navigated to.
 *
 * Adapted from Next.js's javascript URL detector:
 * packages/next/src/client/lib/javascript-url.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/client/lib/javascript-url.ts
 *
 * URL parsing ignores leading C0 control characters / spaces, and treats
 * embedded tab/newline characters in the scheme as insignificant. We mirror
 * that behavior here so obfuscated values like `java\nscript:` and
 * `\x00javascript:` are still blocked.
 *
 * Vinext intentionally extends this handling to `data:` and `vbscript:` too,
 * since both are also dangerous navigation targets.
 */
const LEADING_IGNORED = "[\\u0000-\\u001F \\u200B\\uFEFF]*";
const SCHEME_IGNORED = "[\\r\\n\\t]*";

function buildDangerousSchemeRegex(scheme: string): RegExp {
  const chars = scheme.split("").join(SCHEME_IGNORED);
  return new RegExp(`^${LEADING_IGNORED}${chars}${SCHEME_IGNORED}:`, "i");
}

const DANGEROUS_SCHEME_RES = [
  buildDangerousSchemeRegex("javascript"),
  buildDangerousSchemeRegex("data"),
  buildDangerousSchemeRegex("vbscript"),
];

export const DANGEROUS_URL_BLOCK_MESSAGE =
  "Next.js has blocked a javascript: URL as a security precaution.";

export function isDangerousScheme(url: string): boolean {
  const str = "" + (url as unknown as string);
  return DANGEROUS_SCHEME_RES.some((re) => re.test(str));
}

export function assertSafeNavigationUrl(url: string): void {
  if (isDangerousScheme(url)) {
    throw new Error(DANGEROUS_URL_BLOCK_MESSAGE);
  }
}
