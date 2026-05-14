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
// Limitations: doesn't handle dynamic require with variables, require.resolve,
// or `require('mod').foo()`-style member access. Covers the common
// next.config.js patterns in the deploy suite.

import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: cjs-to-esm-config.mjs <file>");
  process.exit(1);
}

let code = fs.readFileSync(file, "utf8");

if (!/\bmodule\.exports\b/.test(code) && !/\brequire\s*\(/.test(code)) {
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

// 3. Remaining require("mod") in expressions → (await import("mod")).default
code = code.replace(
  /\brequire\s*\(\s*(["'][^"']+["'])\s*\)/g,
  (_, mod) => `(await import(${mod})).default`,
);

// 4. module.exports = → export default
code = code.replace(/\bmodule\.exports\s*=\s*/, "export default ");

// Prepend collected imports
if (imports.length > 0) {
  code = imports.join("\n") + "\n" + code;
}

// Clean up empty lines from removed const declarations
code = code.replace(/\n{3,}/g, "\n\n");

fs.writeFileSync(file, code);
console.log(`Converted ${file} from CJS to ESM`);
