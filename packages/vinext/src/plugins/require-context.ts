// Expands Webpack's build-time `require.context(dir, recursive, regexp)` API
// into a static module map backed by Vite's `import.meta.glob` (eager).
//
// Webpack exposes `require.context` to build a map of modules at compile time.
// Next.js apps still use it — typically written as `(require as any).context(...)`
// so it type-checks — but Vite/Rolldown has no such API, so at runtime the call
// throws `require is not defined`.
//
// This transform rewrites each genuine `require.context(...)` call into an IIFE
// that wraps the result of `import.meta.glob(<patterns>, { eager: true })`,
// exposing the subset of the Webpack context interface used in practice:
//
//   const ctx = require.context("./dir", true, /\.js$/);
//   ctx.keys();        // ["./a.js", "./b.js", ...] (relative to dir, sorted)
//   ctx("./a.js");     // the module namespace object
//   ctx.resolve("./a.js"); // the relative key (best-effort)
//   ctx.id;            // the glob base dir
//
// Only the literal three-argument form with a static string directory is
// rewritten; anything dynamic is left untouched so we never silently break
// unrelated code.
import { parseAst, type Plugin } from "vite";
import MagicString from "magic-string";
import {
  forEachAstChild,
  hasRange,
  isAstRecord,
  nodeArray,
  type AstRange,
  type AstRecord,
} from "./ast-utils.js";

const TRANSFORMABLE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

type ParsedCall = {
  range: AstRange;
  dir: string;
  recursive: boolean;
  pattern: string;
  flags: string;
};

export function createRequireContextPlugin(): Plugin {
  return {
    name: "vinext:require-context",
    // Run before TypeScript/JSX stripping so we still see the
    // `(require as any).context(...)` form (a TSAsExpression callee object).
    enforce: "pre",
    transform(code, id) {
      if (!mayContainRequireContext(code)) return null;
      const lang = langForId(id);
      if (!lang) return null;

      let ast: unknown;
      try {
        ast = parseAst(code, { lang });
      } catch {
        return null;
      }

      const calls = collectRequireContextCalls(ast);
      if (calls.length === 0) return null;

      const output = new MagicString(code);
      for (const call of calls) {
        output.overwrite(call.range.start, call.range.end, buildReplacement(call));
      }

      return {
        code: output.toString(),
        map: output.generateMap({ hires: "boundary" }),
      };
    },
  };
}

function mayContainRequireContext(code: string): boolean {
  // Cheap substring gate: both the `require` token and a `.context` member
  // access must be present for any genuine call.
  return code.includes("require") && code.includes(".context");
}

function langForId(id: string): "js" | "jsx" | "ts" | "tsx" | null {
  const clean = id.split("?", 1)[0];
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = clean.slice(dot).toLowerCase();
  if (!TRANSFORMABLE_EXTENSIONS.has(ext)) return null;
  switch (ext) {
    case ".ts":
    case ".cts":
    case ".mts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".jsx":
      return "jsx";
    default:
      // .js / .jsx / .mjs / .cjs — parse as jsx so JSX in .js still works.
      return "jsx";
  }
}

function collectRequireContextCalls(ast: unknown): ParsedCall[] {
  const calls: ParsedCall[] = [];

  function visit(value: unknown): void {
    if (!isAstRecord(value)) return;
    const parsed = parseRequireContextCall(value);
    if (parsed) {
      calls.push(parsed);
      // A matched call's arguments are all literals (string/boolean/regexp), so
      // there is nothing further to find inside it — stop descending here.
      return;
    }
    forEachAstChild(value, visit);
  }

  visit(ast);
  return calls;
}

// Matches `require.context(dir, recursive?, regexp?)` where the callee object
// is the `require` identifier, optionally wrapped in a `(require as any)`
// TypeScript assertion or parentheses. Returns null for anything that does not
// match exactly, so unrelated `.context(...)` calls are never rewritten.
function parseRequireContextCall(node: AstRecord): ParsedCall | null {
  if (node.type !== "CallExpression" || !hasRange(node)) return null;

  const callee = node.callee;
  if (
    !isAstRecord(callee) ||
    callee.type !== "MemberExpression" ||
    callee.computed === true ||
    callee.optional === true
  ) {
    return null;
  }
  if (!isPropertyNamed(callee.property, "context")) return null;
  if (!isRequireExpression(callee.object)) return null;

  const args = nodeArray(node.arguments);
  // First arg: the directory string. Required and must be a static, relative
  // path — `import.meta.glob` only accepts relative (`./`, `../`) or absolute
  // glob patterns, so a bare/aliased specifier is left untouched.
  const dir = stringLiteralValue(args[0]);
  if (dir == null || !(dir.startsWith("./") || dir.startsWith("../"))) return null;

  // Second arg: recursive flag. Optional; Webpack's `require.context` defaults
  // `useSubdirectories` to `true` when omitted, so we match that to avoid a
  // silently-shallower key set. We only rewrite when it is a literal boolean
  // (or absent → true).
  let recursive = true;
  if (args.length >= 2) {
    const value = booleanLiteralValue(args[1]);
    if (value == null) return null;
    recursive = value;
  }

  // Third arg: filter regexp. Optional; defaults to matching every module.
  // Parity caveat: with no regexp, the underlying `import.meta.glob` only
  // surfaces files Vite can resolve as modules, so extensionless keys that
  // Webpack would include can be dropped. Real-world `require.context` usage
  // almost always passes a regexp, and upstream Next.js's own test for the
  // extensionless case is disabled (Turbopack-pending), so this is left as a
  // documented, low-risk divergence rather than worked around.
  let pattern = "";
  let flags = "";
  if (args.length >= 3) {
    const regex = regexLiteralValue(args[2]);
    if (regex == null) return null;
    pattern = regex.pattern;
    flags = regex.flags;
  } else if (args.length > 3) {
    return null;
  }

  return {
    range: node,
    dir,
    recursive,
    pattern,
    flags,
  };
}

