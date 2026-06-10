/**
 * Detects a Flow type-checker pragma (`// @flow`, `/* @flow *\/`, or `/** @flow *\/`)
 * in the **leading comment block** of a JavaScript file.
 *
 * Flow only recognises the pragma when it appears at or near the very top of the
 * file — in a leading line or block comment, optionally preceded by a BOM,
 * a hashbang line, leading whitespace, or other leading comments. A `@flow`
 * annotation buried inside a template literal, a string, or a mid-file comment
 * is NOT a valid Flow pragma and must not trigger the Babel fallback path.
 *
 * Detection algorithm (mirrors `hasReactDirective`):
 *   1. Skip BOM.
 *   2. Skip hashbang (`#!...`).
 *   3. Loop: skip whitespace and leading comments (both `//` and `/* ... *\/`).
 *      For each comment, check whether it contains `@flow` as a word-boundary
 *      token (`/@flow\b/`).  If found → return true.
 *   4. Once the first non-comment, non-whitespace token is reached → return false.
 *
 * This guarantees that `@flow` in mid-file comments, template literals, or
 * string arguments is never mistaken for a leading pragma.
 */
export function hasFlowPragma(code: string): boolean {
  let i = 0;
  const len = code.length;

  // Strip BOM.
  if (code.charCodeAt(0) === 0xfeff) i = 1;

  // Strip hashbang (`#!/usr/bin/env node`).
  if (code[i] === "#" && code[i + 1] === "!") {
    const nl = code.indexOf("\n", i);
    if (nl === -1) return false;
    i = nl + 1;
  }

  while (i < len) {
    // Skip whitespace.
    while (i < len && /\s/.test(code[i] ?? "")) i++;
    if (i >= len) return false;

    // Line comment: `// ...`
    if (code[i] === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i + 2);
      const commentText = nl === -1 ? code.slice(i + 2) : code.slice(i + 2, nl);
      // `@flow` followed by a word boundary — matches `@flow`, `@flow strict`,
      // `@flow weak` but not `@flowtype`.
      if (/@flow\b/.test(commentText)) {
        return true;
      }
      if (nl === -1) return false;
      i = nl + 1;
      continue;
    }

    // Block comment: `/* ... */` or `/** ... */`
    if (code[i] === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end === -1) return false;
      const commentText = code.slice(i + 2, end);
      if (/@flow\b/.test(commentText)) {
        return true;
      }
      i = end + 2;
      continue;
    }

    // First non-comment, non-whitespace token — not a leading pragma.
    return false;
  }

  return false;
}
