/**
 * Synchronous fast path for matching next.config.js sources during Pages
 * client navigation, without loading config-matchers.
 *
 * It must agree exactly with the server matcher (path-to-regexp, case-
 * insensitive, optional trailing slash), so it only handles sources built
 * from whole-segment literals, `:name` segments and a final `:name*` or
 * `:name+`. Any other source returns `undefined` so the caller defers to the
 * exact async matcher.
 */

// Whole-segment literals path-to-regexp reads as plain text.
const LITERAL_SEGMENT_RE = /^[A-Za-z0-9_~.%@!$&',;=[\]|)-]+$/;
const PARAM_SEGMENT_RE = /^:(\w+)$/;
const CATCH_ALL_SEGMENT_RE = /^:(\w+)([*+])$/;

function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function stripOneTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/**
 * Match `pathname` against `source`. Returns the params, `null` when the
 * source cannot match, or `undefined` when the source is outside the shapes
 * this fast path models.
 */
export function matchSimpleClientConfigSource(
  pathname: string,
  source: string,
): Record<string, string> | null | undefined {
  if (!source.startsWith("/") || pathname.includes("//")) return undefined;
  // The compiled source accepts one optional trailing slash on the pathname.
  const path = stripOneTrailingSlash(pathname);
  if (source === "/") return path === "/" ? Object.create(null) : null;

  const sourceParts = source.split("/");
  // An unmodelled segment may change how earlier ones match (`/foo/:id?bar`
  // matches `/foobar`), so check every segment's shape first.
  for (let index = 1; index < sourceParts.length; index++) {
    const sourcePart = sourceParts[index]!;
    if (CATCH_ALL_SEGMENT_RE.test(sourcePart)) {
      if (index !== sourceParts.length - 1) return undefined;
    } else if (!PARAM_SEGMENT_RE.test(sourcePart) && !LITERAL_SEGMENT_RE.test(sourcePart)) {
      return undefined;
    }
  }
  const pathParts = path.split("/");
  // Null prototype, so a `:__proto__` param is stored as an own value.
  const params: Record<string, string> = Object.create(null);

  for (let index = 1; index < sourceParts.length; index++) {
    const sourcePart = sourceParts[index]!;
    const pathPart = pathParts[index];

    const catchAll = CATCH_ALL_SEGMENT_RE.exec(sourcePart);
    if (catchAll) {
      if (index !== sourceParts.length - 1) return undefined;
      const rest = pathParts.slice(index).join("/");
      if (catchAll[2] === "+" && rest === "") return null;
      // An empty `*` is an unmatched param to the exact matcher, which then
      // may append the other params to the rewrite query.
      if (rest === "") return undefined;
      // Duplicate names keep the last capture that matched; leave them to
      // the exact matcher.
      if (catchAll[1]! in params) return undefined;
      params[catchAll[1]!] = rest;
      return params;
    }

    const param = PARAM_SEGMENT_RE.exec(sourcePart);
    if (param) {
      if (pathPart === undefined || pathPart === "") return null;
      if (param[1]! in params) return undefined;
      params[param[1]!] = pathPart;
      continue;
    }

    // Also rejects an empty segment, so a slash-ending source defers.
    if (!LITERAL_SEGMENT_RE.test(sourcePart)) return undefined;
    // ASCII-only folding: a case-insensitive RegExp without the `u` flag never
    // matches a non-ASCII character against an ASCII literal.
    if (pathPart === undefined || asciiLowerCase(pathPart) !== asciiLowerCase(sourcePart)) {
      return null;
    }
  }

  return pathParts.length === sourceParts.length ? params : null;
}

/**
 * Whether a rewrite to `destination` appends the source `params` to its
 * query. Next.js does that when the destination's path, host and hash use
 * none of them, for each param its query does not already name; the sync
 * path does not, so it defers these rewrites.
 */
export function clientRewriteAppendsParams(
  destination: string,
  params: Record<string, string>,
): boolean {
  // Like the server, the i18n locale param never triggers the append.
  const keys = Object.keys(params).filter((key) => key !== "nextInternalLocale");
  if (keys.length === 0) return false;
  const hashIndex = destination.indexOf("#");
  const beforeHash = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  const withoutQuery =
    (queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex)) +
    (hashIndex === -1 ? "" : destination.slice(hashIndex));
  // Fast-path param names are `\w+`, so they need no escaping.
  if (keys.some((key) => new RegExp(`:${key}(?![A-Za-z0-9_])`).test(withoutQuery))) return false;
  const queryKeys = new Set(
    queryIndex === -1 ? [] : new URLSearchParams(beforeHash.slice(queryIndex + 1)).keys(),
  );
  return keys.some((key) => !queryKeys.has(key));
}

/** The index just past the balanced `(...)` group at `start`, or -1 if unclosed. */
function customPatternEnd(source: string, start: number): number {
  let depth = 0;
  let inClass = false;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (character === "\\") index++;
    else if (inClass) inClass = character !== "]";
    else if (character === "[") inClass = true;
    else if (character === "(") depth++;
    else if (character === ")" && --depth === 0) return index + 1;
  }
  return -1;
}

/**
 * Cheap pre-check: false only when `source` can never match `pathname`.
 * Every match starts with the source's literal text up to its first param,
 * group or escape. A `/` or `.` right before a `:name?` or `:name*` param
 * (custom pattern or not) is that param's optional prefix, so it is only
 * required when the param is read. The rest of the pathname then starts with
 * that prefix or with the literal character after the param; when the param
 * ends the source, the rest may instead be empty or one trailing slash.
 */
export function clientConfigSourceCouldMatch(pathname: string, source: string): boolean {
  const wildcardIndex = source.search(/[:(\\{*+?]/);
  let literalPrefix = wildcardIndex === -1 ? source : source.slice(0, wildcardIndex);
  let optionalPrefix: string | null = null;
  // The character that must follow a skippable param, "" when it ends the
  // source, or null when unknown: a special character, or one followed by a
  // param or group, as a `/` or `.` there is that next param's prefix.
  let after: string | null = null;
  if (wildcardIndex !== -1 && /[/.]$/.test(literalPrefix)) {
    const name = /^:\w+/.exec(source.slice(wildcardIndex));
    let end = name ? wildcardIndex + name[0].length : -1;
    if (name && source[end] === "(") end = customPatternEnd(source, end);
    const modifier = end === -1 ? undefined : source[end];
    const optional = modifier === "?" || modifier === "*";
    if (end === -1 || optional) {
      optionalPrefix = literalPrefix.slice(-1);
      const next = source[end + 1] ?? "";
      if (optional && !/[:(){}*+?\\]/.test(next + (source[end + 2] ?? ""))) after = next;
      literalPrefix = literalPrefix.slice(0, -1);
    }
  }
  // The whole literal text, a trailing slash included, must be there; the
  // pathname's own extra trailing slash is just more text after it.
  if (literalPrefix === "/" && optionalPrefix === null) return true;
  if (!isAscii(literalPrefix)) return true;
  const path = asciiLowerCase(pathname);
  const prefix = literalPrefix === "/" ? "" : asciiLowerCase(literalPrefix);
  if (!path.startsWith(prefix)) return false;
  if (after === null) return true;
  const rest = path.slice(prefix.length);
  if (rest.startsWith(optionalPrefix!)) return true;
  if (after === "") return rest === "" || rest === "/";
  return !isAscii(after) || rest.startsWith(asciiLowerCase(after));
}
