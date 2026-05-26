import fs from "node:fs";
import path from "node:path";
import { loadNearestTsconfigPathAliases } from "../config/tsconfig-paths.js";

const STATIC_MODULE_SPECIFIER_RE =
  /^\s*(?:import\s+(?!type\b)(?:[^'"]*?\s+from\s*)?["']([^"']+)["']|export\s+(type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s*["']([^"']+)["'])\s*;?\s*(?:\/\/.*)?$/gm;
const CSS_IMPORT_RE = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)$/i;
const SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs", ".cts", ".cjs"];
const EXPLICIT_JS_SOURCE_EXTENSIONS: Record<string, string[]> = {
  ".js": [".tsx", ".ts", ".jsx"],
  ".jsx": [".tsx", ".ts"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

type AliasEntry = {
  find: string;
  replacement: string;
};

function hasQueryOrHash(specifier: string): boolean {
  return specifier.includes("?") || specifier.includes("#");
}

function specifierPath(specifier: string): string {
  const queryIndex = specifier.search(/[?#]/);
  return queryIndex === -1 ? specifier : specifier.slice(0, queryIndex);
}

function isCssSpecifier(specifier: string): boolean {
  return CSS_IMPORT_RE.test(specifierPath(specifier));
}

function existsFile(filePath: string): boolean {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function existsDirectory(filePath: string): boolean {
  return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
}

function resolveAliasedSpecifier(specifier: string, aliases: readonly AliasEntry[]): string | null {
  for (const alias of aliases) {
    if (specifier === alias.find) {
      return alias.replacement;
    }

    const slashPrefix = `${alias.find}/`;
    if (specifier.startsWith(slashPrefix)) {
      return path.join(alias.replacement, specifier.slice(slashPrefix.length));
    }
  }

  return null;
}

function resolveSpecifierBasePath(
  importerPath: string,
  specifier: string,
  aliases: readonly AliasEntry[],
): string | null {
  if (specifier.startsWith(".")) {
    return path.resolve(path.dirname(importerPath), specifierPath(specifier));
  }

  if (specifier.startsWith("/")) {
    return path.resolve(specifierPath(specifier));
  }

  const aliasedPath = resolveAliasedSpecifier(specifierPath(specifier), aliases);
  return aliasedPath ? path.resolve(aliasedPath) : null;
}

function resolveCssSpecifier(
  importerPath: string,
  specifier: string,
  aliases: readonly AliasEntry[],
): string {
  const resolved = resolveSpecifierBasePath(importerPath, specifier, aliases);
  if (!resolved) {
    return specifier;
  }

  return resolved;
}

function resolveSourceFile(basePath: string): string | null {
  const extension = path.extname(basePath);
  if (extension) {
    if (existsFile(basePath)) {
      return basePath;
    }

    const sourceExtensions = EXPLICIT_JS_SOURCE_EXTENSIONS[extension] ?? [];
    const withoutExtension = basePath.slice(0, -extension.length);
    for (const sourceExtension of sourceExtensions) {
      const candidate = `${withoutExtension}${sourceExtension}`;
      if (existsFile(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (existsFile(candidate)) {
      return candidate;
    }
  }

  if (existsDirectory(basePath)) {
    for (const extension of SOURCE_EXTENSIONS) {
      const candidate = path.join(basePath, `index${extension}`);
      if (existsFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function resolveSourceSpecifier(
  importerPath: string,
  specifier: string,
  aliases: readonly AliasEntry[],
): string | null {
  if (hasQueryOrHash(specifier)) {
    return null;
  }

  const basePath = resolveSpecifierBasePath(importerPath, specifier, aliases);
  return basePath ? resolveSourceFile(basePath) : null;
}

function isTypeOnlyNamedExportClause(clause: string): boolean {
  if (!clause.startsWith("{")) {
    return false;
  }

  const specifiers = clause
    .slice(1, -1)
    .split(",")
    .map((specifier) => specifier.trim());
  return specifiers.length > 0 && specifiers.every((specifier) => specifier.startsWith("type "));
}

function readStaticModuleSpecifiers(filePath: string): string[] {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const specifiers: string[] = [];
  for (const match of source.matchAll(STATIC_MODULE_SPECIFIER_RE)) {
    const importSpecifier = match[1];
    if (importSpecifier) {
      specifiers.push(importSpecifier);
      continue;
    }

    const exportKind = match[2];
    const exportClause = match[3];
    const exportSpecifier = match[4];
    if (
      exportSpecifier &&
      exportKind !== "type " &&
      exportClause &&
      !isTypeOnlyNamedExportClause(exportClause)
    ) {
      specifiers.push(exportSpecifier);
    }
  }
  return specifiers;
}

function createAliasEntries(entryPath: string): AliasEntry[] {
  const resolution = loadNearestTsconfigPathAliases(entryPath);
  if (!resolution) {
    return [];
  }

  return Object.entries(resolution.aliases)
    .map(([find, replacement]) => ({ find, replacement }))
    .sort((a, b) => b.find.length - a.find.length);
}

/**
 * Collect CSS imported by a standalone entry without relying on Rollup's
 * shared-entry CSS de-duplication. This intentionally follows only local
 * static JS/TS imports and configured tsconfig aliases; non-local specifiers
 * still work when they are CSS imports because Vite can resolve them from the
 * generated module.
 */
export function collectStandaloneCssImports(entryPath: string): string[] {
  const seenSources = new Set<string>();
  const seenCss = new Set<string>();
  const cssImports: string[] = [];
  const aliases = createAliasEntries(entryPath);

  function appendCssImport(importerPath: string, specifier: string): void {
    if (hasQueryOrHash(specifier)) {
      return;
    }

    const resolved = resolveCssSpecifier(importerPath, specifier, aliases);
    if (!seenCss.has(resolved)) {
      seenCss.add(resolved);
      cssImports.push(resolved);
    }
  }

  function visitSource(filePath: string): void {
    const resolvedPath = resolveSourceFile(filePath);
    if (!resolvedPath || seenSources.has(resolvedPath)) {
      return;
    }

    seenSources.add(resolvedPath);
    for (const specifier of readStaticModuleSpecifiers(resolvedPath)) {
      if (isCssSpecifier(specifier)) {
        appendCssImport(resolvedPath, specifier);
        continue;
      }

      const childSource = resolveSourceSpecifier(resolvedPath, specifier, aliases);
      if (childSource) {
        visitSource(childSource);
      }
    }
  }

  visitSource(entryPath);
  return cssImports;
}
