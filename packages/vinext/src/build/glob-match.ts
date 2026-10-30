/**
 * Include-glob semantics of Next.js's compiled `glob` (node-glob 7), which
 * expands `outputFileTracingIncludes` in `collect-build-traces.ts`.
 *
 * node-glob 7 compiles each pattern with minimatch 3.1: braces are expanded
 * with brace-expansion 1.1 (which uses balanced-match 1.0), the result is split
 * on `/`, and each segment is compiled by minimatch's `parse` into a literal,
 * a regular expression, or a globstar. This module ports those three steps
 * statement by statement from the copies bundled in
 * `next/dist/compiled/glob`, with the options Next.js passes (`dot: true`;
 * node-glob also sets `nonegate`), so include globs select exactly the files
 * Next.js selects, upstream quirks included. One deliberate difference: a
 * brace range with a zero step (`{1..3..0}`) never terminates upstream, and
 * steps by one here.
 *
 * The directory walk itself lives in `trace-glob.ts` (`globFiles`).
 */

// --- balanced-match 1.0 -----------------------------------------------------

type Balanced = { pre: string; body: string; post: string };

function balancedRange(str: string): [number, number] | undefined {
  let open = str.indexOf("{");
  let close = str.indexOf("}", open + 1);
  let index = open;
  let result: [number, number] | undefined;
  if (open >= 0 && close > 0) {
    const begins: number[] = [];
    let left = str.length;
    let right = 0;
    while (index >= 0 && !result) {
      if (index === open) {
        begins.push(index);
        open = str.indexOf("{", index + 1);
      } else if (begins.length === 1) {
        result = [begins.pop()!, close];
      } else {
        const begin = begins.pop()!;
        if (begin < left) {
          left = begin;
          right = close;
        }
        close = str.indexOf("}", index + 1);
      }
      index = open < close && open >= 0 ? open : close;
    }
    if (begins.length) result = [left, right];
  }
  return result;
}

function balanced(str: string): Balanced | undefined {
  const range = balancedRange(str);
  return (
    range && {
      pre: str.slice(0, range[0]),
      body: str.slice(range[0] + 1, range[1]),
      post: str.slice(range[1] + 1),
    }
  );
}

// --- brace-expansion 1.1 ----------------------------------------------------

const ESC_SLASH = "\0SLASH\0";
const ESC_OPEN = "\0OPEN\0";
const ESC_CLOSE = "\0CLOSE\0";
const ESC_COMMA = "\0COMMA\0";
const ESC_PERIOD = "\0PERIOD\0";

function numeric(str: string): number {
  const value = parseInt(str, 10);
  return value === Number(str) ? value : str.charCodeAt(0);
}

function escapeBraces(str: string): string {
  return str
    .split("\\\\")
    .join(ESC_SLASH)
    .split("\\{")
    .join(ESC_OPEN)
    .split("\\}")
    .join(ESC_CLOSE)
    .split("\\,")
    .join(ESC_COMMA)
    .split("\\.")
    .join(ESC_PERIOD);
}

function unescapeBraces(str: string): string {
  return str
    .split(ESC_SLASH)
    .join("\\")
    .split(ESC_OPEN)
    .join("{")
    .split(ESC_CLOSE)
    .join("}")
    .split(ESC_COMMA)
    .join(",")
    .split(ESC_PERIOD)
    .join(".");
}

function parseCommaParts(str: string): string[] {
  if (!str) return [""];
  const match = balanced(str);
  if (!match) return str.split(",");
  const parts = match.pre.split(",");
  parts[parts.length - 1] += `{${match.body}}`;
  const postParts = parseCommaParts(match.post);
  if (match.post.length) {
    parts[parts.length - 1] += postParts.shift();
    parts.push(...postParts);
  }
  return parts;
}

const isPadded = (value: string): boolean => /^-?0\d/.test(value);

