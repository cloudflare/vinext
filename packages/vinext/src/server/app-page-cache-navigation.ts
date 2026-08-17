import { createNonceAttribute } from "./html.js";
import { createNavigationRuntimeRscNavigationScript } from "./app-ssr-stream.js";

const NAVIGATION_METADATA_SCRIPT_PREFIX = "<script data-vinext-navigation-metadata";
const NAVIGATION_METADATA_PLACEHOLDER = "<!--vinext-navigation-metadata-->";
const SCRIPT_CLOSE = "</script>";

export type AppPageRequestNavigation = {
  pathname: string;
  searchParams: readonly [string, string][];
};

/**
 * Mark the request-specific navigation bootstrap so persistent HTML caching can
 * remove it without parsing or rewriting arbitrary inline JavaScript.
 */
export function createAppPageNavigationMetadataScript(
  navigation: AppPageRequestNavigation,
  nonce?: string,
): string {
  return `${NAVIGATION_METADATA_SCRIPT_PREFIX}${createNonceAttribute(nonce)}>${createNavigationRuntimeRscNavigationScript(navigation)}${SCRIPT_CLOSE}`;
}

/** Replace request-specific metadata with an inert persistence marker. */
export function stripAppPageNavigationMetadata(html: string): string {
  let cursor = 0;
  let stripped = "";
  let insertedPlaceholder = false;

  while (cursor < html.length) {
    const start = html.indexOf(NAVIGATION_METADATA_SCRIPT_PREFIX, cursor);
    if (start === -1) return stripped + html.slice(cursor);

    const close = html.indexOf(SCRIPT_CLOSE, start + NAVIGATION_METADATA_SCRIPT_PREFIX.length);
    if (close === -1) return stripped + html.slice(cursor);

    stripped += html.slice(cursor, start);
    if (!insertedPlaceholder) {
      stripped += NAVIGATION_METADATA_PLACEHOLDER;
      insertedPlaceholder = true;
    }
    cursor = close + SCRIPT_CLOSE.length;
  }

  return stripped;
}

/**
 * Remove marked navigation before persistence, admit HTML with no navigation
 * bootstrap, and reject legacy or malformed request-bound metadata.
 */
export function prepareAppPageHtmlForCache(html: string): string | null {
  if (!html.includes(NAVIGATION_METADATA_SCRIPT_PREFIX)) {
    // Reject the pre-marker format if it reappears. HTML without any vinext
    // navigation assignment is safe for boundary renderers that intentionally
    // emit no hydration metadata.
    const hasNavigationAssignment = html.includes(",nav:") || html.includes("{nav:");
    return html.includes(".bootstrap.rsc") && hasNavigationAssignment ? null : html;
  }

  const stripped = stripAppPageNavigationMetadata(html);
  return stripped.includes(NAVIGATION_METADATA_SCRIPT_PREFIX) ? null : stripped;
}

/**
 * Replace request-neutral cached metadata with the current request's state.
 * Legacy entries without the versioned marker remain unchanged.
 */
export function rewriteAppPageHtmlNavigation(
  html: string,
  navigation: AppPageRequestNavigation,
): string {
  const requestAgnosticHtml = stripAppPageNavigationMetadata(html);
  const placeholderIndex = requestAgnosticHtml.indexOf(NAVIGATION_METADATA_PLACEHOLDER);
  if (placeholderIndex === -1) return requestAgnosticHtml;

  const metadataScript = createAppPageNavigationMetadataScript(navigation);
  return (
    requestAgnosticHtml.slice(0, placeholderIndex) +
    metadataScript +
    requestAgnosticHtml
      .slice(placeholderIndex + NAVIGATION_METADATA_PLACEHOLDER.length)
      .replaceAll(NAVIGATION_METADATA_PLACEHOLDER, "")
  );
}
