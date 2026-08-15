import {
  NEXT_CACHE_REVALIDATED_TAGS_HEADER,
  NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER,
  VINEXT_CACHE_REVALIDATED_TAGS_HEADER,
} from "./headers.js";

/**
 * Read tags forwarded by an earlier Server Action request.
 *
 * The draft-mode secret authenticates this internal protocol so an external
 * caller cannot forge cache invalidations by setting the header directly.
 * This mirrors the authenticated state forwarding performed by Next.js
 * `getPreviouslyRevalidatedTags()`. Vinext also carries an independent JSON
 * header so tags containing commas round-trip losslessly without guessing the
 * wire format from tag contents. The Next.js comma-delimited header remains
 * available to older peers; only new peers can preserve comma-containing tags.
 */
export function readPreviouslyRevalidatedTags(headers: Headers, token: string): string[] {
  if (!token || headers.get(NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER) !== token) return [];
  const jsonValue = headers.get(VINEXT_CACHE_REVALIDATED_TAGS_HEADER);
  if (jsonValue) {
    try {
      const parsed: unknown = JSON.parse(jsonValue);
      if (Array.isArray(parsed) && parsed.every((tag) => typeof tag === "string")) {
        return [...new Set(parsed.filter(Boolean))];
      }
    } catch {
      // Fall through to the Next.js-compatible header for rolling upgrades.
    }
  }

  const value = headers.get(NEXT_CACHE_REVALIDATED_TAGS_HEADER);
  if (!value) return [];
  return [...new Set(value.split(",").filter(Boolean))];
}

/** Forward request-local invalidations to an internal redirect target. */
export function writePreviouslyRevalidatedTags(
  headers: Headers,
  tags: readonly string[],
  token: string,
): void {
  if (!token || tags.length === 0) return;
  const uniqueTags = [...new Set(tags)];
  headers.set(NEXT_CACHE_REVALIDATED_TAGS_HEADER, uniqueTags.join(","));
  headers.set(VINEXT_CACHE_REVALIDATED_TAGS_HEADER, JSON.stringify(uniqueTags));
  headers.set(NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER, token);
}
