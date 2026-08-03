// Expands Webpack's build-time `require.context(dir, recursive, regexp)` API
// into a static module map backed by eager static imports.
//
// Webpack exposes `require.context` to build a map of modules at compile time.
// Next.js apps still use it — typically written as `(require as any).context(...)`
// so it type-checks — but Vite/Rolldown has no such API, so at runtime the call
// throws `require is not defined`.
//
// This transform rewrites each genuine `require.context(...)` call into an IIFE
// backed by modules selected at build time, exposing the subset of the Webpack
// context interface used in practice:
//
//   const ctx = require.context("./dir", true, /\.js$/);
//   ctx.keys();        // ["./a.js", "./b.js", ...] (relative to dir, sorted)
//   ctx("./a.js");     // the module namespace object
//   ctx.resolve("./a.js"); // the relative key (best-effort)
//   ctx.id;            // the context base dir
//
// Only literal forms with a static string directory are rewritten; anything
// dynamic is left untouched so we never silently break unrelated code.
import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import path, { toSlash } from "pathslash";
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

type ContextModule = {
  binding: string;
  key: string;
  specifier: string;
};

type WatchedContext = {
  directory: string;
  recursive: boolean;
  pattern: string;
  flags: string;
};

export function createRequireContextPlugin(): Plugin {
  // Static imports make edits to existing matches visible automatically. Keep
  // the context definitions as well so a create/delete event that changes the
  // matched file set can invalidate and re-transform the importing module.
  const watchedContexts = new WeakMap<object, Map<string, WatchedContext[]>>();

  return {
    name: "vinext:require-context",
    // Run before TypeScript/JSX stripping so we still see the
    // `(require as any).context(...)` form (a TSAsExpression callee object).
    enforce: "pre",
    transform: {
      filter: {
        id: /\.(?:[cm]?[jt]s|[jt]sx)(?:\?.*)?$/i,
        code: /\brequire\b[\s\S]*\.context/,
      },
      async handler(code, id) {
        const transformed = await transformRequireContext(code, id);
        const contextsForEnvironment =
          watchedContexts.get(this.environment) ?? new Map<string, WatchedContext[]>();
        watchedContexts.set(this.environment, contextsForEnvironment);

        if (!transformed) {
          contextsForEnvironment.delete(id);
          return null;
        }

        contextsForEnvironment.set(id, transformed.contexts);
        for (const context of transformed.contexts) {
          this.addWatchFile(context.directory);
        }

        return {
          code: transformed.code,
          map: transformed.map,
        };
      },
    },
    hotUpdate({ type, file, modules }) {
      const contextsForEnvironment = watchedContexts.get(this.environment);
      if (!contextsForEnvironment) return;

      // The event's own modules retransform after this update, but the
      // transform filter skips modules that no longer call require.context —
      // its map cleanup never runs for them. Drop their entries here instead;
      // the transform re-adds any that still match.
      for (const module of modules) {
        if (module.id != null) contextsForEnvironment.delete(module.id);
      }

      if (type === "update") return;

      const normalizedFile = toSlash(file);
      const affectedModules = new Set(modules);
      let addedImporter = false;

      for (const [id, contexts] of contextsForEnvironment) {
        if (!contexts.some((context) => matchesWatchedContext(normalizedFile, context))) continue;
        const module = this.environment.moduleGraph.getModuleById(id);
        if (!module || affectedModules.has(module)) continue;
        affectedModules.add(module);
        addedImporter = true;
      }

      return addedImporter ? [...affectedModules] : undefined;
    },
  };
}

type TransformResult = {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
  contexts: WatchedContext[];
};

