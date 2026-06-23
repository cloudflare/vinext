/**
 * Return the last syntactically significant character of a JS source fragment,
 * skipping whitespace and comments. A forward scan tracks string and comment
 * state so that `//` or `/*` sequences appearing INSIDE a string literal (e.g. a
 * URL such as `"https://example.com"` or a path with a double slash) are NOT
 * mistaken for comments.
 *
 * This is deliberately stricter than a whole-string comment strip: stripping
 * every `//...`/`/* ... *\/` would also delete those sequences from inside
 * string literals, which can swallow the real trailing comma that follows them
 * and corrupt the trailing-comma / empty-object detection this feeds.
 *
 * Returns "" for an empty / whitespace-only / comment-only fragment.
 */
export function lastSignificantChar(source: string): string {
  let last = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    // Line comment: skip to the end of the line.
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    // Block comment: skip to the closing `*/`.
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    // String / template literal: skip to the matching unescaped quote. The
    // literal counts as significant content (its closing quote is the token).
    if (c === '"' || c === "'" || c === "`") {
      i += 1;
      while (i < n && source[i] !== c) {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      last = c;
      i += 1;
      continue;
    }
    // Whitespace is not significant.
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    last = c;
    i += 1;
  }
  return last;
}

/**
 * True when `source` ends — ignoring trailing whitespace and comments — with a
 * real trailing comma. Used to avoid splicing a second comma (`,,` is a syntax
 * error) when injecting a property or argument into existing source.
 */
export function hasTrailingComma(source: string): boolean {
  return lastSignificantChar(source) === ",";
}
