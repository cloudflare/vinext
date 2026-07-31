import { existsSync } from "node:fs";
import { glob } from "node:fs/promises";
import path, { toSlash } from "pathslash";
import { escapeRegExp } from "../utils/regex.js";

const DEFAULT_PAGE_EXTENSIONS = ["tsx", "ts", "jsx", "js"] as const;
const DEFAULT_VINEXT_RESOLVE_EXTENSIONS = [
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".mjs",
  ".mts",
  ".json",
] as const;

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

function buildExtensionGlob(stem: string, extensions: readonly string[]): string {
  if (extensions.length === 1) {
    return `${stem}.${extensions[0]}`;
  }
  return `${stem}.{${extensions.join(",")}}`;
}

function includeDotDirectoryMatches(pattern: string): string {
  if (!pattern.startsWith("**/")) return pattern;
  return `{**,**/.*/**}/${pattern.slice(3)}`;
}

export type ValidFileMatcher = {
  extensions: string[];
  dottedExtensions: string[];
  extensionRegex: RegExp;
  isPageFile(filePath: string): boolean;
  isAppRouterPage(filePath: string): boolean;
  isAppRouterRoute(filePath: string): boolean;
  isAppLayoutFile(filePath: string): boolean;
  isAppDefaultFile(filePath: string): boolean;
  stripExtension(filePath: string): string;
};

/**
 * Ported in spirit from Next.js createValidFileMatcher:
 * packages/next/src/server/lib/find-page-file.ts
 */
export function createValidFileMatcher(
  pageExtensions?: readonly string[] | null,
): ValidFileMatcher {
  const extensions = normalizePageExtensions(pageExtensions);
  const dottedExtensions = extensions.map((ext) => `.${ext}`);
  const extPattern = `(?:${extensions.map((ext) => escapeRegExp(ext)).join("|")})`;

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

/** Check if a file exists with any configured page extension. */
export function findFileWithExtensions(basePath: string, matcher: ValidFileMatcher): boolean {
  return matcher.dottedExtensions.some((ext) => existsSync(basePath + ext));
}

/**
 * Find a file by basename and configured page extension in a directory.
 * Returns the first matching absolute path, or null if not found.
 */
export function findFileWithExts(
  dir: string,
  name: string,
  matcher: ValidFileMatcher,
): string | null {
  for (const ext of matcher.dottedExtensions) {
    const filePath = path.join(dir, name + ext);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

/**
 * Add the config extensions produced by `vinext init` to vinext's resolver.
 *
 * `pageExtensions` is intentionally not part of module resolution. Next.js
 * uses it to discover route files; custom module extensions are configured
 * separately through `turbopack.resolveExtensions` or webpack
 * `resolve.extensions`.
 *
 * The default order preserves vinext's existing module-resolution behavior
 * and matches Next.js Turbopack for overlapping JavaScript and TypeScript
 * extensions.
 *
 * `.cjs`/`.cts` go last because `vinext init` renames CJS config files when it
 * adds `"type": "module"`, and app code may import those files extensionlessly.
 */
export function buildViteResolveExtensions(
  viteExtensions: readonly string[] = DEFAULT_VINEXT_RESOLVE_EXTENSIONS,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const ext of [...viteExtensions, ".cjs", ".cts"]) {
    if (seen.has(ext)) continue;
    seen.add(ext);
    result.push(ext);
  }
  return result;
}

/**
 * Normalize an explicit Next.js resolver extension list for Vite.
 *
 * Unlike `pageExtensions`, both Turbopack's `resolveExtensions` and webpack's
 * `resolve.extensions` replace their resolver defaults. The empty string is a
 * webpack/Turbopack convention for trying the import exactly as written; Vite
 * already does that before appending extensions, so it must be omitted here.
 */
export function normalizeViteResolveExtensions(extensions: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const extension of extensions) {
    const trimmed = extension.trim();
    if (!trimmed) continue;
    const dotted = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    if (seen.has(dotted)) continue;
    seen.add(dotted);
    result.push(dotted);
  }
  return result;
}

/**
 * Use function-form exclude for Node < 22.14 compatibility.
 *
 * Yields forward-slash relative paths: node's glob emits native (backslash)
 * separators on Windows, so each match goes through `toSlash` — this is the
 * boundary where external fs output enters the canonical forward-slash space.
 */
export async function* scanWithExtensions(
  stem: string,
  cwd: string,
  extensions: readonly string[],
  exclude?: (name: string) => boolean,
): AsyncGenerator<string> {
  const pattern = includeDotDirectoryMatches(buildExtensionGlob(stem, extensions));
  for await (const file of glob(pattern, {
    cwd,
    ...(exclude ? { exclude } : {}),
  })) {
    yield toSlash(file);
  }
}
