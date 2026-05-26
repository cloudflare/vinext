import fs from "node:fs";
import path from "node:path";

const STATIC_IMPORT_RE =
  /^\s*import\s+(?:[^'"]*?\s+from\s*)?["']([^"']+)["']\s*;?\s*(?:\/\/.*)?$/gm;
const CSS_IMPORT_RE = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)$/i;
const SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"];

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

function isResolvableLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

function resolveCssSpecifier(importerPath: string, specifier: string): string {
  if (!isResolvableLocalSpecifier(specifier)) {
    return specifier;
  }

  const unresolvedPath = specifierPath(specifier);
  return specifier.startsWith(".")
    ? path.resolve(path.dirname(importerPath), unresolvedPath)
    : path.resolve(unresolvedPath);
}

function resolveSourceFile(basePath: string): string | null {
  if (path.extname(basePath)) {
    return fs.existsSync(basePath) && fs.statSync(basePath).isFile() ? basePath : null;
  }

  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    for (const extension of SOURCE_EXTENSIONS) {
      const candidate = path.join(basePath, `index${extension}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }

  return null;
}

function resolveSourceSpecifier(importerPath: string, specifier: string): string | null {
  if (!isResolvableLocalSpecifier(specifier) || hasQueryOrHash(specifier)) {
    return null;
  }

  const unresolvedPath = specifierPath(specifier);
  const basePath = specifier.startsWith(".")
    ? path.resolve(path.dirname(importerPath), unresolvedPath)
    : path.resolve(unresolvedPath);
  return resolveSourceFile(basePath);
}

function readStaticImportSpecifiers(filePath: string): string[] {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const specifiers: string[] = [];
  for (const match of source.matchAll(STATIC_IMPORT_RE)) {
    const specifier = match[1];
    if (specifier) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/**
 * Collect CSS imported by a standalone entry without relying on Rollup's
 * shared-entry CSS de-duplication. This intentionally follows only local
 * static JS/TS imports; non-local specifiers still work when they are CSS
 * imports because Vite can resolve them from the generated module.
 */
export function collectStandaloneCssImports(entryPath: string): string[] {
  const seenSources = new Set<string>();
  const seenCss = new Set<string>();
  const cssImports: string[] = [];

  function appendCssImport(importerPath: string, specifier: string): void {
    if (hasQueryOrHash(specifier)) {
      return;
    }

    const resolved = resolveCssSpecifier(importerPath, specifier);
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
    for (const specifier of readStaticImportSpecifiers(resolvedPath)) {
      if (isCssSpecifier(specifier)) {
        appendCssImport(resolvedPath, specifier);
        continue;
      }

      const childSource = resolveSourceSpecifier(resolvedPath, specifier);
      if (childSource) {
        visitSource(childSource);
      }
    }
  }

  visitSource(entryPath);
  return cssImports;
}
