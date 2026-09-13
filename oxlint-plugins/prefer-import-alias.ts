/**
 * Oxlint plugin: prefer-import-alias.
 *
 * Reads `compilerOptions.paths` from the closest enclosing tsconfig.json
 * (following `extends` chains) and reports any relative import whose resolved
 * file matches an alias target, rewriting the import to the bare specifier
 * with autofix.
 *
 * Why: see #1001. Relative imports of files that can be reached via a defined
 * alias (e.g. "vinext/shims/X") cause @vitejs/plugin-rsc to emit absolute-path
 * proxy modules instead of bare-specifier proxies. Forcing the alias keeps
 * RSC's `packageSources` map populated.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { definePlugin, defineRule, type Context, type ESTree } from "@oxlint/plugins";

const STRIP_EXT_RE = /\.(?:m?js|c?js|tsx?|jsx)$/;

type Alias = {
  keyPrefix: string;
  keySuffix: string;
  targetPrefix: string;
  targetSuffix: string;
  wildcard: boolean;
};

type ResolvedTsconfigPaths = {
  paths: Record<string, unknown>;
  baseDir: string;
};

type TsconfigJson = {
  extends?: unknown;
  compilerOptions?: {
    baseUrl?: unknown;
    paths?: unknown;
  };
};

type ImportNode =
  | ESTree.ImportDeclaration
  | ESTree.ExportNamedDeclaration
  | ESTree.ExportAllDeclaration
  | ESTree.ImportExpression;

const aliasCache = new Map<string, Alias[]>();

/**
 * Strip JSONC line and block comments while respecting string literals.
 * Walks the input character-by-character to avoid eating `//` or `/*` inside
 * strings.
 */
