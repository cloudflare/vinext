import fs from "node:fs";
import path from "pathslash";
import { compileGlob, type GlobSegment } from "./glob-match.js";

/**
 * Glob matching for `outputFileTracingIncludes` / `outputFileTracingExcludes`,
 * following the options Next.js uses in `collect-build-traces.ts`:
 *
 * - Include globs are expanded with node-glob 7 (Next.js's compiled `glob`),
 *   `glob(pattern, { cwd: dir, nodir: true, dot: true })` ({@link globFiles}).
 *   Patterns compile through the minimatch port in `glob-match.ts`, and the
 *   walk follows node-glob: wildcards and `**` match dot entries, directories
 *   are never results, and a symlinked directory is read like any other
 *   directory, except that `**` does not recurse below a symlinked directory
 *   it reached itself (the link's direct children still match the rest of the
 *   pattern).
 * - Route keys and exclude globs are matched with picomatch 4,
 *   `picomatch(pattern, { dot: true, contains: true })`
 *   ({@link createContainsMatcher}, {@link createPathMatcher}): the pattern
 *   may match anywhere in the route name or absolute file path. This
 *   translates picomatch's output for the syntax below rather than porting
 *   its parser.
 *
 * Supported picomatch syntax: `*`, `**`, `?`, `[...]` classes, `{a,b}` lists
 * and `{a..b}` ranges, `(...)` groups and the `@()`, `?()`, `+()`, `*()` and
 * `!()` extglobs within one path segment (optionally followed by a `?` or `+`
 * quantifier), and backslash escapes. {@link isTranslatedExactly} detects
 * the shapes this does not cover.
 */

const REGEX_SPECIAL_CHARS = /[\\^$.*+?()[\]{}|]/g;

function escapeRegex(value: string): string {
  return value.replace(REGEX_SPECIAL_CHARS, "\\$&");
}

/**
 * picomatch compiles `{a..b}` to the class of its sorted bounds (`[a-b]`), or
 * to the literal bounds when that class is not a valid regex (`{01..03}`).
 */
function picomatchRange(body: string): string | null {
  if (!body.includes("..") || /[{},]/.test(body)) return null;
  const bounds = body.split("..");
  if (bounds.includes("")) return null;
  bounds.sort();
  const range = `[${bounds.join("-")}]`;
  try {
    new RegExp(range);
    return range;
  } catch {
    return bounds.join("..").replace(/[\\*?[\]{}()!@+|^$]/g, "\\$&");
  }
}

/** Expand picomatch `{a,b}` lists, and compile `{a..b}` ranges to a class. */
function expandBraces(pattern: string): string[] {
  for (let open = 0; open < pattern.length; open++) {
    if (pattern[open] === "\\") {
      open++;
      continue;
    }
    if (pattern[open] !== "{") continue;

    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    for (let index = open; index < pattern.length; index++) {
      const char = pattern[index];
      if (char === "\\") index++;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        close = index;
        break;
      } else if (char === "," && depth === 1) commas.push(index);
    }
    if (close === -1) return [pattern];

    const before = pattern.slice(0, open);
    const after = pattern.slice(close + 1);
    const body = pattern.slice(open + 1, close);
    let options: string[] | null = null;
    if (commas.length > 0) {
      options = [];
      let start = open + 1;
      for (const end of [...commas, close]) {
        options.push(pattern.slice(start, end));
        start = end + 1;
      }
    } else {
      const range = picomatchRange(body);
      if (range !== null) options = [range];
    }
    if (!options) {
      // A brace without a list or range (`{a}`) stays literal.
      return expandBraces(body).flatMap((inner) =>
        expandBraces(after).map((rest) => `${before}{${inner}}${rest}`),
      );
    }
    return options.flatMap((option) => expandBraces(before + option + after));
  }
  return [pattern];
}

// picomatch accepts the bracket text itself (`[id]` matches `i`, `d` or
// `[id]`) unless the class contains a range or other regex character, and
// reads `!` literally (only `^` negates).
const PICOMATCH_CLASS_REGEX_CHARS = /[-*+?.^${}(|)[\]]/;

