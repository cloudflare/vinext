import fs from "node:fs";
import path from "node:path";
import { parseSync } from "vite";
import type { ESTree } from "vite";
import { loadNearestTsconfigPathAliases } from "../config/tsconfig-paths.js";

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

type ParseLang = "js" | "jsx" | "ts" | "tsx";

const SOURCE_PARSE_LANGS: Record<string, readonly ParseLang[]> = {
  ".ts": ["ts"],
  ".mts": ["ts"],
  ".cts": ["ts"],
  ".tsx": ["tsx"],
  ".js": ["jsx", "js"],
  ".mjs": ["jsx", "js"],
  ".cjs": ["jsx", "js"],
  ".jsx": ["jsx"],
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
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function existsDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
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

function parseModule(filePath: string, source: string): ESTree.Program | null {
  const langs = SOURCE_PARSE_LANGS[path.extname(filePath)] ?? ["tsx", "ts"];

  for (const lang of langs) {
    try {
      const result = parseSync(filePath, source, {
        astType: "ts",
        lang,
        sourceType: "module",
      });

      if (result.errors.some((error) => error.severity === "Error")) {
        continue;
      }

      return result.program;
    } catch {
      continue;
    }
  }

  return null;
}

function moduleSpecifierValue(
  node: ESTree.ImportDeclaration | ESTree.ExportNamedDeclaration | ESTree.ExportAllDeclaration,
): string | null {
  const sourceValue = node.source?.value;
  return typeof sourceValue === "string" ? sourceValue : null;
}

function isTypeOnlyImport(node: ESTree.ImportDeclaration): boolean {
  if (node.importKind === "type") {
    return true;
  }

  return (
    node.specifiers.length > 0 &&
    node.specifiers.every(
      (specifier) => specifier.type === "ImportSpecifier" && specifier.importKind === "type",
    )
  );
}

function isTypeOnlyNamedExport(node: ESTree.ExportNamedDeclaration): boolean {
  if (node.exportKind === "type") {
    return true;
  }

  return (
    node.specifiers.length > 0 &&
    node.specifiers.every((specifier) => specifier.exportKind === "type")
  );
}

function readStaticModuleSpecifiers(filePath: string): string[] {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const program = parseModule(filePath, source);
  if (!program) {
    return [];
  }

  const specifiers: string[] = [];
  for (const node of program.body) {
    if (node.type === "ImportDeclaration") {
      if (!isTypeOnlyImport(node)) {
        const specifier = moduleSpecifierValue(node);
        if (specifier) specifiers.push(specifier);
      }
      continue;
    }

    if (node.type === "ExportNamedDeclaration") {
      if (!isTypeOnlyNamedExport(node)) {
        const specifier = moduleSpecifierValue(node);
        if (specifier) specifiers.push(specifier);
      }
      continue;
    }

    if (node.type === "ExportAllDeclaration" && node.exportKind !== "type") {
      const specifier = moduleSpecifierValue(node);
      if (specifier) specifiers.push(specifier);
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
