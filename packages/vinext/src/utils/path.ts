import fs from "node:fs";
import path, { toSlash } from "pathslash";

export const isWindows = process.platform === "win32";
export const NODE_MODULES_PATH_RE = /(?:^|[\\/])node_modules(?:[\\/]|$)/;

export function stripViteModuleQuery(id: string): string {
  const queryIndex = id.search(/[?#]/);
  return queryIndex === -1 ? id : id.slice(0, queryIndex);
}

/** Canonicalize an external-origin filesystem path for use as a Vite module id. */
export function canonicalizeFilePath(filePath: string): string {
  try {
    return toSlash(fs.realpathSync.native(filePath));
  } catch {
    return toSlash(filePath);
  }
}

/** Whether `filePath` is a strict descendant of `directory`. */
export function isPathInside(directory: string, filePath: string): boolean {
  const relativePath = path.relative(directory, filePath);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith("../") &&
    !path.isAbsolute(relativePath)
  );
}

/** Whether `filePath` is `directory` itself or one of its descendants. */
export function isPathInsideOrEqual(directory: string, filePath: string): boolean {
  return path.relative(directory, filePath) === "" || isPathInside(directory, filePath);
}

/** Strip a trailing `.js` extension from a module specifier so
 *  `resolveShimModulePath` looks for the correct base name (e.g. `headers.js`
 *  → `headers`). Public and internal shim imports may carry extensionful
 *  subpaths; normalising before resolution prevents looking for non-existent
 *  files like `headers.js.ts`. */
export function stripJsExtension(name: string): string {
  return name.endsWith(".js") ? name.slice(0, -3) : name;
}
