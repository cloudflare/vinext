// Rewrites direct `import.meta.url` reads in user modules to the source-module
// URL (a real file URL on the server, a Turbopack-style `file:///ROOT/...` URL
// on the client) so module identity survives bundling, matching Next.js.
//
// Two known limitations, both matching Vite's own `import.meta.url` handling:
//   1. Destructured access — `const { url } = import.meta;` — is not detected
//      and will leak the bundled chunk URL.
//   2. An aliased `import.meta.url` used as a `new URL()` base — e.g.
//      `const u = import.meta.url; new URL("./file", u);` — is rewritten,
//      breaking Vite's asset detection for that expression. Only the direct
//      `new URL("./file", import.meta.url)` form is preserved.
// Both are edge cases that are unlikely in real Next.js apps.
import { normalizePath, parseAst, type Plugin } from "vite";
import MagicString from "magic-string";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type NodeLike = {
  type?: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
};

type ImportMetaUrlEnvironment = "client" | "server";

type RewriteResult = {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
};

type RootPaths = {
  root: string;
  canonicalRoot: string;
  normalizedRoot: string;
  excludedRelativePrefixes: string[];
};

const TRANSFORMABLE_SCRIPT_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

export function createImportMetaUrlPlugin(options: { getRoot: () => string | undefined }): Plugin {
  let rootPaths: RootPaths | undefined;
  let outputDirs: string[] = [];

  function getRootPaths(): RootPaths | undefined {
    const root = options.getRoot();
    if (!root) return rootPaths;
    if (!rootPaths || rootPaths.root !== root) {
      rootPaths = createRootPaths(root, { outputDirs });
    }
    return rootPaths;
  }

  return {
    name: "vinext:import-meta-url",
    enforce: "post",
    configResolved(config) {
      const root = options.getRoot() ?? config.root;
      outputDirs = [config.build.outDir];
      rootPaths = createRootPaths(root, { outputDirs });
    },
    transform(code, id) {
      if (!mayContainImportMetaUrl(code)) return null;
      const paths = getRootPaths();
      if (!paths) return null;
      const cleanId = cleanModuleId(id);
      const canonicalId = transformableModuleCanonicalId(cleanId, paths);
      if (!canonicalId) return null;

      const environment: ImportMetaUrlEnvironment =
        this.environment?.name === "client" ? "client" : "server";
      const rewritten = rewriteCanonicalImportMetaUrl(code, canonicalId, paths, environment);
      if (!rewritten) return null;
      return {
        code: rewritten.code,
        map: rewritten.map,
      };
    },
  };
}

export function rewriteImportMetaUrl(
  code: string,
  id: string,
  root: string,
  environment: ImportMetaUrlEnvironment,
): RewriteResult | null {
  if (!mayContainImportMetaUrl(code)) return null;
  return rewriteCanonicalImportMetaUrl(
    code,
    canonicalizePath(id),
    createRootPaths(root),
    environment,
  );
}

function rewriteCanonicalImportMetaUrl(
  code: string,
  canonicalId: string,
  rootPaths: RootPaths,
  environment: ImportMetaUrlEnvironment,
): RewriteResult | null {
  let ast: unknown;
  try {
    ast = parseAst(code);
  } catch {
    return null;
  }

  const ranges = collectImportMetaUrlRanges(ast);
  if (ranges.length === 0) return null;

  const replacement = JSON.stringify(importMetaUrlValue(canonicalId, rootPaths, environment));
  const output = new MagicString(code);
  for (const range of ranges) {
    output.overwrite(range.start, range.end, replacement);
  }

  return {
    code: output.toString(),
    map: output.generateMap({ hires: "boundary" }),
  };
}

function cleanModuleId(id: string): string {
  return id.split("?", 1)[0];
}

function createRootPaths(root: string, options: { outputDirs?: string[] } = {}): RootPaths {
  const canonicalRoot = canonicalizePath(root);
  const normalizedRoot = normalizePath(canonicalRoot);
  return {
    root,
    canonicalRoot,
    normalizedRoot,
    excludedRelativePrefixes: excludedRelativePrefixes(canonicalRoot, normalizedRoot, options),
  };
}

// Returns the canonical module id when the module is eligible for rewriting,
// or null otherwise. Threading the canonical id back to the caller avoids a
// second realpathSync when computing the replacement value.
function transformableModuleCanonicalId(id: string, rootPaths: RootPaths): string | null {
  if (!id || id.startsWith("\0")) return null;
  if (!path.isAbsolute(id)) return null;
  const normalizedInputId = normalizePath(id);
  // Early-exit optimization: skip the realpathSync below for node_modules
  // paths, which are the majority of modules in a typical project. The
  // isPathWithin check at line 150 provides a second safety net in case a
  // symlink causes the canonical path to land outside node_modules.
  if (normalizedInputId.includes("/node_modules/")) return null;
  if (!TRANSFORMABLE_SCRIPT_EXTENSIONS.has(path.extname(normalizedInputId))) return null;

  const canonicalId = canonicalizePath(id);
  const normalizedId = normalizePath(canonicalId);
  if (!isPathWithin(normalizedId, rootPaths.normalizedRoot)) return null;

  const relativePath = normalizePath(path.relative(rootPaths.canonicalRoot, canonicalId));
  if (isExcludedRelativePath(relativePath, rootPaths.excludedRelativePrefixes)) return null;
  return canonicalId;
}

