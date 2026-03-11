import fs from "node:fs";
import path from "node:path";

export interface PublicEntrypoint {
  specifier: string;
  entryFile: string;
}

export interface ApiManifest {
  version: string;
  extractedAt: string;
  modules: Record<string, string[]>; // "next/headers" -> ["cookies", "headers", "draftMode"]
}

/**
 * Discover public Next.js entry files from the published package layout.
 *
 * We treat any .js file outside dist/ as a candidate public entrypoint and
 * let export extraction decide whether it has runtime exports worth tracking.
 * This keeps the manifest resilient to newly added entrypoints without
 * maintaining a second hard-coded module list.
 */
export function discoverPublicEntrypoints(nextPkgDir: string): PublicEntrypoint[] {
  const found: PublicEntrypoint[] = [];

  function walk(currentDir: string, relativeDir = ""): void {
    const dirents = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirents) {
      const relativePath = relativeDir ? path.posix.join(relativeDir, dirent.name) : dirent.name;

      if (dirent.isDirectory()) {
        if (relativePath === "dist") continue;
        walk(path.join(currentDir, dirent.name), relativePath);
        continue;
      }

      if (!dirent.isFile() || !dirent.name.endsWith(".js")) continue;

      const modulePath = relativePath.replace(/\.js$/, "").replace(/\/index$/, "");

      found.push({
        specifier: `next/${modulePath}`,
        entryFile: relativePath,
      });
    }
  }

  walk(nextPkgDir);
  return found.sort((a, b) => a.specifier.localeCompare(b.specifier));
}

/**
 * Extract exports from a Pattern A root file (direct exports like headers.js, server.js, cache.js).
 *
 * Pattern A files have individual export assignments:
 *   - module.exports.X = ...
 *   - exports.X = ...
 *   - Object literal: const serverExports = { X: require(...).X, Y: ... }
 *
 * Returns array of export names, or null if this is a Pattern B re-export
 * (module.exports = require('./dist/...')) with no individual exports.
 */
export function extractExportsFromRootFile(source: string): string[] | null {
  const exports = new Set<string>();

  // Check for individual export assignments: module.exports.X = ... or exports.X = ...
  const individualExportRe = /(?:module\.exports|exports)\.(\w+)\s*=/g;
  let match: RegExpExecArray | null;
  while ((match = individualExportRe.exec(source)) !== null) {
    exports.add(match[1]);
  }

  // Check for object literal assignments like:
  // const serverExports = { X: require(...)..., Y: ... }
  // const cacheExports = { X: require(...)..., Y: ... }
  const objLiteralRe = /(?:const|let|var)\s+\w+\s*=\s*\{([^}]+)\}/gs;
  while ((match = objLiteralRe.exec(source)) !== null) {
    const body = match[1];
    // Extract keys from object literal (key: value pairs)
    const keyRe = /(\w+)\s*:/g;
    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = keyRe.exec(body)) !== null) {
      exports.add(keyMatch[1]);
    }
  }

  // If we found individual exports, this is Pattern A
  if (exports.size > 0) {
    exports.delete("__esModule");
    return [...exports].sort();
  }

  // Check if this is a pure Pattern B re-export: module.exports = require('./dist/...')
  if (/module\.exports\s*=\s*require\s*\(/.test(source)) {
    return null;
  }

  // Check if it's a types-only stub (just throws)
  if (/throw\s+new\s+Error/.test(source) && exports.size === 0) {
    return [];
  }

  // No exports found
  return [];
}

/**
 * Resolve re-export target path from a Pattern B root file.
 * Matches: module.exports = require('./dist/...')
 */