function parseClass(segment: string, open: number): { source: string; end: number } | null {
  let index = open + 1;
  let negate = false;
  if (segment[index] === "^") {
    negate = true;
    index++;
  }
  let body = "";
  let raw = "";
  for (let first = true; index < segment.length; index++, first = false) {
    const char = segment[index];
    if (char === "]" && !first) {
      // picomatch adds the `/` after the body, so it never ends a range.
      const source = negate ? `[^${body}/]` : `[${body}]`;
      if (!negate && !PICOMATCH_CLASS_REGEX_CHARS.test(raw)) {
        return { source: `(?:${escapeRegex(`[${raw}]`)}|${source})`, end: index };
      }
      return { source, end: index };
    }
    raw += char;
    if (char === "\\" && index + 1 < segment.length) {
      const escaped = segment[++index];
      raw += escaped;
      body += /[\]\\^-]/.test(escaped) ? `\\${escaped}` : escapeRegex(escaped);
      continue;
    }
    // picomatch escapes a `-` that closes the class (`[^a-]` is `[^a\-/]`).
    const isLiteral = char === "[" || char === "^" || char === "\\" || char === "]";
    body += isLiteral || (char === "-" && segment[index + 1] === "]") ? `\\${char}` : char;
  }
  return null;
}

// The rest of a pattern that picomatch reads as an extension after a negative
// extglob (`/^\.[^\\/.]+$/`), limited to literal text.
const PLAIN_EXTENSION = /^\.[^\\/.*?+@![\](){}|,]+$/;
const PICOMATCH_EXTENSION = /^\.[^\\/.]+$/;

function parseExtglob(
  segment: string,
  start: number,
  endsPattern: boolean,
): { alternatives: string[]; end: number } | null {
  const alternatives: string[] = [];
  let index = start;
  for (;;) {
    const part = parseSegment(segment, index, endsPattern, true);
    alternatives.push(part.source);
    index = part.end;
    if (index >= segment.length) return null;
    if (segment[index] === ")") return { alternatives, end: index };
    index++;
  }
}

/**
 * Translate one path segment (or, inside an extglob, one alternative) of a
 * picomatch pattern into regex source. `endsPattern` is true for the last
 * segment of the pattern, and `atPatternStart` for a segment the pattern
 * starts with.
 */
function parseSegment(
  segment: string,
  start: number,
  endsPattern: boolean,
  inExtglob = false,
  atPatternStart = false,
): { source: string; end: number } {
  let source = "";
  let index = start;
  while (index < segment.length) {
    const char = segment[index];
    if (inExtglob && (char === "|" || char === ")")) break;
    if (char === "\\" && index + 1 < segment.length) {
      source += escapeRegex(segment[index + 1]);
      index += 2;
      continue;
    }
    const isExtglob = "@?+*!".includes(char) && segment[index + 1] === "(";
    if (isExtglob || char === "(") {
      // A bare `(...)` is a regex group, like `@(...)`.
      const kind = isExtglob ? char : "@";
      const group = parseExtglob(segment, index + (isExtglob ? 2 : 1), endsPattern);
      if (group) {
        const alternatives = group.alternatives.join("|");
        // picomatch makes an extglob that starts the pattern (other than
        // `@()`, which it reads as a plain group) match at least one character.
        if (atPatternStart && index === 0 && kind !== "@") source += "(?=.)";
        const rest = segment.slice(group.end + 1);
        if (kind !== "!") {
          source += `(?:${alternatives})${kind === "@" ? "" : kind}`;
        } else if (endsPattern && /^\)*$/.test(rest)) {
          // picomatch only anchors the lookahead when nothing but closing
          // parentheses follows in the pattern.
          source += `(?:(?!(?:${alternatives})$))[^/]*?`;
        } else if (
          endsPattern &&
          segment.slice(index, group.end).includes("*") &&
          PLAIN_EXTENSION.test(rest)
        ) {
          // With a `*` inside, picomatch also checks the extension that ends
          // the pattern in the lookahead (`!(*a).js`).
          source += `(?:(?!(?:${alternatives})${escapeRegex(rest)})[^/]*?)`;
        } else {
          source += `(?:(?!(?:${alternatives}))[^/]*?)`;
        }
        index = group.end + 1;
        // A `?` or `+` right after the group quantifies it, unless it starts
        // another extglob.
        if ((segment[index] === "?" || segment[index] === "+") && segment[index + 1] !== "(") {
          source += segment[index];
          index++;
        }
        continue;
      }
    }
    if (char === "*") {
      // A segment-leading wildcard matches at least one character, unless it
      // is a run of stars. Repeated stars collapse, except one that starts a
      // `*()` extglob.
      source += index === 0 && segment[1] !== "*" ? "(?=.)[^/]*" : "[^/]*";
      while (segment[index + 1] === "*" && segment[index + 2] !== "(") index++;
      index++;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index++;
      continue;
    }
    if (char === "[") {
      const charClass = parseClass(segment, index);
      if (charClass) {
        source += charClass.source;
        index = charClass.end + 1;
        continue;
      }
    }
    source += escapeRegex(char);
    index++;
  }
  return { source, end: index };
}

