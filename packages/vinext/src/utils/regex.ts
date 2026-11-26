export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `RegExp#source` also escapes `/`.
const EXACT_REGEXP_SOURCE_RE = /^\^((?:\\[.*+?^${}()|[\]\\/]|[^.*+?^${}()|[\]\\])*)\$$/;
// Exact tsconfig `paths` keys also match before a query/hash.
const QUERY_AWARE_EXACT_REGEXP_SOURCE_RE =
  /^\^((?:\\[.*+?^${}()|[\]\\/]|[^.*+?^${}()|[\]\\])*)\(\?=\[\?#\]\|\$\)$/;

/**
 * Return the literal a RegExp matches when it is just `^literal$` (as built
 * from `escapeRegExp`), or null for any other pattern.
 */
export function exactRegExpLiteral(pattern: RegExp): string | null {
  return regExpLiteral(pattern, EXACT_REGEXP_SOURCE_RE);
}

/**
 * Return the literal of a `^literal(?=[?#]|$)` RegExp, which matches the
 * literal alone or followed by a query or hash, or null for any other pattern.
 */
export function queryAwareExactRegExpLiteral(pattern: RegExp): string | null {
  return regExpLiteral(pattern, QUERY_AWARE_EXACT_REGEXP_SOURCE_RE);
}

// `^literal/`, as built for declaration-only wildcard tsconfig `paths` keys.
const PREFIX_REGEXP_SOURCE_RE = /^\^((?:\\[.*+?^${}()|[\]\\/]|[^.*+?^${}()|[\]\\])*\\\/)$/;

/**
 * Return the literal prefix (ending in `/`) a RegExp matches when it is just
 * `^literal/` (as built from `escapeRegExp`), or null for any other pattern.
 */
export function prefixRegExpLiteral(pattern: RegExp): string | null {
  return regExpLiteral(pattern, PREFIX_REGEXP_SOURCE_RE);
}

function regExpLiteral(pattern: RegExp, sourceRe: RegExp): string | null {
  // Flags such as `i` and `m` widen what the anchored literal matches.
  if (pattern.flags !== "") return null;
  const body = sourceRe.exec(pattern.source)?.[1];
  return body === undefined ? null : body.replace(/\\(.)/g, "$1");
}
