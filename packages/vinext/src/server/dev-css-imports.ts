import { parseAst, transformWithOxc } from "vite";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizePathSeparators } from "../entries/runtime-entry-module.js";

export type DevCssResolutionContext = {
  projectRoot: string;
  aliases: Record<string, string>;
  onParseError?: (filePath: string, error: unknown) => void;
  resolve?: (specifier: string, importerPath: string) => Promise<string | null | undefined>;
};

type DevCssFileScan = {
  cssHrefs: string[];
  sourceImports: string[];
};

type DevCssImportsCacheEntry = {
  scan: Promise<DevCssFileScan>;
  mtimeMs: number;
  size: number;
};

export type DevCssImportsCache = Map<string, DevCssImportsCacheEntry>;

const CSS_EXTENSIONS = new Set([
  ".css",
  ".less",
  ".sass",
  ".scss",
  ".styl",
  ".stylus",
  ".pcss",
  ".postcss",
  ".sss",
]);

const SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs", ".cts", ".cjs"];

function isSourceFilePath(filePath: string): boolean {
  return SOURCE_EXTENSIONS.includes(path.extname(filePath));
}

function isNodeModulesPath(filePath: string): boolean {
  return filePath.split(path.sep).includes("node_modules");
}

function isInProjectRoot(filePath: string, projectRoot: string): boolean {
  const relative = path.relative(projectRoot, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isScannableSourceImport(filePath: string, projectRoot: string): boolean {
  return isInProjectRoot(filePath, projectRoot) && !isNodeModulesPath(filePath);
}

function isSpecialCssRequest(specifier: string): boolean {
  return /[?&](?:raw|url|inline)(?:\b|=|&|$)/.test(specifier);
}

function isCssSpecifier(specifier: string): boolean {
  const [pathname] = specifier.split("?", 1);
  return CSS_EXTENSIONS.has(path.extname(pathname));
}

function pathToDevHref(filePath: string, projectRoot: string): string {
  const relative = path.relative(projectRoot, filePath).split(path.sep).join("/");
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `/${relative}`;
  }
  return `/@fs/${normalizePathSeparators(filePath)}`;
}

async function absolutePathOrRootHref(value: string, projectRoot: string): Promise<string> {
  const relative = path.relative(projectRoot, value);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return pathToDevHref(value, projectRoot);
  }
  try {
    await fs.access(value);
    return pathToDevHref(value, projectRoot);
  } catch {
    return value;
  }
}

function splitCssSpecifier(specifier: string): { pathname: string; query: string } {
  const [pathname, query = ""] = specifier.split("?", 2);
  return { pathname, query };
}

function resolveAliasSpecifier(pathname: string, aliases: Record<string, string>): string | null {
  let bestMatch: { find: string; replacement: string } | null = null;
  for (const [find, replacement] of Object.entries(aliases)) {
    if (pathname !== find && !pathname.startsWith(`${find}/`)) continue;
    if (!bestMatch || find.length > bestMatch.find.length) {
      bestMatch = { find, replacement };
    }
  }
  if (!bestMatch) return null;

  const suffix = pathname.slice(bestMatch.find.length);
  return `${bestMatch.replacement}${suffix}`;
}

async function existingFilePath(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() ? filePath : null;
  } catch {
    return null;
  }
}

async function resolveSourceCandidate(candidatePath: string): Promise<string | null> {
  if (path.extname(candidatePath)) {
    return existingFilePath(candidatePath);
  }

  for (const extension of SOURCE_EXTENSIONS) {
    const filePath = await existingFilePath(`${candidatePath}${extension}`);
    if (filePath) return filePath;
  }

  for (const extension of SOURCE_EXTENSIONS) {
    const filePath = await existingFilePath(path.join(candidatePath, `index${extension}`));
    if (filePath) return filePath;
  }

  return null;
}

async function resolveSourceImportPath(
  specifier: string,
  importerPath: string,
  context: DevCssResolutionContext,
): Promise<string | null> {
  const { pathname } = splitCssSpecifier(specifier);
  if (isSpecialCssRequest(specifier)) return null;
  if (!pathname || isCssSpecifier(pathname)) return null;

  let sourcePath: string | null = null;
  if (pathname.startsWith(".")) {
    sourcePath = await resolveSourceCandidate(path.resolve(path.dirname(importerPath), pathname));
  } else if (pathname.startsWith("/")) {
    sourcePath = await resolveSourceCandidate(pathname);
  } else {
    const resolvedAlias = resolveAliasSpecifier(pathname, context.aliases);
    if (resolvedAlias) {
      sourcePath = await resolveSourceCandidate(
        path.isAbsolute(resolvedAlias)
          ? resolvedAlias
          : path.resolve(context.projectRoot, resolvedAlias),
      );
    }
  }

  if (!sourcePath && context.resolve) {
    const resolvedPath = await context.resolve(pathname, importerPath);
    if (resolvedPath) {
      sourcePath = await resolveSourceCandidate(resolvedPath);
    }
  }

  return sourcePath && isScannableSourceImport(sourcePath, context.projectRoot) ? sourcePath : null;
}