/** Whether a segment's last token is a wildcard (`*`, `a*`, `@(a)*`). */
function endsWithStar(segment: string | undefined): boolean {
  return segment !== undefined && /(?:^|[^\\])(?:\\\\)*\*$/.test(segment);
}

/**
 * Regex source for a brace-free picomatch glob, unanchored (`contains`).
 * `rooted` is false when the pattern continues a literal prefix, so a leading
 * `/` is a separator rather than the start of the value.
 */
function containsSource(pattern: string, rooted: boolean): string {
  const segments = pattern
    .split("/")
    .filter((segment, index, all) => !(segment === "**" && all[index - 1] === "**"));
  let source = "";
  // Whether the next segment starts after a `/` this function adds.
  let separate = false;
  segments.forEach((segment, index) => {
    if (segment === "**") {
      separate = false;
      if (segments.length === 1) source += ".*";
      // `**/x`: x at the start of the value or after any `/`.
      else if (index === 0) source += "(?:^|/)";
      // picomatch does not let a globstar right after a leading `/`, or after
      // a wildcard (`*/**`), match zero directories.
      else if (index === 1 && rooted && segments[0] === "") {
        source += "/.*";
        separate = true;
      } else if (index === segments.length - 1) {
        source += endsWithStar(segments[index - 1]) ? "/.*" : "(?:/.*|$)";
      }
      // `a/**/b`: b after `a/.../`, after `a/`, or (when b can match nothing)
      // at the end of the value.
      else source += "(?:/.*/|/|$)";
      return;
    }
    if (separate) source += "/";
    separate = true;
    const endsPattern = index === segments.length - 1;
    source += parseSegment(segment, 0, endsPattern, false, rooted && index === 0).source;
  });
  return source;
}

function toRegExp(source: string, literal: string): RegExp {
  try {
    return new RegExp(source);
  } catch {
    // An invalid class such as `[z-a]` matches itself literally.
    return new RegExp(escapeRegex(literal));
  }
}

// Characters with a meaning in the grammar `isTranslatedExactly` accepts; any
// other character is a literal.
const GRAMMAR_CHARS = "\\*?+@![](){}|/";
const MAX_BRACE_COMBINATIONS = 256;

/**
 * Whether {@link createContainsMatcher} and {@link createPathMatcher} match a
 * pattern exactly like picomatch. This is an allowlist: the pattern may only
 * use the grammar below, which `tests/trace-glob.test.ts` checks against
 * picomatch. Anything else fails safe in the caller.
 *
 * - literal characters (including an unmatched `]`), and backslash escapes of
 *   punctuation other than `/` and `\` (picomatch keeps regex escapes such
 *   as `\d`);
 * - `*` and `?`, and `**` as a whole path segment outside braces and groups;
 * - classes (`[ab]`, `[^a-c]`) without escapes, `/`, braces or POSIX classes,
 *   not followed by `+`;
 * - `(...)` groups and `@()`, `?()`, `+()`, `*()` and `!()` extglobs, nested
 *   or not, whose alternatives use this grammar without `/`, braces, `+` or a
 *   leading `?`, optionally followed by one `?` or `+` quantifier; a `!()`
 *   with a `*` inside that ends the pattern before an extension needs a
 *   literal extension (`!(*a).js`);
 * - top-level brace lists (`{a,b}`) of non-empty options that use this
 *   grammar without `/`, groups, braces, `*`, `?`, `+`, `@`, `!` or `..`, and
 *   are not `.`; not followed by `+`; at most 256 combinations in all;
 * - no trailing `/` (other than the pattern `/`).
 */
