/**
 * Cache-tag canonicalisation.
 *
 * Tags can flow into HTTP headers (e.g. `x-next-cache-tags` on ISR responses,
 * Cloudflare cache-tag headers, downstream Worker code) where Node's
 * `validateHeaderValue` rejects any byte outside `\t\x20-\x7e` and crashes
 * the response with `ERR_INVALID_CHAR`. Even on platforms with permissive
 * header setters, divergence between storage form and wire form silently
 * breaks invalidation when a `revalidateTag` call's tag does not byte-match
 * the form that was stored.
 *
 * The fix is to apply this encoding at every public boundary so storage,
 * comparison, and the wire all see the same ASCII-safe form. The fast-path
 * returns the input unchanged for already-ASCII tags (the common case), so
 * pre-encoded `%xx` input round-trips losslessly without `decodeURIComponent`
 * mangling literal `%xx` characters.
 *
 * The replacement matches *runs* of out-of-class code units rather than each
 * code unit individually so surrogate pairs (emoji, non-BMP characters) are
 * handed to `encodeURIComponent` as a complete code point — a per-code-unit
 * regex would split the pair and throw `URIError`.
 *
 * Mirrors Next.js's `packages/next/src/server/lib/encode-cache-tag.ts`
 * (introduced in vercel/next.js#93601).
 */

const OUT_OF_CLASS_CHAR = /[^\t\x20-\x7e]/;
const OUT_OF_CLASS_RUN = /[^\t\x20-\x7e]+/g;

export function encodeCacheTag(tag: string): string {
  return OUT_OF_CLASS_CHAR.test(tag)
    ? tag.replace(OUT_OF_CLASS_RUN, (run) => encodeURIComponent(run))
    : tag;
}

export function encodeCacheTags(tags: readonly string[]): string[] {
  return tags.map(encodeCacheTag);
}
