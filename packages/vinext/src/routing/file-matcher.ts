import { existsSync } from "node:fs";
import { glob } from "node:fs/promises";
import path from "node:path";
import { escapeRegExp } from "../utils/regex.js";
import { normalizePathSeparators } from "../utils/path.js";

const DEFAULT_PAGE_EXTENSIONS = ["tsx", "ts", "jsx", "js"] as const;

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
 *
 * `dir` must be forward-slash. The returned path is built with `path.posix.join`,
 * so it is forward-slash too.
 */
export function findFileWithExts(
  dir: string,
  name: string,
  matcher: ValidFileMatcher,
): string | null {
  for (const ext of matcher.dottedExtensions) {
    const filePath = path.posix.join(dir, name + ext);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

/**
 * Vite's default `resolve.extensions` covers `.tsx/.ts/.jsx/.js/.json` (and
 * `.mjs/.mts`). When the user configures `pageExtensions` with values Vite
 * does not know about — e.g. `["platform.tsx", "tsx", "mdx"]` from the
 * Next.js `resolve-extensions` fixture — extensionless imports of those
 * files fail to resolve, and the build crashes with "Custom deploy script
 * failed: undefined (1)".
 *
 * Build the merged extension list that Vite should use:
 *
 *  1. User-configured pageExtensions go first (each prefixed with `.`) so
 *     the user's priority wins. e.g. `.platform.tsx` resolves before `.tsx`.
 *  2. Vite's defaults follow, with duplicates removed.
 *
 * The user's pageExtensions retain their relative order, which is what
 * Next.js / Turbopack do via the `resolveExtensions` config option.
 *
 * See: cloudflare/vinext#1502
 */
export function buildViteResolveExtensions(
  pageExtensions?: readonly string[] | null,
  viteDefaults: readonly string[] = [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"],
): string[] {
  const normalized = normalizePageExtensions(pageExtensions);
  const dotted = normalized.map((ext) => `.${ext}`);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const ext of [...dotted, ...viteDefaults]) {
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
 * separators on Windows, so each match is normalized — this is the entry point
 * that lets downstream consumers treat the scanned paths as canonical
 * forward-slash ids.
 */
export async function* scanWithExtensions(
  stem: string,
  cwd: string,
  extensions: readonly string[],
  exclude?: (name: string) => boolean,
): AsyncGenerator<string> {
  const pattern = buildExtensionGlob(stem, extensions);
  for await (const file of glob(pattern, {
    cwd,
    ...(exclude ? { exclude } : {}),
  })) {
    yield normalizePathSeparators(file);
  }
}