export function isTranslatedExactly(pattern: string): boolean {
  let index = 0;
  const isBoundary = (at: number) => at < 0 || at >= pattern.length || pattern[at] === "/";

  const parseClass = (): boolean => {
    let at = index + 1;
    if (pattern[at] === "^") at++;
    for (let first = true; at < pattern.length; at++, first = false) {
      const char = pattern[at];
      if (
        char === "\\" ||
        char === "/" ||
        char === "{" ||
        char === "}" ||
        (char === "[" && pattern[at + 1] === ":")
      ) {
        return false;
      }
      if (char === "]" && !first) {
        index = at + 1;
        return pattern[index] !== "+";
      }
    }
    return false;
  };

  const parseGroup = (start: number): boolean => {
    index = start;
    for (;;) {
      if (pattern[index] === "?") return false;
      if (!parseSequence("group")) return false;
      if (pattern[index] === "|") {
        index++;
        continue;
      }
      if (pattern[index] !== ")") return false;
      index++;
      break;
    }
    // picomatch checks an extension after `!(...*...)` in the lookahead; only
    // a literal one is translated.
    const rest = pattern.slice(index);
    if (
      pattern[start - 2] === "!" &&
      pattern.slice(start, index).includes("*") &&
      PICOMATCH_EXTENSION.test(rest) &&
      !PLAIN_EXTENSION.test(rest)
    ) {
      return false;
    }
    if ((pattern[index] === "?" || pattern[index] === "+") && pattern[index + 1] !== "(") index++;
    return true;
  };

  // Brace lists are expanded into one regex per combination, so the number of
  // combinations is bounded.
  let combinations = 1;
  const parseBraces = (): boolean => {
    index++;
    for (let options = 1; ; options++) {
      const start = index;
      if (!parseSequence("brace")) return false;
      // Expansion would join an option with its neighbours into new tokens
      // (`?{,a}(b)`, `@(a){?,b}`), and `path.join` would normalize a `.`
      // option. picomatch also reads text around ranges (`{a..c}`) differently.
      const option = pattern.slice(start, index);
      if (option === "" || option === "." || option.includes("..") || /[*?+@!]/.test(option)) {
        return false;
      }
      if (pattern[index] === ",") {
        index++;
        continue;
      }
      if (pattern[index] !== "}") return false;
      index++;
      combinations *= options;
      return combinations <= MAX_BRACE_COMBINATIONS && pattern[index] !== "+";
    }
  };

  function parseSequence(context: "top" | "group" | "brace"): boolean {
    while (index < pattern.length) {
      const char = pattern[index];
      const next = pattern[index + 1];
      if (context === "group" && (char === "|" || char === ")")) return true;
      if (context === "brace" && (char === "," || char === "}")) return true;
      if (!GRAMMAR_CHARS.includes(char) || char === "?" || char === "@" || char === "!") {
        if ("?@!".includes(char) && next === "(") {
          if (context === "brace" || !parseGroup(index + 2)) return false;
        } else {
          index++;
        }
      } else if (char === "\\") {
        // picomatch keeps the backslash for regex escapes (`\d`), so only
        // escaped punctuation is a literal.
        if (next === undefined || next === "/" || next === "\\" || /\w/.test(next)) return false;
        index += 2;
      } else if (char === "(" || ((char === "*" || char === "+") && next === "(")) {
        if (context === "brace" || !parseGroup(index + (char === "(" ? 1 : 2))) return false;
      } else if (char === "*") {
        let end = index;
        while (pattern[end] === "*") end++;
        // A run of stars only reads as a globstar where it fills a segment.
        const isGlobstar = context === "top" && isBoundary(index - 1) && isBoundary(end);
        if (end - index > 1 && !isGlobstar) return false;
        index = end;
      } else if (char === "+") {
        // picomatch keeps `+` as a quantifier after a class, brace or group,
        // and inside a group.
        const previous = pattern[index - 1];
        if (context !== "top" || (GRAMMAR_CHARS.includes(previous ?? "/") && previous !== "/")) {
          return false;
        }
        index++;
      } else if (char === "[") {
        if (!parseClass()) return false;
      } else if (char === "{") {
        if (context !== "top" || !parseBraces()) return false;
      } else if (char === "/") {
        if (context !== "top") return false;
        index++;
      } else if (char === "]") {
        index++;
      } else {
        // An unmatched `)`, `}` or `|`.
        return false;
      }
    }
    return context === "top";
  }

  // picomatch treats a trailing `/` specially.
  if (pattern.length > 1 && pattern.endsWith("/")) return false;
  return parseSequence("top");
}

/**
 * Whether `picomatch(pattern)` (default options) matches all of `name`. Only
 * for names without `/` or a leading `.`, such as `next-server`, where those
 * options make no difference.
 */
export function matchesWholeName(pattern: string, name: string): boolean {
  if (name === pattern) return true;
  const { negated, expansions } = parseNegation(pattern);
  const matches = expansions.some((expanded) =>
    toRegExp(`^(?:${containsSource(expanded, true)})$`, expanded).test(name),
  );
  return matches !== negated;
}

/**
 * Leading `!`s (not starting a `!()` extglob) negate a picomatch pattern, and
 * picomatch drops leading `./` prefixes.
 */
function parseNegation(pattern: string): { negated: boolean; expansions: string[] } {
  let negated = false;
  let body = pattern;
  for (;;) {
    if (body.startsWith("./")) {
      body = body.slice(2);
    } else if (body.startsWith("!") && (body[1] !== "(" || body[2] === "?")) {
      negated = !negated;
      body = body.slice(1);
    } else {
      break;
    }
  }
  return { negated, expansions: expandBraces(body) };
}

