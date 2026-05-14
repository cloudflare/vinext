#!/usr/bin/env node
// Convert a CommonJS Next.js config file (next.config.{js,ts}) to ESM in-place.
//
// Used by scripts/e2e-deploy.sh after `vinext init` adds "type": "module" to
// the test app's package.json — at that point Node treats .js as ESM, but
// Next.js doesn't accept .cjs for its config file, so we have to rewrite the
// CJS syntax to ESM equivalents.
//
// This was previously inlined into e2e-deploy.sh via `node -e '…'`, but the
// JS body contained the `'"'"'` quote-escape pattern enough times that
// rebalancing got broken (one unquoted `(` in a comment was enough to make
// bash fail to parse the whole script). Extracting to a standalone module
// removes the quoting hazard entirely — see #1189.
//
// The converter handles:
//   module.exports = X              → export default X
//   const X = require('mod')        → import X from 'mod'
//   const X = require('mod')(args)  → const X = (await import('mod')).default(args)
//   const { a, b } = require('mod') → import { a, b } from 'mod'
//   require('mod') in expressions   → (await import('mod')).default
//
// `require('mod')(args)` is rewritten to an *inline* dynamic import (rather
// than a hoisted static import) so that conditionally-gated requires keep
// their CJS lazy semantics. Several Next.js deploy fixtures wrap optional
// plugins in `if (process.env.ANALYZE) { const x = require('@next/bundle-analyzer')({...}) }`
// — hoisting the import to the top of the module would unconditionally try
// to resolve the package and fail the build, even when ANALYZE is unset.
//
// Catch-all prelude (only injected when actually referenced):
//   __dirname / __filename → ESM equivalents via fileURLToPath
//   require.resolve / leftover require → createRequire(import.meta.url)
//
// Limitations: doesn't handle module.exports.foo = X (named exports), or
// `require('mod').foo()`-style member access. The next.config fixtures in
// the deploy suite don't use those patterns; if they start appearing we'll
// add a regex for it.

import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: cjs-to-esm-config.mjs <file>");
  process.exit(1);
}

let code = fs.readFileSync(file, "utf8");

if (
  !/\bmodule\.exports\b/.test(code) &&
  !/\brequire\b/.test(code) &&
  !/\b__(dirname|filename)\b/.test(code)
) {
  // Nothing to convert.
  process.exit(0);
}

const imports = [];

// 1. const X = require("mod")(args) → const X = (await import("mod")).default(args)
//
// Inline dynamic import preserves CJS lazy semantics. The previous static-
// import variant unconditionally resolved the module at the top of
// next.config.js, which broke fixtures like
// test/e2e/app-dir/metadata-font/next.config.js (gates @next/bundle-analyzer
// on `if (process.env.ANALYZE)`).
code = code.replace(
  /\b(const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*(["'][^"']+["'])\s*\)\s*(\([^)]*\))/g,
  (_, decl, name, mod, call) => `${decl} ${name} = (await import(${mod})).default${call}`,
);

// 2. const X = require("mod") → import X from "mod"
code = code.replace(
  /\b(const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*(["'][^"']+["'])\s*\)/g,
  (_, _decl, name, mod) => {
    imports.push(`import ${name} from ${mod};`);
    return "";
  },
);

// 2b. const { a, b } = require("mod") → import { a, b } from "mod"
code = code.replace(
  /\b(const|let|var)\s+(\{[^}]+\})\s*=\s*require\s*\(\s*(["'][^"']+["'])\s*\)/g,
  (_, _decl, destructured, mod) => {
    imports.push(`import ${destructured} from ${mod};`);
    return "";
  },
);

// 3. Remaining bare require("mod") in expressions → (await import("mod")).default
// Note: this only matches require("…") — require.resolve(…), require.cache, etc.
// are intentionally left alone and handled by the createRequire prelude below.
code = code.replace(
  /\brequire\s*\(\s*(["'][^"']+["'])\s*\)/g,
  (_, mod) => `(await import(${mod})).default`,
);

// 4. module.exports = → export default
code = code.replace(/\bmodule\.exports\s*=\s*/, "export default ");

// 5. Catch-all CJS prelude — injected only when the (post-transform) source
// still references CJS-only globals. This covers patterns the regex pipeline
// above doesn't rewrite (require.resolve, __dirname/__filename in the config
// body, dynamic require calls, etc.) without needing a regex for each one.
const prelude = [];
const needsDirname = /\b__dirname\b/.test(code);
const needsFilename = /\b__filename\b/.test(code);
// After the rewrites in steps 1–3 the only remaining `require` references are
// things like `require.resolve(…)` or `require.cache` that we deliberately
// leave alone. Detect them with a lookahead so we don't trigger on the rare
// case where someone wrote a bare identifier named "require_something".
const needsRequire = /\brequire\s*[(.[]/.test(code);

if (needsDirname || needsFilename) {
  prelude.push(`import { fileURLToPath as __vinext_fileURLToPath } from "node:url";`);
}
if (needsDirname) {
  prelude.push(`import { dirname as __vinext_dirname } from "node:path";`);
}
if (needsFilename) {
  prelude.push(`const __filename = __vinext_fileURLToPath(import.meta.url);`);
}
if (needsDirname) {
  // If we already defined __filename above, reuse it; otherwise compute it inline.
  if (needsFilename) {
    prelude.push(`const __dirname = __vinext_dirname(__filename);`);
  } else {
    prelude.push(`const __dirname = __vinext_dirname(__vinext_fileURLToPath(import.meta.url));`);
  }
}
if (needsRequire) {
  prelude.push(`import { createRequire as __vinext_createRequire } from "node:module";`);
  prelude.push(`const require = __vinext_createRequire(import.meta.url);`);
}

// Prepend (prelude first, then transformed imports, then body)
const header = [...prelude, ...imports].join("\n");
if (header.length > 0) {
  code = header + "\n" + code;
}

// Clean up empty lines from removed const declarations
code = code.replace(/\n{3,}/g, "\n\n");

fs.writeFileSync(file, code);
console.log(`Converted ${file} from CJS to ESM`);