async function transformRequireContext(code: string, id: string): Promise<TransformResult | null> {
  const lang = langForId(id)!;

  let ast: unknown;
  try {
    ast = parseAst(code, { lang });
  } catch {
    return null;
  }

  const calls = collectRequireContextCalls(ast);
  if (calls.length === 0) return null;

  const output = new MagicString(code);
  const importOffset = findImportInsertionOffset(ast);
  const imports: string[] = [];
  const contexts: WatchedContext[] = [];
  // A fixed binding name could redeclare an identifier the source already
  // uses; grow the prefix until it appears nowhere in the module.
  let bindingPrefix = "__vinext_require_context";
  while (code.includes(bindingPrefix)) bindingPrefix += "_";
  for (const [callIndex, call] of calls.entries()) {
    const resolved = await resolveContextModules(id, call, bindingPrefix, callIndex);
    contexts.push(resolved.context);
    for (const module of resolved.modules) {
      imports.push(`import * as ${module.binding} from ${JSON.stringify(module.specifier)};`);
    }
    output.overwrite(call.range.start, call.range.end, buildReplacement(call, resolved.modules));
  }
  if (imports.length > 0) {
    const importBlock = `${importOffset > 0 ? "\n" : ""}${imports.join("\n")}\n`;
    output.appendLeft(importOffset, importBlock);
  }

  return {
    code: output.toString(),
    map: output.generateMap({ hires: "boundary" }),
    contexts,
  };
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

function findImportInsertionOffset(ast: unknown): number {
  if (!isAstRecord(ast) || ast.type !== "Program") return 0;

  let offset = 0;
  if (isAstRecord(ast.hashbang) && hasRange(ast.hashbang)) {
    offset = ast.hashbang.end;
  }
  for (const statement of nodeArray(ast.body)) {
    if (
      !isAstRecord(statement) ||
      statement.type !== "ExpressionStatement" ||
      typeof statement.directive !== "string" ||
      !hasRange(statement)
    ) {
      break;
    }
    offset = statement.end;
  }
  return offset;
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
  // path so each matched file can become a relative static import. A
  // bare/aliased specifier is left untouched.
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
  // Parity caveat: webpack's resolver can expose both extensionless and
  // extension-qualified requests for one physical file. This transform maps
  // each discovered file once, so the extensionless alias can be absent.
  // Upstream Next.js's test for that case is disabled (Turbopack-pending), so
  // this remains a documented, low-risk divergence.
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

// Builds an IIFE that produces a Webpack-compatible require.context function.
// Webpack filters directory entries before it creates module dependencies. The
// generated map must therefore contain only modules accepted by the regexp;
// filtering a broad eager import here would already have evaluated excluded
// modules and included them in the bundle.
function buildReplacement(call: ParsedCall, modules: ContextModule[]): string {
  const base = JSON.stringify(stripTrailingSlash(call.dir));
  const entries = modules.map((module) => `${JSON.stringify(module.key)}: ${module.binding}`);
  return [
    "(() => {",
    `  const __base = ${base};`,
    `  const __map = Object.assign(Object.create(null), {${entries.join(",")}});`,
    `  const __keys = ${JSON.stringify(modules.map((module) => module.key))};`,
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

async function resolveContextModules(
  id: string,
  call: ParsedCall,
  bindingPrefix: string,
  callIndex: number,
): Promise<{ context: WatchedContext; modules: ContextModule[] }> {
  const importer = toSlash(id.split("?", 1)[0]);
  const directory = path.resolve(path.dirname(importer), call.dir);
  const context: WatchedContext = {
    directory,
    recursive: call.recursive,
    pattern: call.pattern,
    flags: filterFlags(call.flags),
  };
  const regexp = call.pattern ? new RegExp(call.pattern, context.flags) : null;
  const accepted: Omit<ContextModule, "binding">[] = [];

  for (const candidate of await listContextFiles(directory, call.recursive)) {
    const key = `./${candidate}`;
    if (regexp && !regexp.test(key)) continue;
    accepted.push({ key, specifier: `${stripTrailingSlash(call.dir)}/${candidate}` });
  }

  // Assign binding indices after sorting: readdir order is filesystem
  // dependent, and index-before-sort would leak that order into the generated
  // identifiers, changing bundle bytes for an unchanged source tree.
  accepted.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const modules = accepted.map((entry, index) => ({
    ...entry,
    binding: `${bindingPrefix}_${callIndex}_${index}`,
  }));
  return { context, modules };
}

// Enumerates candidate files like webpack's context walk: dot-entries are
// skipped (matching the prior glob semantics), symlinks resolve through stats —
// including symlinked directories in recursive contexts, which `fs.glob` does
// not descend into — and a missing context directory yields an empty context
// rather than an error. Cycles are broken by tracking realpaths along the
// current recursion path only, so distinct symlink aliases of the same target
// still enumerate under their own keys.
async function listContextFiles(directory: string, recursive: boolean): Promise<string[]> {
  const files: string[] = [];
  const ancestorRealPaths = new Set<string>();

  async function walk(currentDirectory: string, prefix: string): Promise<void> {
    let realDirectory: string;
    let entries: Dirent[];
    try {
      realDirectory = await realpath(currentDirectory);
      entries = await readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    if (ancestorRealPaths.has(realDirectory)) return;
    ancestorRealPaths.add(realDirectory);

    try {
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const entryPath = path.join(currentDirectory, entry.name);
        let isFile = entry.isFile();
        let isDirectory = entry.isDirectory();
        // Covers symlinks and filesystems without dirent type info (NFS, SMB,
        // FUSE), where entries report neither file nor directory. Broken links
        // (ENOENT) and self-referential link loops (ELOOP) are unresolvable,
        // so they cannot become context entries.
        if (!isFile && !isDirectory) {
          try {
            const stats = await stat(entryPath);
            isFile = stats.isFile();
            isDirectory = stats.isDirectory();
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ELOOP") continue;
            throw error;
          }
        }
        if (isFile) files.push(`${prefix}${entry.name}`);
        else if (isDirectory && recursive) await walk(entryPath, `${prefix}${entry.name}/`);
      }
    } finally {
      ancestorRealPaths.delete(realDirectory);
    }
  }

  await walk(directory, "");
  return files;
}

function matchesWatchedContext(file: string, context: WatchedContext): boolean {
  const candidate = path.relative(context.directory, file);
  if (
    candidate.length === 0 ||
    candidate === ".." ||
    candidate.startsWith("../") ||
    candidate.split("/").some((segment) => segment.startsWith(".")) ||
    (!context.recursive && candidate.includes("/"))
  ) {
    return false;
  }

  // A created or deleted directory in a recursive context can add or remove
  // matching descendants even though its own path fails the file regexp (the
  // watcher may only report the directory, e.g. a symlinked directory with
  // followSymlinks disabled), so membership alone must invalidate.
  if (context.recursive) return true;

  return (
    context.pattern === "" || new RegExp(context.pattern, context.flags).test(`./${candidate}`)
  );
}

// Global and sticky regexps make repeated RegExp.test() calls stateful. They do
// not change which individual context key should match, so normalize them once
// before build-time filtering and development invalidation.
function filterFlags(flags: string): string {
  return flags.replace(/[gy]/g, "");
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
