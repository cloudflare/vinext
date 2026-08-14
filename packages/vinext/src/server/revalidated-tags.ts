import {
  NEXT_CACHE_REVALIDATED_TAGS_HEADER,
  NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER,
} from "./headers.js";

/**
 * Read tags forwarded by an earlier Server Action request.
 *
 * The draft-mode secret authenticates this internal protocol so an external
 * caller cannot forge cache invalidations by setting the header directly.
 * Mirrors Next.js `getPreviouslyRevalidatedTags()`.
 */
export function readPreviouslyRevalidatedTags(headers: Headers, token: string): string[] {
  if (!token || headers.get(NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER) !== token) return [];
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
  headers.set(NEXT_CACHE_REVALIDATED_TAGS_HEADER, [...new Set(tags)].join(","));
  headers.set(NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER, token);
}