function mayContainImportMetaUrl(code: string): boolean {
  return code.includes("import.meta.url") || code.includes("import.meta?.url");
}

function excludedRelativePrefixes(
  canonicalRoot: string,
  normalizedRoot: string,
  options: { outputDirs?: string[] },
): string[] {
  // Static list of known output/build directories whose modules must
  // never have import.meta.url rewritten (they are build artifacts, not
  // user source). Custom output directories are added dynamically from
  // config.build.outDir in configResolved. Using .gitignore was considered
  // but adds unnecessary filesystem overhead for this narrow use case.
  const prefixes = new Set([".next", ".vinext", ".vinext-local-package", "dist", "out"]);

  for (const outputDir of options.outputDirs ?? []) {
    const absoluteOutputDir = path.isAbsolute(outputDir)
      ? outputDir
      : path.resolve(canonicalRoot, outputDir);
    const canonicalOutputDir = canonicalizePath(absoluteOutputDir);
    const normalizedOutputDir = normalizePath(canonicalOutputDir);
    if (!isPathWithin(normalizedOutputDir, normalizedRoot)) continue;

    const relativePath = normalizePath(path.relative(canonicalRoot, canonicalOutputDir));
    if (relativePath && relativePath !== ".") prefixes.add(relativePath);
  }

  return [...prefixes];
}

function isExcludedRelativePath(relativePath: string, prefixes: string[]): boolean {
  return prefixes.some(
    (prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`),
  );
}

function isPathWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function importMetaUrlValue(
  canonicalId: string,
  rootPaths: RootPaths,
  environment: ImportMetaUrlEnvironment,
): string {
  if (environment === "client") {
    const relativePath = normalizePath(path.relative(rootPaths.canonicalRoot, canonicalId));
    return `file:///ROOT/${relativePath}`;
  }

  return pathToFileURL(canonicalId).href;
}

function canonicalizePath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function collectImportMetaUrlRanges(ast: unknown): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  function visit(value: unknown): void {
    if (!isNodeLike(value)) return;

    if (isImportMetaUrlNode(value)) {
      ranges.push({ start: value.start, end: value.end });
      return;
    }

    if (isChainExpressionWrappingImportMetaUrl(value)) {
      ranges.push({ start: value.start, end: value.end });
      return;
    }

    if (isNewUrlExpression(value)) {
      const args = nodeArray(value.arguments);
      for (let index = 0; index < args.length; index += 1) {
        if (index === 1 && isImportMetaUrlOrChainedNode(args[index])) continue;
        visit(args[index]);
      }
      // The callee is always the bare `URL` identifier (see isNewUrlExpression),
      // so it can never contain an import.meta.url read — no need to visit it.
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else {
        visit(child);
      }
    }
  }

  visit(ast);
  return ranges;
}

function isNodeLike(value: unknown): value is NodeLike {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isIdentifierNamed(value: unknown, name: string): boolean {
  return isNodeLike(value) && value.type === "Identifier" && value.name === name;
}

function isImportMetaNode(value: unknown): boolean {
  return (
    isNodeLike(value) &&
    value.type === "MetaProperty" &&
    isIdentifierNamed(value.meta, "import") &&
    isIdentifierNamed(value.property, "meta")
  );
}

function isImportMetaUrlNode(value: unknown): value is NodeLike & { start: number; end: number } {
  return (
    isNodeLike(value) &&
    value.type === "MemberExpression" &&
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    isImportMetaNode(value.object) &&
    isIdentifierNamed(value.property, "url")
  );
}

// Accepts both import.meta.url (MemberExpression) and import.meta?.url
// (ChainExpression wrapping a MemberExpression) so that the new URL() skip
// correctly handles optional-chained base arguments.
function isImportMetaUrlOrChainedNode(
  value: unknown,
): value is NodeLike & { start: number; end: number } {
  if (isImportMetaUrlNode(value)) return true;
  return (
    isNodeLike(value) && value.type === "ChainExpression" && isImportMetaUrlNode(value.expression)
  );
}

// Catches the ChainExpression wrapper so we record the outer node range
// and avoid descending into the inner MemberExpression (which happens
// to share the same start/end, but this is more explicit).
function isChainExpressionWrappingImportMetaUrl(
  value: unknown,
): value is NodeLike & { start: number; end: number } {
  return (
    isNodeLike(value) &&
    value.type === "ChainExpression" &&
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    isImportMetaUrlNode(value.expression)
  );
}

// Only matches bare `new URL(...)`, not `new globalThis.URL(...)` or
// `new window.URL(...)`. Matches Vite's own asset-detection scope.
function isNewUrlExpression(value: NodeLike): boolean {
  return value.type === "NewExpression" && isIdentifierNamed(value.callee, "URL");
}

function nodeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