// `require`, `(require)`, `(require as any)`, `(require as unknown as Foo)`, …
function isRequireExpression(value: unknown): boolean {
  let node = value;
  // Unwrap TS assertion / non-null / parenthesized wrappers around `require`.
  while (isAstRecord(node)) {
    if (node.type === "Identifier") {
      return node.name === "require";
    }
    if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") {
      node = node.expression;
      continue;
    }
    if (node.type === "TSNonNullExpression") {
      node = node.expression;
      continue;
    }
    if (node.type === "ParenthesizedExpression") {
      node = node.expression;
      continue;
    }
    return false;
  }
  return false;
}

function isPropertyNamed(value: unknown, name: string): boolean {
  return isAstRecord(value) && value.type === "Identifier" && value.name === name;
}

function stringLiteralValue(value: unknown): string | null {
  if (isAstRecord(value) && value.type === "Literal" && typeof value.value === "string") {
    return value.value;
  }
  return null;
}

function booleanLiteralValue(value: unknown): boolean | null {
  if (isAstRecord(value) && value.type === "Literal" && typeof value.value === "boolean") {
    return value.value;
  }
  return null;
}

function regexLiteralValue(value: unknown): { pattern: string; flags: string } | null {
  if (!isAstRecord(value) || value.type !== "Literal") return null;
  // OXC attaches the regex source as a plain `{ pattern, flags }` object on the
  // Literal node — it has no `type` field, so it is NOT an AstRecord.
  const regex = value.regex;
  if (
    typeof regex === "object" &&
    regex !== null &&
    typeof (regex as { pattern?: unknown }).pattern === "string" &&
    typeof (regex as { flags?: unknown }).flags === "string"
  ) {
    return {
      pattern: (regex as { pattern: string }).pattern,
      flags: (regex as { flags: string }).flags,
    };
  }
  return null;
}

// Builds an IIFE that produces a Webpack-compatible require.context function
// backed by `import.meta.glob`. Vite statically analyses the `import.meta.glob`
// call, so its arguments must be literals.
function buildReplacement(call: ParsedCall): string {
  const globPattern = globPatternFor(call.dir, call.recursive);
  // Eager so the modules resolve synchronously, like Webpack's require.context.
  const glob = `import.meta.glob(${JSON.stringify(globPattern)}, { eager: true })`;
  const base = JSON.stringify(stripTrailingSlash(call.dir));
  // Strip the global (`g`) and sticky (`y`) flags: they make `RegExp.test()`
  // stateful via `lastIndex`, so consecutive membership checks over the sorted
  // keys would alternate true/false and silently drop matching modules. They
  // are meaningless for the per-key `.test()` filter Webpack applies.
  const filterFlags = call.flags.replace(/[gy]/g, "");
  const regexArgs = `${JSON.stringify(call.pattern)}, ${JSON.stringify(filterFlags)}`;

  // The runtime helper below normalises glob keys (which are relative to the
  // current module, e.g. "./grandparent/parent/file1.js") into context keys
  // relative to the base dir ("./parent/file1.js"), applies the regexp filter,
  // and sorts them for deterministic ordering.
  return [
    "(() => {",
    `  const __modules = ${glob};`,
    `  const __base = ${base};`,
    `  const __re = ${call.pattern ? `new RegExp(${regexArgs})` : "null"};`,
    "  const __prefix = __base.endsWith('/') ? __base : __base + '/';",
    "  const __map = Object.create(null);",
    "  for (const __abs in __modules) {",
    "    if (!__abs.startsWith(__prefix)) continue;",
    "    const __key = './' + __abs.slice(__prefix.length);",
    "    if (__re && !__re.test(__key)) continue;",
    "    __map[__key] = __modules[__abs];",
    "  }",
    "  const __keys = Object.keys(__map).sort();",
    "  const __ctx = (__key) => {",
    "    if (__key in __map) return __map[__key];",
    "    const __err = new Error('Cannot find module \\'' + __key + '\\'');",
    "    __err.code = 'MODULE_NOT_FOUND';",
    "    throw __err;",
    "  };",
    "  __ctx.keys = () => __keys.slice();",
    "  __ctx.resolve = (__key) => __key;",
    `  __ctx.id = __base;`,
    "  return __ctx;",
    "})()",
  ].join("\n");
}

// Webpack's `recursive` flag controls whether subdirectories are included.
// Vite's glob uses `*` (one segment) vs `**` (any depth).
function globPatternFor(dir: string, recursive: boolean): string {
  const base = stripTrailingSlash(dir);
  return recursive ? `${base}/**/*` : `${base}/*`;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