function stripJsonc(raw: string): string {
  let out = "";
  let i = 0;
  const len = raw.length;
  while (i < len) {
    const ch = raw[i];
    if (ch === '"') {
      const start = i++;
      while (i < len) {
        if (raw[i] === "\\") {
          i += 2;
          continue;
        }
        if (raw[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      out += raw.slice(start, i);
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < len && raw[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < len && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Walk up from `dir` looking for the closest `tsconfig.json`. */
function findTsconfig(dir: string): string | null {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(dir, "tsconfig.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve a tsconfig's `extends` reference. Supports relative paths, bare
 * specifiers (resolved via require.resolve), and the implicit `.json` suffix.
 */
function resolveExtends(extendsValue: string, fromDir: string): string | null {
  if (typeof extendsValue !== "string") return null;
  let resolved: string;
  if (extendsValue.startsWith(".")) {
    resolved = path.resolve(fromDir, extendsValue);
  } else {
    try {
      const req = createRequire(path.join(fromDir, "noop.js"));
      resolved = req.resolve(extendsValue);
    } catch {
      return null;
    }
  }
  if (!resolved.endsWith(".json") && fs.existsSync(resolved + ".json")) {
    resolved += ".json";
  }
  return fs.existsSync(resolved) ? resolved : null;
}

/**
 * Walk a tsconfig (and its `extends` chain) to find the first one with
 * `compilerOptions.paths` set. Returns `{ paths, baseDir }` or null.
 */
function loadTsconfigWithExtends(
  tsconfigPath: string,
  visited = new Set<string>(),
): ResolvedTsconfigPaths | null {
  if (visited.has(tsconfigPath)) return null;
  visited.add(tsconfigPath);
  let cfg: TsconfigJson;
  try {
    cfg = JSON.parse(stripJsonc(fs.readFileSync(tsconfigPath, "utf-8"))) as TsconfigJson;
  } catch {
    return null;
  }
  const dir = path.dirname(tsconfigPath);
  const compilerOptions = cfg?.compilerOptions ?? {};
  if (
    compilerOptions.paths !== null &&
    typeof compilerOptions.paths === "object" &&
    !Array.isArray(compilerOptions.paths)
  ) {
    const baseDir =
      typeof compilerOptions.baseUrl === "string"
        ? path.resolve(dir, compilerOptions.baseUrl)
        : dir;
    return { paths: compilerOptions.paths as Record<string, unknown>, baseDir };
  }
  if (cfg.extends) {
    const list: unknown[] = Array.isArray(cfg.extends) ? cfg.extends : [cfg.extends];
    for (const entry of list) {
      if (typeof entry !== "string") continue;
      const next = resolveExtends(entry, dir);
      if (!next) continue;
      const result = loadTsconfigWithExtends(next, visited);
      if (result) return result;
    }
  }
  return null;
}

/** Build the alias table for a tsconfig. */
function buildAliases(tsconfigPath: string): Alias[] {
  const resolved = loadTsconfigWithExtends(tsconfigPath);
  if (!resolved) return [];
  const { paths, baseDir } = resolved;
  const aliases: Alias[] = [];
  for (const [key, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets)) continue;
    for (const target of targets) {
      if (typeof target !== "string") continue;
      const keyHasStar = key.includes("*");
      const targetHasStar = target.includes("*");
      if (keyHasStar !== targetHasStar) continue;
      const targetAbs = path.resolve(baseDir, target);
      aliases.push({
        keyPrefix: keyHasStar ? key.slice(0, key.indexOf("*")) : key,
        keySuffix: keyHasStar ? key.slice(key.indexOf("*") + 1) : "",
        targetPrefix: targetHasStar ? targetAbs.slice(0, targetAbs.indexOf("*")) : targetAbs,
        targetSuffix: targetHasStar ? targetAbs.slice(targetAbs.indexOf("*") + 1) : "",
        wildcard: keyHasStar,
      });
    }
  }
  aliases.sort((a, b) => b.targetPrefix.length - a.targetPrefix.length);
  return aliases;
}

/** Load aliases for the closest tsconfig to a given source file. */
function loadAliasesForFile(filename: string): Alias[] {
  const tsconfigPath = findTsconfig(path.dirname(filename)) ?? findTsconfig(process.cwd());
  if (!tsconfigPath) return [];
  let aliases = aliasCache.get(tsconfigPath);
  if (!aliases) {
    aliases = buildAliases(tsconfigPath);
    aliasCache.set(tsconfigPath, aliases);
  }
  return aliases;
}

/**
 * Get an absolute on-disk filename for filesystem and path comparisons.
 *
 * `context.filename` is not guaranteed to be absolute (notably when linting
 * through an editor), while `physicalFilename` is the ESLint API intended for
 * accessing the file on disk. Keep the fallback for Oxlint/ESLint callers that
 * do not provide it, resolving relative filenames against the lint context's
 * cwd rather than the JS plugin process's cwd.
 */
function getPhysicalFilename(context: Context): string | null {
  const filename = context.physicalFilename ?? context.filename;
  if (
    typeof filename !== "string" ||
    filename.length === 0 ||
    (filename.startsWith("<") && filename.endsWith(">"))
  ) {
    return null;
  }
  // Resolve even an already-absolute filename so Windows paths supplied by
  // the language server with `/` separators are normalized to the same native
  // representation as alias targets built with `path.resolve()`.
  return path.resolve(context.cwd ?? process.cwd(), filename);
}

/**
 * Reverse-map an absolute import path to a tsconfig-defined bare specifier.
 * Returns null if no alias exposes this file.
 */
function tryReverseAlias(
  absoluteImport: string,
  importerDir: string,
  aliases: readonly Alias[],
): string | null {
  const stripped = absoluteImport.replace(STRIP_EXT_RE, "");
  for (const a of aliases) {
    const targetPrefix = a.targetPrefix.replace(STRIP_EXT_RE, "");
    const targetSuffix = a.targetSuffix.replace(STRIP_EXT_RE, "");
    // Don't rewrite when the importer is itself inside the alias target dir;
    // siblings should reference each other relatively, not via self-reference.
    const importerDirSlash = importerDir.endsWith(path.sep) ? importerDir : importerDir + path.sep;
    if (
      a.wildcard
        ? importerDirSlash.startsWith(targetPrefix)
        : importerDir === path.dirname(targetPrefix)
    ) {
      continue;
    }
    if (a.wildcard) {
      if (
        stripped.startsWith(targetPrefix) &&
        stripped.endsWith(targetSuffix) &&
        stripped.length > targetPrefix.length + targetSuffix.length
      ) {
        const middle = stripped.slice(targetPrefix.length, stripped.length - targetSuffix.length);
        // Normalize platform separators to forward slashes — the bare
        // specifier is always `/`-separated, but `middle` is sliced from a
        // platform-native absolute path that uses `\` on Windows.
        const middleForward = middle.split(path.sep).join("/");
        return a.keyPrefix + middleForward + a.keySuffix;
      }
    } else if (stripped === targetPrefix) {
      return a.keyPrefix;
    }
  }
  return null;
}

const rule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer tsconfig path aliases over relative imports when the resolved file matches an alias target.",
    },
    fixable: "code",
  },
  createOnce(context) {
    function check(node: ImportNode): void {
      const source = node.source;
      if (!source || source.type !== "Literal" || typeof source.value !== "string") return;
      const importPath = source.value;
      if (!importPath.startsWith(".")) return;
      const filename = getPhysicalFilename(context);
      if (!filename) return;
      const aliases = loadAliasesForFile(filename);
      if (aliases.length === 0) return;
      const importerDir = path.dirname(filename);
      const absoluteImport = path.resolve(importerDir, importPath);
      const aliased = tryReverseAlias(absoluteImport, importerDir, aliases);
      if (!aliased) return;
      context.report({
        node: source,
        message: `Use alias '${aliased}' instead of relative path '${importPath}'.`,
        fix: (fixer) => fixer.replaceText(source, JSON.stringify(aliased)),
      });
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      // Dynamic `import("./foo")` calls. `node.source` is the Expression
      // argument; for string-literal calls it's a Literal with `.value`,
      // matching the shape `check` already guards.
      ImportExpression: check,
    };
  },
});

export default definePlugin({
  meta: { name: "vinext-local" },
  rules: { "prefer-import-alias": rule },
});
