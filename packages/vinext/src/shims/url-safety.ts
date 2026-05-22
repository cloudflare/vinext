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

/**
 * Emit a `console.error` matching Next.js's blocked-navigation message.
 *
 * Next.js's `router.push` / `router.replace` / `router.prefetch` (and the
 * Pages Router equivalents) throw an `Error` when the URL has a dangerous
 * scheme. In the browser, React's event-handler runtime catches that throw
 * and reports it through `console.error`, which is what the Next.js E2E
 * `test/e2e/app-dir/javascript-urls` suite asserts on.
 *
 * Vinext's navigation guards run synchronously inside async event handlers
 * (e.g. Link's `void handleClick(event)`), so a raw throw is dropped on the
 * floor instead of bubbling up to React. Emitting the same `console.error`
 * explicitly keeps observable behaviour aligned with Next.js — the test
 * matcher uses `.includes("has blocked a javascript: URL as a security
 * precaution.")` so any message containing that phrase satisfies it.
 *
 * Source reference (Next.js):
 *   packages/next/src/client/components/segment-cache/navigation.ts:537
 *   packages/next/src/client/components/app-router-instance.ts:345,402,442,460
 *   packages/next/src/shared/lib/router/router.ts:1025,1057
 */
export function reportBlockedDangerousNavigation(): void {
  console.error(DANGEROUS_URL_BLOCK_MESSAGE);
}

export function assertSafeNavigationUrl(url: string): void {
  if (isDangerousScheme(url)) {
    reportBlockedDangerousNavigation();
    throw new Error(DANGEROUS_URL_BLOCK_MESSAGE);
  }
}