/**
 * Match a value against a glob anywhere in the string, like
 * `picomatch(pattern, { dot: true, contains: true })`.
 */
export function createContainsMatcher(pattern: string): (value: string) => boolean {
  const { negated, expansions } = parseNegation(pattern);
  if (negated) {
    // picomatch then only rejects values the pattern matches at their start.
    const sources = expansions.map((expanded) => containsSource(expanded, true));
    const regex = toRegExp(`^(?!(?:${sources.join("|")})).*$`, pattern);
    return (value) => value !== "" && (value === pattern || regex.test(value));
  }
  const regexes = expansions.map((expanded) => toRegExp(containsSource(expanded, true), expanded));
  // picomatch also matches a value equal to the pattern itself.
  // picomatch never matches an empty value.
  return (value) =>
    value !== "" && (value === pattern || regexes.some((regex) => regex.test(value)));
}

/**
 * Match absolute file paths against project-relative globs. Like Next.js, each
 * glob is joined to the project root (`path.join(dir, glob)`) and may match
 * anywhere in the path. The root itself is matched literally, so a project
 * path containing glob characters still works.
 */
export function createPathMatcher(
  root: string,
  patterns: readonly string[],
): (file: string) => boolean {
  const base = path.resolve(root);
  const basePrefix = base.endsWith("/") ? base : `${base}/`;
  const joined = patterns.map((pattern) => path.join(base, pattern));
  const regexes = patterns.flatMap(expandBraces).map((pattern) => {
    const absolute = path.join(base, pattern);
    if (absolute.startsWith(basePrefix)) {
      const rest = absolute.slice(basePrefix.length - 1);
      return toRegExp(escapeRegex(base.replace(/\/$/, "")) + containsSource(rest, false), absolute);
    }
    return toRegExp(containsSource(absolute, true), absolute);
  });
  return (file) => joined.includes(file) || regexes.some((regex) => regex.test(file));
}

function readdirNames(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir);
  } catch {
    return null;
  }
}

function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    // Broken symlinks cannot be copied, so they are not results.
    return false;
  }
}

/**
 * Expand a glob from `cwd` into absolute file paths, like node-glob 7's
 * `glob.sync(pattern, { cwd, nodir: true, dot: true })`. Matched paths keep
 * the symlink names they were reached through.
 */
export function globFiles(cwd: string, pattern: string): string[] {
  const results = new Set<string>();
  for (const parts of compileGlob(pattern)) {
    // A trailing slash only matches directories, which `nodir` drops.
    if (parts.length > 1 && isEmptyLiteral(parts[parts.length - 1])) continue;

    let literalCount = 0;
    while (literalCount < parts.length && parts[literalCount].kind === "literal") literalCount++;
    const literalPrefix = parts
      .slice(0, literalCount)
      .map((part) => (part.kind === "literal" ? part.value : ""))
      .join("/");
    // Resolves absolute patterns (including drive letters) against cwd.
    const base = path.resolve(
      cwd,
      literalPrefix === "" && isEmptyLiteral(parts[0]) ? "/" : literalPrefix || ".",
    );

    const visited = new Set<string>();
    const walk = (dir: string, index: number, inGlobStar: boolean): void => {
      const key = `${index}\0${inGlobStar ? 1 : 0}\0${dir}`;
      if (visited.has(key)) return;
      visited.add(key);

      if (index === parts.length) {
        if (isFile(dir)) results.add(dir);
        return;
      }
      const part = parts[index];
      if (part.kind === "literal") {
        walk(path.join(dir, part.value), index + 1, inGlobStar);
        return;
      }
      if (part.kind === "pattern") {
        for (const name of readdirNames(dir) ?? []) {
          if (part.regex.test(name)) walk(path.join(dir, name), index + 1, inGlobStar);
        }
        return;
      }
      // `**` only applies below a readable directory. It matches no
      // directory, then each child either as the last directory it matches or
      // as one more level to recurse into.
      const names = readdirNames(dir);
      if (!names) return;
      walk(dir, index + 1, false);
      // node-glob does not recurse below a symlinked directory that `**`
      // itself reached, so link cycles terminate.
      if (inGlobStar && isSymlink(dir)) return;
      for (const name of names) {
        const child = path.join(dir, name);
        walk(child, index + 1, true);
        walk(child, index, true);
      }
    };
    walk(base, literalCount, false);
  }
  return [...results];
}

function isEmptyLiteral(part: GlobSegment | undefined): boolean {
  return part?.kind === "literal" && part.value === "";
}
