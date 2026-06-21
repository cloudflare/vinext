import { existsSync, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { escapeRegExp } from "../utils/regex.js";

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
 * Recursively scan `cwd` for files matching `stem.{extensions}`.
 *
 * `stem` is always a recursive glob (a leading globstar joined to a leaf), where
 * the leaf is either a literal basename (`page`, `route`, `layout`, …) or `*`
 * (any basename). The leading globstar means the leaf may live at any depth.
 *
 * This mirrors Next.js route discovery (`recursiveReadDir`), which walks the
 * directory tree itself and only skips directories the caller asks it to. Unlike
 * Node's `glob`, `**` there does NOT skip dot-prefixed directories — Next.js only
 * ignores path parts starting with `_` (and the caller supplies that filter via
 * `exclude`). Using `glob` here silently dropped routes inside dot-directories
 * such as `app/.well-known/openid-configuration/route.ts` (cloudflare/vinext#2014).
 *
 * The `exclude` callback receives the base name of each entry (with extension for
 * files) and, when it returns true, prunes that directory (or skips that file),
 * matching the previous `glob` `exclude` semantics. Yielded paths are relative to
 * `cwd` and use the platform path separator, as `glob` did.
 */
export async function* scanWithExtensions(
  stem: string,
  cwd: string,
  extensions: readonly string[],
  exclude?: (name: string) => boolean,
): AsyncGenerator<string> {
  const leaf = stem.slice(stem.lastIndexOf("/") + 1);
  // Compare against each full extension (not just the substring after the last
  // dot) so multi-dot pageExtensions like "platform.tsx" still match a file
  // named `page.platform.tsx`, exactly as the previous `{a,b}` glob brace did.
  const suffixes = extensions.map((ext) => `.${ext}`);
  const matchesLeaf = (fileName: string): boolean =>
    suffixes.some((suffix) =>
      leaf === "*"
        ? fileName.length > suffix.length && fileName.endsWith(suffix)
        : fileName === `${leaf}${suffix}`,
    );

  yield* scanDirectory(cwd, "", matchesLeaf, exclude);
}

async function* scanDirectory(
  absoluteDir: string,
  relativeDir: string,
  matchesLeaf: (fileName: string) => boolean,
  exclude: ((name: string) => boolean) | undefined,
): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    // Directory removed between readdir calls (or unreadable): abandon it.
    return;
  }

  // Sort for deterministic discovery order regardless of filesystem ordering.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const name = entry.name;
    if (exclude?.(name)) continue;
    const childRelative = relativeDir ? path.join(relativeDir, name) : name;
    // `isDirectory()` is false for symlinks-to-directories, so we don't recurse
    // into them. This is an intentional, conservative divergence from Next.js'
    // `recursiveReadDir` (which follows symlinks): route trees almost never use
    // symlinked directories, and not following them avoids symlink cycles.
    if (entry.isDirectory()) {
      yield* scanDirectory(path.join(absoluteDir, name), childRelative, matchesLeaf, exclude);
    } else if (matchesLeaf(name)) {
      yield childRelative;
    }
  }
}
