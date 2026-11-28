import { VINEXT_PAGES_NO_FALLBACK_HEADER } from "./headers.js";

/**
 * The `fallback: false` rejection marker's value for a route pattern. Route
 * patterns keep decoded filename segments (`/日本/:slug`), which a header
 * value cannot carry, so the marker holds the pattern percent-encoded.
 */
export function pagesNoFallbackHeaderValue(pattern: string): string {
  return encodeURIComponent(pattern);
}

/**
 * `response` without the internal `fallback: false` rejection marker. Copies
 * a response whose headers are immutable (from fetch()), keeping its streamed
 * HTML flag.
 */
export function withoutPagesNoFallbackHeader(response: Response): Response {
  try {
    response.headers.delete(VINEXT_PAGES_NO_FALLBACK_HEADER);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.delete(VINEXT_PAGES_NO_FALLBACK_HEADER);
    (copy as { __vinextStreamedHtmlResponse?: boolean }).__vinextStreamedHtmlResponse = (
      response as { __vinextStreamedHtmlResponse?: boolean }
    ).__vinextStreamedHtmlResponse;
    return copy;
  }
}