export function resolveReExportTarget(source: string): string | null {
  const match = source.match(/module\.exports\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  return match ? match[1] : null;
}

/**
 * Extract exports from a dist file (Pattern B1/B2/B3).
 *
 * B1: 0 && (module.exports = { X: null, Y: null, ... })
 * B2: _export(exports, { X: fn, Y: fn })
 * B3: Object.defineProperty(exports, "X", { ... })
 */
export function extractExportsFromDistFile(source: string): string[] {
  const exports = new Set<string>();

  // B1: 0 && (module.exports = { X: null, Y: null, ... })
  const b1Re = /0\s*&&\s*\(\s*module\.exports\s*=\s*\{([^}]+)\}\s*\)/gs;
  let match: RegExpExecArray | null;
  while ((match = b1Re.exec(source)) !== null) {
    const body = match[1];
    const keyRe = /(\w+)\s*:/g;
    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = keyRe.exec(body)) !== null) {
      exports.add(keyMatch[1]);
    }
  }

  // B2: _export(exports, { X: function() { ... }, Y: function() { ... } })
  const b2Re = /_export\s*\(\s*exports\s*,\s*\{([\s\S]*?)\}\s*\)/g;
  while ((match = b2Re.exec(source)) !== null) {
    const body = match[1];
    // Match keys -- they can have comments before the colon
    const keyRe = /(?:\/\*[\s\S]*?\*\/\s*)?(\w+)\s*:\s*function/g;
    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = keyRe.exec(body)) !== null) {
      exports.add(keyMatch[1]);
    }
  }

  // B3: Object.defineProperty(exports, "X", { ... })
  // Also handles the variant with a comment before the string:
  //   Object.defineProperty(exports, /**...*/ "default", { ... })
  const b3Re = /Object\.defineProperty\s*\(\s*exports\s*,\s*(?:\/\*[\s\S]*?\*\/\s*)?["'](\w+)["']/g;
  while ((match = b3Re.exec(source)) !== null) {
    exports.add(match[1]);
  }

  exports.delete("__esModule");
  return [...exports].sort();
}

/**
 * Get all exports for a module, handling both Pattern A and B.
 */
export function getModuleExports(
  nextPkgDir: string,
  moduleName: string,
  entryFile?: string,
): string[] {
  const rootFile = path.join(nextPkgDir, entryFile || `${moduleName}.js`);
  if (!fs.existsSync(rootFile)) return [];

  const source = fs.readFileSync(rootFile, "utf-8");

  // Try Pattern A first
  const directExports = extractExportsFromRootFile(source);
  if (directExports !== null) return directExports;

  // Pattern B: resolve re-export target
  const target = resolveReExportTarget(source);
  if (!target) return [];

  // Resolve target relative to the entry file's directory
  // Handle both './dist/...' (relative to entry file) and 'next/dist/...' paths
  let targetPath: string;
  if (target.startsWith("next/")) {
    targetPath = path.join(nextPkgDir, target.slice(5));
  } else {
    const entryDir = path.dirname(rootFile);
    targetPath = path.join(entryDir, target);
  }

  const candidatePaths = [`${targetPath}.js`, path.join(targetPath, "index.js")];
  const resolvedTargetPath = candidatePaths.find((candidate) => fs.existsSync(candidate));
  if (!resolvedTargetPath) return [];

  const distSource = fs.readFileSync(resolvedTargetPath, "utf-8");
  return extractExportsFromDistFile(distSource);
}

/**
 * Build the full manifest from a next package directory.
 */
export function buildManifest(nextPkgDir: string): ApiManifest {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(nextPkgDir, "package.json"), "utf-8"));

  const modules: Record<string, string[]> = {};
  for (const { specifier, entryFile } of discoverPublicEntrypoints(nextPkgDir)) {
    const moduleExports = getModuleExports(nextPkgDir, specifier.slice(5), entryFile);
    if (moduleExports.length > 0) {
      modules[specifier] = moduleExports.sort();
    }
  }

  return {
    version: pkgJson.version,
    extractedAt: new Date().toISOString(),
    modules,
  };
}

// CLI entry
if (process.argv[1] === import.meta.filename) {
  const nextDir = process.argv[2] || path.resolve("node_modules/next");
  const manifest = buildManifest(nextDir);
  const output = process.argv[3] || "api-manifest.json";
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `Wrote ${output} (next@${manifest.version}, ${Object.keys(manifest.modules).length} modules)`,
  );
}
