import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Convert absolute filesystem paths into dynamic-import-safe specifiers.
 * Node ESM requires file:// URLs for Windows drive-letter paths.
 */
export function toImportSpecifier(specifier: string): string {
  if (
    specifier.startsWith("file:") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("data:")
  ) {
    return specifier;
  }

  if (path.isAbsolute(specifier)) {
    return pathToFileURL(specifier).href;
  }

  // Support Windows drive-letter paths in cross-platform tests/tools.
  if (path.win32.isAbsolute(specifier)) {
    const normalized = specifier.replace(/\\/g, "/");
    return new URL(`file:///${normalized}`).href;
  }

  return specifier;
}

export function importModule<T = unknown>(specifier: string): Promise<T> {
  return import(/* @vite-ignore */ toImportSpecifier(specifier)) as Promise<T>;
}