async function resolveCssImportHref(
  specifier: string,
  importerPath: string,
  context: DevCssResolutionContext,
): Promise<string | null> {
  if (isSpecialCssRequest(specifier) || !isCssSpecifier(specifier)) return null;

  const { pathname, query } = splitCssSpecifier(specifier);
  let href: string | null = null;

  if (pathname.startsWith(".")) {
    href = pathToDevHref(path.resolve(path.dirname(importerPath), pathname), context.projectRoot);
  } else if (pathname.startsWith("/")) {
    href = await absolutePathOrRootHref(pathname, context.projectRoot);
  } else {
    const resolvedAlias = resolveAliasSpecifier(pathname, context.aliases);
    if (resolvedAlias) {
      href = path.isAbsolute(resolvedAlias)
        ? await absolutePathOrRootHref(resolvedAlias, context.projectRoot)
        : pathToDevHref(path.resolve(context.projectRoot, resolvedAlias), context.projectRoot);
    }
  }

  if (!href && context.resolve) {
    const resolvedPath = await context.resolve(pathname, importerPath);
    if (resolvedPath) href = await absolutePathOrRootHref(resolvedPath, context.projectRoot);
  }

  return href ? href + (query ? `?${query}` : "") : null;
}

async function collectStaticImportSpecifiers(
  filePath: string,
  source: string,
  onParseError: ((filePath: string, error: unknown) => void) | undefined,
): Promise<string[]> {
  let code: string;
  try {
    code = (await transformWithOxc(source, filePath, { sourcemap: false })).code;
  } catch (error) {
    onParseError?.(filePath, error);
    return [];
  }

  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code);
  } catch (error) {
    onParseError?.(filePath, error);
    return [];
  }

  const specifiers: string[] = [];
  for (const node of ast.body) {
    if (
      node.type !== "ImportDeclaration" &&
      node.type !== "ExportNamedDeclaration" &&
      node.type !== "ExportAllDeclaration"
    ) {
      continue;
    }
    if (!node.source) continue;
    const sourceValue = node.source.value;
    if (typeof sourceValue === "string") specifiers.push(sourceValue);
  }
  return specifiers;
}

async function scanDevCssImports(
  filePath: string,
  context: DevCssResolutionContext,
): Promise<DevCssFileScan> {
  if (!isSourceFilePath(filePath)) {
    return { cssHrefs: [], sourceImports: [] };
  }

  let source: string;
  try {
    source = await fs.readFile(filePath, "utf-8");
  } catch {
    return { cssHrefs: [], sourceImports: [] };
  }

  const cssHrefs: string[] = [];
  const sourceImports: string[] = [];
  for (const specifier of await collectStaticImportSpecifiers(
    filePath,
    source,
    context.onParseError,
  )) {
    const href = await resolveCssImportHref(specifier, filePath, context);
    if (href) {
      cssHrefs.push(href);
      continue;
    }

    const sourceImport = await resolveSourceImportPath(specifier, filePath, context);
    if (sourceImport) sourceImports.push(sourceImport);
  }

  return { cssHrefs, sourceImports };
}

async function getCachedCssImportScan(
  filePath: string,
  context: DevCssResolutionContext,
  cache: DevCssImportsCache,
): Promise<DevCssFileScan | undefined> {
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(filePath);
  } catch {
    cache.delete(filePath);
    return undefined;
  }

  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.scan;
  }

  // Dev cache validation intentionally uses cheap file metadata. Rapid same-size
  // edits or renamed transitive imports can serve stale scans until an importer
  // changes, but missing files are dropped on stat failure below.
  const scan = scanDevCssImports(filePath, context);
  cache.set(filePath, { scan, mtimeMs: stats.mtimeMs, size: stats.size });
  return scan;
}

export async function collectDevCssHrefsForFiles(
  filePaths: readonly string[],
  context: DevCssResolutionContext,
  cache: DevCssImportsCache = new Map(),
): Promise<string[]> {
  async function collect(filePath: string, ancestors: ReadonlySet<string>): Promise<string[]> {
    if (ancestors.has(filePath)) return [];

    const scan = await getCachedCssImportScan(filePath, context, cache);
    if (!scan) return [];

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(filePath);
    const childHrefs = await Promise.all(
      scan.sourceImports.map((sourceImport) => collect(sourceImport, nextAncestors)),
    );
    return [...scan.cssHrefs, ...childHrefs.flat()];
  }

  const hrefsByFile = await Promise.all(filePaths.map((filePath) => collect(filePath, new Set())));

  return [...new Set(hrefsByFile.flat())];
}