function expand(str: string, isTop: boolean): string[] {
  const match = balanced(str);
  if (!match || match.pre.endsWith("$")) return [str];
  const isNumericSequence = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(match.body);
  const isAlphaSequence = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(match.body);
  const isSequence = isNumericSequence || isAlphaSequence;
  const isOptions = match.body.includes(",");
  if (!isSequence && !isOptions) {
    // {a},b}
    if (/,.*\}/.test(match.post)) {
      return expand(`${match.pre}{${match.body}${ESC_CLOSE}${match.post}`, false);
    }
    return [str];
  }

  let parts: string[];
  if (isSequence) {
    parts = match.body.split(/\.\./);
  } else {
    parts = parseCommaParts(match.body);
    if (parts.length === 1) {
      // x{{a,b}}y ==> x{a}y x{b}y
      parts = expand(parts[0], false).map((part) => `{${part}}`);
      if (parts.length === 1) {
        const post = match.post.length ? expand(match.post, false) : [""];
        return post.map((rest) => match.pre + parts[0] + rest);
      }
    }
  }

  const post = match.post.length ? expand(match.post, false) : [""];
  let values: string[];
  if (isSequence) {
    const start = numeric(parts[0]);
    const end = numeric(parts[1]);
    const width = Math.max(parts[0].length, parts[1].length);
    let step = parts.length === 3 ? Math.abs(numeric(parts[2])) || 1 : 1;
    const reverse = end < start;
    if (reverse) step *= -1;
    const pad = parts.some(isPadded);
    values = [];
    for (let value = start; reverse ? value >= end : value <= end; value += step) {
      let item: string;
      if (isAlphaSequence) {
        item = String.fromCharCode(value);
        if (item === "\\") item = "";
      } else {
        item = String(value);
        if (pad) {
          const need = width - item.length;
          if (need > 0) {
            const zeros = "0".repeat(need);
            item = value < 0 ? `-${zeros}${item.slice(1)}` : zeros + item;
          }
        }
      }
      values.push(item);
    }
  } else {
    values = parts.flatMap((part) => expand(part, false));
  }

  const expansions: string[] = [];
  for (const value of values) {
    for (const rest of post) {
      const expansion = match.pre + value + rest;
      if (!isTop || isSequence || expansion) expansions.push(expansion);
    }
  }
  return expansions;
}

