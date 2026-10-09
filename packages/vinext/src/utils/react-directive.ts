/**
 * Returns the leading React `"use client"` or `"use server"` directive after
 * stripping leading comments, hashbang, and whitespace.
 *
 * Used by `vinext:jsx-in-js` to opt `.js` files inside `node_modules` into the
 * JSX transform, and to find `"use server"` modules in client builds. We
 * mirror `@vitejs/plugin-rsc`'s detection by looking at the directive prologue
 * rather than scanning the whole file — `code.includes` alone would match
 * incidental occurrences in template literals or comments.
 */
export function getLeadingReactDirective(code: string): "use client" | "use server" | null {
  let i = 0;
  const len = code.length;
  // Strip BOM.
  if (code.charCodeAt(0) === 0xfeff) i = 1;
  // Strip hashbang.
  if (code[i] === "#" && code[i + 1] === "!") {
    const nl = code.indexOf("\n", i);
    if (nl === -1) return null;
    i = nl + 1;
  }
  while (i < len) {
    // Skip whitespace.
    while (i < len && /\s/.test(code[i] ?? "")) i++;
    if (i >= len) return null;
    // Skip line comments.
    if (code[i] === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i + 2);
      if (nl === -1) return null;
      i = nl + 1;
      continue;
    }
    // Skip block comments.
    if (code[i] === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    // At first non-comment, non-whitespace token. Must be a string literal
    // directive to qualify (per ECMA-262 Directive Prologue grammar).
    const quote = code[i];
    if (quote !== '"' && quote !== "'") return null;
    const closing = code.indexOf(quote, i + 1);
    if (closing === -1) return null;
    const directive = code.slice(i + 1, closing);
    if (directive === "use client" || directive === "use server") return directive;
    // Other directives (e.g., "use strict") may precede the React directive.
    // Continue scanning past the statement-terminating `;` or newline.
    i = closing + 1;
    while (i < len && (code[i] === ";" || code[i] === " " || code[i] === "\t")) i++;
    if (code[i] === "\n") i++;
  }
  return null;
}

export function hasReactDirective(code: string): boolean {
  return getLeadingReactDirective(code) !== null;
}
