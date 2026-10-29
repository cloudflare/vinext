export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `RegExp#source` also escapes `/`.
const EXACT_REGEXP_SOURCE_RE = /^\^((?:\\[.*+?^${}()|[\]\\/]|[^.*+?^${}()|[\]\\])*)\$$/;

/**
 * Return the literal a RegExp matches when it is just `^literal$` (as built
 * from `escapeRegExp`), or null for any other pattern.
 */
export function exactRegExpLiteral(pattern: RegExp): string | null {
  // Flags such as `i` and `m` widen what `^literal$` matches.
  if (pattern.flags !== "") return null;
  const body = EXACT_REGEXP_SOURCE_RE.exec(pattern.source)?.[1];
  return body === undefined ? null : body.replace(/\\(.)/g, "$1");
}
