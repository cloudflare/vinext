/**
 * `Sec-Fetch-Dest` values for subresource requests that can never render an
 * HTML response. Excludes destinations that can display HTML (`document`,
 * `iframe`, etc.) and `empty` (`fetch()`/XHR, including RSC requests).
 *
 * Ported from Next.js:
 * packages/next/src/server/lib/is-non-html-sec-fetch-dest.ts
 */
const NON_HTML_SEC_FETCH_DESTS = new Set([
  "audio",
  "audioworklet",
  "font",
  "image",
  "json",
  "manifest",
  "paintworklet",
  "report",
  "script",
  "serviceworker",
  "sharedworker",
  "style",
  "track",
  "video",
  "webidentity",
  "worker",
  "xslt",
]);

export function isNonHtmlSecFetchDest(value: string | null | undefined): boolean {
  return typeof value === "string" && NON_HTML_SEC_FETCH_DESTS.has(value);
}
