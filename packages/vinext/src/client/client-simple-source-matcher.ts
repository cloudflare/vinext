/**
 * Synchronous shortcut for `redirects()` / `rewrites()` sources in the Pages
 * Router client.
 *
 * The real matcher (`matchConfigPattern`) compiles a source with path-to-regexp
 * and is loaded on demand, to keep it out of the router chunk. These functions
 * let the router decide the common cases without that load. They do not have
 * a meaning of their own: every definite answer must equal the answer of
 * `matchConfigPattern` for the same pathname and source.
 */

import { removeTrailingSlash } from "../utils/base-path.js";

// Characters that start a param, group, modifier, or escape in a source.
const SOURCE_SYNTAX = /[:(){}\\*+?]/;

// The real matcher compares with the regex `i` flag. For non-ASCII text that
// flag and toLowerCase() do not agree on every character.
const NOT_PRINTABLE_ASCII = /[^\x20-\x7e]/;

type SimpleSourceSegment =
  | { kind: "literal"; text: string }
  | { kind: "param"; name: string }
  | { kind: "catchAll"; name: string; required: boolean };

/**
 * Read a source that has only literal segments, whole-segment `:name` params,
 * and one trailing `:name*` or `:name+`. Returns null for every other source.
 *
 * The whole source is read before any segment is matched. A later segment
 * can change what an earlier one means: in `/docs/:path*.md` the `/` before
 * the param is optional with it, so the source matches `/docs.md` and the
 * first segment is not the literal `docs`.
 */
function parseSimpleSource(source: string): SimpleSourceSegment[] | null {
  if (!source.startsWith("/") || NOT_PRINTABLE_ASCII.test(source)) return null;
  if (source === "/") return [];

  const parts = source.slice(1).split("/");
  const segments: SimpleSourceSegment[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    // An empty part is a doubled or trailing slash, which the real matcher
    // handles together with the trailing slash of the pathname.
    if (part === "") return null;
    if (!SOURCE_SYNTAX.test(part)) {
      segments.push({ kind: "literal", text: part.toLowerCase() });
      continue;
    }
    const param = /^:(\w+)$/.exec(part);
    if (param) {
      segments.push({ kind: "param", name: param[1]! });
      continue;
    }
    const catchAll = index === parts.length - 1 ? /^:(\w+)([*+])$/.exec(part) : null;
    if (!catchAll) return null;
    segments.push({ kind: "catchAll", name: catchAll[1]!, required: catchAll[2] === "+" });
  }
  return segments;
}

/**
 * Match a pathname against a source. Returns the params, `null` for a definite
 * mismatch, or `undefined` when the caller must ask the real matcher.
 */
export function matchSimpleClientConfigPattern(
  pathname: string,
  source: string,
): Record<string, string> | null | undefined {
  const segments = parseSimpleSource(source);
  if (!segments || NOT_PRINTABLE_ASCII.test(pathname)) return undefined;

  // The real matcher collapses repeated slashes and removes one trailing
  // slash from the pathname. A pathname with a repeated slash is left to it.
  if (!pathname.startsWith("/") || pathname.includes("//")) return undefined;
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  const pathParts = path === "/" ? [] : path.slice(1).split("/");
  const params: Record<string, string> = Object.create(null);

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const pathPart = pathParts[index];

    if (segment.kind === "literal") {
      if (pathPart?.toLowerCase() !== segment.text) return null;
    } else if (segment.kind === "param") {
      // A param needs a segment, so `/:section` does not match `/`. The
      // pathname has no repeated slash here, so a segment is never empty.
      if (pathPart === undefined) return null;
      params[segment.name] = pathPart;
    } else {
      const rest = pathParts.slice(index);
      if (segment.required && rest.length === 0) return null;
      // An empty catch-all must not erase a param of the same name (`/:id/:id*`).
      if (rest.length > 0 || !(segment.name in params)) params[segment.name] = rest.join("/");
      return params;
    }
  }

  return pathParts.length === segments.length ? params : null;
}

/**
 * Cheap pre-check before a source is matched. It must never return false for
 * a pathname that the real matcher accepts.
 *
 * Every match starts with the literal text that comes before the segment of
 * the first param or group, so only that text is compared. The comparison
 * does not stop at a segment boundary: `/docs/:path*.md` matches `/docs.md`.
 */
export function simpleClientConfigSourceCouldMatch(pathname: string, source: string): boolean {
  if (NOT_PRINTABLE_ASCII.test(source + pathname)) return true;
  const syntaxIndex = source.search(SOURCE_SYNTAX);
  const literalText =
    syntaxIndex === -1
      ? source
      : source.slice(0, Math.max(0, source.lastIndexOf("/", syntaxIndex)));
  // The real matcher collapses repeated slashes in the pathname. Trailing
  // slashes are removed from both sides, so that a doubled slash in the
  // source (`/a//:x*`) does not ask the pathname for a slash it has lost.
  const literalPrefix = removeTrailingSlash(literalText).toLowerCase();
  const collapsedPathname = pathname.replace(/\/{2,}/g, "/");
  return removeTrailingSlash(collapsedPathname).toLowerCase().startsWith(literalPrefix);
}
