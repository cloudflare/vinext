import path from "node:path";

import type { Plugin } from "vite";

/**
 * Strip the React `"use server"` directive from files that live outside the
 * App Router (`app/`) directory.
 *
 * Background: `"use server"` is an App Router-only feature. Pages Router does
 * not support Server Actions. In Next.js, the SWC `server-actions` transform
 * is only applied to files compiled in the App Router layer; Pages Router has
 * a separate bundling pipeline that ignores the directive. See
 * `packages/next/src/build/swc/options.ts` (`isAppRouterPagesLayer`).
 *
 * `@vitejs/plugin-rsc`'s `rsc:use-server` transform, however, fires on any
 * file whose source contains `"use server"`, regardless of where the file
 * lives. When a Pages Router page imports such a file, the export gets
 * rewritten into a server-reference proxy and calling it from
 * `getServerSideProps` throws "Server Functions cannot be called during
 * initial render."
 *
 * This plugin removes the directive prologue from files NOT under `app/`
 * BEFORE plugin-rsc's transform runs. With the directive gone, plugin-rsc's
 * cheap `code.includes("use server")` gate no longer fires, the module is
 * left untransformed, and exports behave as normal JavaScript.
 *
 * Ported in spirit from Next.js:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/build/swc/options.ts
 *
 * Regression test for https://github.com/cloudflare/vinext/issues/1476
 * (`test/e2e/app-dir/action-in-pages-router/action-in-pages-router.test.ts`
 * in the Next.js test suite).
 */
export function createStripNonAppUseServerPlugin(options: {
  getAppDir: () => string;
  hasAppDir: () => boolean;
}): Plugin {
  // Pre-normalize once configResolved fires so the per-transform path
  // comparison is cheap.
  let appDirWithSep = "";

  return {
    name: "vinext:strip-non-app-use-server",
    enforce: "pre",

    configResolved() {
      const appDir = options.getAppDir();
      if (appDir) appDirWithSep = appDir.endsWith(path.sep) ? appDir : appDir + path.sep;
    },

    transform(code, id) {
      // Cheap pre-check — most files don't carry the directive.
      if (!code.includes("use server")) return null;

      // Only relevant when an `app/` directory exists. Without one, the RSC
      // plugin is not even registered (see vinext()'s `earlyAppDirExists`
      // gate) and the directive is harmless.
      if (!options.hasAppDir()) return null;

      // Strip query string and any null-byte prefixes Vite/Rolldown attach
      // to virtual modules (e.g. `\0virtual:...`). Virtual modules are
      // never inside `app/`, so they fall through to the strip path.
      let cleanId = id;
      const queryIndex = cleanId.indexOf("?");
      if (queryIndex !== -1) cleanId = cleanId.slice(0, queryIndex);
      if (cleanId.startsWith("\0")) cleanId = cleanId.slice(1);

      // Files inside app/ are valid Server Action sources — leave them alone.
      if (appDirWithSep && cleanId.startsWith(appDirWithSep)) return null;

      // Locate and strip a `"use server"` directive prologue, if present.
      // We mirror ECMA-262's Directive Prologue rules: only the leading
      // ExpressionStatements consisting solely of a string literal qualify.
      const stripped = stripUseServerDirective(code);
      if (stripped === null) return null;

      return { code: stripped, map: null };
    },
  };
}

/**
 * Returns `code` with a leading `"use server"` (or `'use server'`) directive
 * removed, or `null` if no such directive is present at the top of the
 * module's Directive Prologue. Other directives (e.g. `"use strict"`,
 * `"use client"`) are preserved.
 */
function stripUseServerDirective(code: string): string | null {
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
    const directiveStart = i;
    const closing = code.indexOf(quote, i + 1);
    if (closing === -1) return null;
    const directive = code.slice(i + 1, closing);

    // Advance past the statement terminator (semicolon or newline) so the
    // strip range covers `'use server';\n` cleanly.
    let cursor = closing + 1;
    while (cursor < len && (code[cursor] === " " || code[cursor] === "\t")) cursor++;
    if (code[cursor] === ";") cursor++;
    while (cursor < len && (code[cursor] === " " || code[cursor] === "\t")) cursor++;
    if (code[cursor] === "\n") cursor++;
    else if (code[cursor] === "\r") {
      cursor++;
      if (code[cursor] === "\n") cursor++;
    }

    if (directive === "use server") {
      return code.slice(0, directiveStart) + code.slice(cursor);
    }

    // Other directives (e.g. "use strict", "use client") may precede the
    // React directive. Continue scanning past this statement.
    i = cursor;
  }
  return null;
}
