import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Dirent } from "node:fs";

export const DEFAULT_PAGE_EXTENSIONS = ["tsx", "ts", "jsx", "js"] as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizePageExtensions(pageExtensions?: readonly string[] | null): string[] {
  if (!Array.isArray(pageExtensions) || pageExtensions.length === 0) {
    return [...DEFAULT_PAGE_EXTENSIONS];
  }

  const filtered = pageExtensions
    .filter((ext): ext is string => typeof ext === "string")
    .map((ext) => ext.trim().replace(/^\.+/, ""))
    .filter((ext) => ext.length > 0);
  return filtered.length > 0 ? [...filtered] : [...DEFAULT_PAGE_EXTENSIONS];
}

export function buildExtensionGlob(stem: string, extensions: readonly string[]): string {
  if (extensions.length === 1) {
    return `${stem}.${extensions[0]}`;
  }
  return `${stem}.{${extensions.join(",")}}`;
}

export interface ValidFileMatcher {
  extensions: string[];
  dottedExtensions: string[];
  extensionRegex: RegExp;
  isPageFile(filePath: string): boolean;
  isAppRouterPage(filePath: string): boolean;
  isAppRouterRoute(filePath: string): boolean;
  isAppLayoutFile(filePath: string): boolean;
  isAppDefaultFile(filePath: string): boolean;
  stripExtension(filePath: string): string;
}

/**
 * Ported in spirit from Next.js createValidFileMatcher:
 * packages/next/src/server/lib/find-page-file.ts
 */
export function createValidFileMatcher(
  pageExtensions?: readonly string[] | null,
): ValidFileMatcher {
  const extensions = normalizePageExtensions(pageExtensions);
  const dottedExtensions = extensions.map((ext) => `.${ext}`);
  const extPattern = `(?:${extensions.map((ext) => escapeRegex(ext)).join("|")})`;

  const extensionRegex = new RegExp(`\\.${extPattern}$`);
  const createLeafPattern = (fileNames: readonly string[]): RegExp => {
    const names = fileNames.length === 1 ? fileNames[0] : `(${fileNames.join("|")})`;
    return new RegExp(`(^${names}|[\\\\/]${names})\\.${extPattern}$`);
  };

  const appRouterPageRegex = createLeafPattern(["page", "route"]);
  const appRouterRouteRegex = createLeafPattern(["route"]);
  const appLayoutRegex = createLeafPattern(["layout"]);
  const appDefaultRegex = createLeafPattern(["default"]);

  return {
    extensions,
    dottedExtensions,
    extensionRegex,
    isPageFile(filePath: string) {
      return extensionRegex.test(filePath);
    },
    isAppRouterPage(filePath: string) {
      return appRouterPageRegex.test(filePath);
    },
    isAppRouterRoute(filePath: string) {
      return appRouterRouteRegex.test(filePath);
    },
    isAppLayoutFile(filePath: string) {
      return appLayoutRegex.test(filePath);
    },
    isAppDefaultFile(filePath: string) {
      return appDefaultRegex.test(filePath);
    },
    stripExtension(filePath: string) {
      return filePath.replace(extensionRegex, "");
    },
  };
}

/**
 * Use function-form exclude for Node 22.14+ compatibility.
 * Scans for files matching stem with extensions recursively under cwd.
 * Supports glob patterns in stem.
 */
export async function* scanWithExtensions(
  stem: string,
  cwd: string,
  extensions: readonly string[],
  exclude?: (name: string) => boolean,
): AsyncGenerator<string> {
  const dir = cwd;

  // Check if stem contains glob patterns
  const isGlob = stem.includes("**") || stem.includes("*");

  // Extract the base name from stem (e.g., "**/page" -> "page", "page" -> "page")
  // For "**/*", baseName will be "*" which means match all files
  const baseName = stem.split("/").pop() || stem;
  const matchAllFiles = baseName === "*";

  async function* scanDir(currentDir: string, relativeBase: string): AsyncGenerator<string> {
    let entries: Dirent[];
    try {
      entries = (await readdir(currentDir, { withFileTypes: true })) as Dirent[];
    } catch {
      return;
    }

    for (const entry of entries) {
      if (exclude && exclude(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;

      const fullPath = join(currentDir, entry.name);
      const relativePath = fullPath.startsWith(dir) ? fullPath.slice(dir.length + 1) : fullPath;

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        yield* scanDir(fullPath, relativePath);
      } else if (entry.isFile()) {
        if (matchAllFiles) {
          // For "**/*" pattern, match any file with the given extensions
          for (const ext of extensions) {
            if (entry.name.endsWith(`.${ext}`)) {
              yield relativePath;
              break;
            }
          }
        } else {
          // Check if file matches baseName.{extension}
          for (const ext of extensions) {
            const expectedName = `${baseName}.${ext}`;
            if (entry.name === expectedName) {
              // For glob patterns like **/page, match any path ending with page.tsx
              if (isGlob) {
                if (relativePath.endsWith(`${baseName}.${ext}`)) {
                  yield relativePath;
                }
              } else {
                // For non-glob stems, the path should start with the stem
                if (
                  relativePath === `${relativeBase}.${ext}` ||
                  relativePath.startsWith(`${relativeBase}/`) ||
                  relativePath === `${baseName}.${ext}`
                ) {
                  yield relativePath;
                }
              }
              break;
            }
          }
        }
      }
    }
  }

  yield* scanDir(dir, stem);
}