/** minimatch 3.1 `braceExpand`: brace-expansion's `expandTop`, when braces are present. */
export function braceExpand(pattern: string): string[] {
  if (!/\{(?:(?!\{).)*\}/.test(pattern)) return [pattern];
  let str = pattern;
  if (!str) return [];
  if (str.startsWith("{}")) str = `\\{\\}${str.slice(2)}`;
  return expand(escapeBraces(str), true).map(unescapeBraces);
}

// --- minimatch 3.1 `parse` --------------------------------------------------

export type GlobSegment =
  | { kind: "globstar" }
  | { kind: "literal"; value: string }
  | { kind: "pattern"; regex: RegExp };

type PatternList = {
  type: string;
  reStart: number;
  open: string;
  close: string;
  reEnd: number;
};

const PATTERN_LIST_TYPES: Record<string, { open: string; close: string }> = {
  "!": { open: "(?:(?!(?:", close: "))[^/]*?)" },
  "?": { open: "(?:", close: ")?" },
  "+": { open: "(?:", close: ")+" },
  "*": { open: "(?:", close: ")*" },
  "@": { open: "(?:", close: ")" },
};
const QMARK = "[^/]";
const STAR = `${QMARK}*?`;
const RE_SPECIALS = new Set("().*{}+?[]^$\\!");

function globUnescape(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

function parseSource(pattern: string, isSub: boolean): { source: string; hasMagic: boolean } {
  let re = "";
  let hasMagic = false;
  let escaping = false;
  const patternListStack: PatternList[] = [];
  const negativeLists: PatternList[] = [];
  let stateChar = "";
  let inClass = false;
  let reClassStart = -1;
  let classStart = -1;
  // `dot: true`: only `.` and `..` are excluded.
  const patternStart = pattern.charAt(0) === "." ? "" : "(?!(?:^|\\/)\\.{1,2}(?:$|\\/))";

  const clearStateChar = (): void => {
    if (!stateChar) return;
    if (stateChar === "*") {
      re += STAR;
      hasMagic = true;
    } else if (stateChar === "?") {
      re += QMARK;
      hasMagic = true;
    } else {
      re += `\\${stateChar}`;
    }
    stateChar = "";
  };

  for (let index = 0; index < pattern.length; index++) {
    let char = pattern.charAt(index);
    if (escaping && RE_SPECIALS.has(char)) {
      re += `\\${char}`;
      escaping = false;
      continue;
    }
    switch (char) {
      case "\\":
        clearStateChar();
        escaping = true;
        continue;
      case "?":
      case "*":
      case "+":
      case "@":
      case "!":
        if (inClass) {
          if (char === "!" && index === classStart + 1) char = "^";
          re += char;
          continue;
        }
        clearStateChar();
        stateChar = char;
        continue;
      case "(": {
        if (inClass) {
          re += "(";
          continue;
        }
        if (!stateChar) {
          re += "\\(";
          continue;
        }
        const { open, close } = PATTERN_LIST_TYPES[stateChar];
        patternListStack.push({ type: stateChar, reStart: re.length, open, close, reEnd: -1 });
        re += stateChar === "!" ? "(?:(?!(?:" : "(?:";
        stateChar = "";
        continue;
      }
      case ")": {
        if (inClass || !patternListStack.length) {
          re += "\\)";
          continue;
        }
        clearStateChar();
        hasMagic = true;
        const list = patternListStack.pop()!;
        re += list.close;
        if (list.type === "!") negativeLists.push(list);
        list.reEnd = re.length;
        continue;
      }
      case "|":
        if (inClass || !patternListStack.length || escaping) {
          re += "\\|";
          escaping = false;
          continue;
        }
        clearStateChar();
        re += "|";
        continue;
      case "[":
        clearStateChar();
        if (inClass) {
          re += `\\${char}`;
          continue;
        }
        inClass = true;
        classStart = index;
        reClassStart = re.length;
        re += char;
        continue;
      case "]": {
        if (index === classStart + 1 || !inClass) {
          re += `\\${char}`;
          escaping = false;
          continue;
        }
        const classBody = pattern.substring(classStart + 1, index);
        try {
          new RegExp(`[${classBody}]`);
        } catch {
          const sub = parseSource(classBody, true);
          re = `${re.slice(0, reClassStart)}\\[${sub.source}\\]`;
          hasMagic = hasMagic || sub.hasMagic;
          inClass = false;
          continue;
        }
        hasMagic = true;
        inClass = false;
        re += char;
        continue;
      }
      default:
        clearStateChar();
        if (escaping) escaping = false;
        else if (RE_SPECIALS.has(char) && !(char === "^" && inClass)) re += "\\";
        re += char;
    }
  }

  // An unterminated class matches its `[` literally.
  if (inClass) {
    const sub = parseSource(pattern.slice(classStart + 1), true);
    re = `${re.slice(0, reClassStart)}\\[${sub.source}`;
    hasMagic = hasMagic || sub.hasMagic;
  }

  // An unterminated extglob matches its type character and `(` literally.
  for (let list = patternListStack.pop(); list; list = patternListStack.pop()) {
    let tail = re.slice(list.reStart + list.open.length);
    tail = tail.replace(
      /((?:\\{2}){0,64})(\\?)\|/g,
      (_, slashes: string, escape: string) => `${slashes}${slashes}${escape || "\\"}|`,
    );
    const prefix = list.type === "*" ? STAR : list.type === "?" ? QMARK : `\\${list.type}`;
    hasMagic = true;
    re = `${re.slice(0, list.reStart)}${prefix}\\(${tail}`;
  }

  clearStateChar();
  if (escaping) re += "\\\\";

  const addPatternStart = re.charAt(0) === "[" || re.charAt(0) === "." || re.charAt(0) === "(";

  // A negated extglob must also fail together with what follows it.
  for (let index = negativeLists.length - 1; index > -1; index--) {
    const list = negativeLists[index];
    const before = re.slice(0, list.reStart);
    const first = re.slice(list.reStart, list.reEnd - 8);
    let after = re.slice(list.reEnd);
    const last = re.slice(list.reEnd - 8, list.reEnd) + after;
    const openParensBefore = before.split("(").length - 1;
    for (let count = 0; count < openParensBefore; count++) after = after.replace(/\)[+*?]?/, "");
    const dollar = after === "" && !isSub ? "$" : "";
    re = before + first + after + dollar + last;
  }

  if (re !== "" && hasMagic) re = `(?=.)${re}`;
  if (addPatternStart) re = patternStart + re;
  return { source: re, hasMagic };
}

function parseSegment(segment: string): GlobSegment {
  if (segment === "**") return { kind: "globstar" };
  if (segment === "") return { kind: "literal", value: "" };
  const { source, hasMagic } = parseSource(segment, false);
  if (!hasMagic) return { kind: "literal", value: globUnescape(segment) };
  let regex: RegExp;
  try {
    regex = new RegExp(`^${source}$`);
  } catch {
    regex = /$./;
  }
  return { kind: "pattern", regex };
}

/**
 * Compile an include glob the way node-glob 7 does (minimatch's `set`): one
 * list of segments per brace expansion.
 */
export function compileGlob(pattern: string): GlobSegment[][] {
  return braceExpand(pattern).map((expanded) => expanded.split(/\/+/).map(parseSegment));
}
