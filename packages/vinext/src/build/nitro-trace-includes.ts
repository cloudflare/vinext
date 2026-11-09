import fs from "node:fs";
import path, { toSlash } from "pathslash";
import {
  createValidFileMatcher,
  findFileWithExtensions,
  type ValidFileMatcher,
} from "../routing/file-matcher.js";
import type { MetadataFileRoute } from "../server/metadata-routes.js";
import { hasExportedName } from "./report.js";
import {
  createContainsMatcher,
  createPathMatcher,
  globFiles,
  isTranslatedExactly,
  matchesWholeName,
} from "./trace-glob.js";

/**
 * Apply Next.js `outputFileTracingIncludes` / `outputFileTracingExcludes` to
 * Nitro's dependency trace.
 *
 * Nitro copies externalized packages into `.output/server/node_modules` using
 * a file-level trace, so files a package only reads at runtime (for example
 * TypeScript's `lib.*.d.ts`) are left out. Next.js lets apps add those files
 * with `outputFileTracingIncludes`. Nitro exposes the traced package list
 * through the `traceOpts.hooks.tracedPackages` hook before it writes the
 * output, so included files inside `node_modules` are added there. When the
 * server bundle has no traced externals Nitro skips the trace (and the hook),
 * so the included files are copied after the build instead. Included files of
 * a nested package (`parent/node_modules/child`) that Nitro did not trace are
 * also copied after the build, to the same nested path, because Nitro writes
 * the packages it is given at the top level. Excludes do not move a package
 * version: its remaining files keep the trace parents nf3 places it by
 * (`traceOpts.hooks.tracedFiles`).
 *
 * Next.js matches every route key against each server route and writes one
 * trace per route: the route's traced files plus the files of every matching
 * include key, minus the files of every matching exclude key
 * (`collect-build-traces.ts`). A deployment ships the union of those traces.
 * Nitro emits one server bundle and one traced `node_modules` shared by every
 * route, so vinext ships that union directly:
 *
 * - an included file ships when some route includes it and none of that
 *   route's excludes match it;
 * - a file Nitro traced is dropped only when the excludes of every route match
 *   it, because the shared trace cannot be attributed to individual routes,
 *   and so do the excludes of a key matching `next-server`, because the trace
 *   also holds the server's own dependencies (Next.js's separate
 *   `next-server` trace).
 *
 * Next.js's Turbopack build does not apply excludes to included files; this
 * follows the webpack build, which does. Edge runtime routes are matched like
 * other routes, since they run in the same Node server under Nitro. Files
 * outside `node_modules` are not part of Nitro's traced output, so they are
 * reported through `warn` and otherwise ignored.
 */

type TracedPackageVersion = {
  path: string;
  files: string[];
  pkgJSON: { name?: string; version?: string };
};

export type TracedPackages = Record<
  string,
  { name: string; versions: Record<string, TracedPackageVersion> }
>;

type PackageFiles = {
  name: string;
  /** Package root as matched, so symlinked packages keep their link name. */
  path: string;
  /**
   * Output directory under `node_modules` for a package nested in another
   * package's `node_modules` (`parent/node_modules/child`), else `null`.
   */
  nested: string | null;
  /** Matched paths (output layout) with their real paths (identity). */
  files: Array<{ path: string; real: string }>;
};

/** nf3's traced files by real path, with the files that import each one. */
export type TracedFiles = Record<string, { parents: string[] }>;

export type NitroTraceIncludes = {
  /** Nitro `traceOpts.hooks.tracedFiles` hook, which runs first. */
  tracedFiles(tracedFiles: TracedFiles): void;
  /** Nitro `traceOpts.hooks.tracedPackages` hook. */
  tracedPackages(tracedPackages: TracedPackages): void;
  /**
   * Copy included files into `<serverDir>/node_modules` after Nitro wrote its
   * traced output: files of nested packages Nitro did not trace, and every
   * included file when Nitro did not run its dependency trace for this build.
   */
  write(serverDir: string): void;
};

export type NitroTraceIncludesOptions = {
  root: string;
  /** Server route names, from {@link collectTraceRouteNames}. */
  routes: readonly string[];
  includes: Readonly<Record<string, readonly string[]>>;
  excludes: Readonly<Record<string, readonly string[]>>;
  warn: (message: string) => void;
};

// Nitro's tracer reports forward-slash paths, so compare in that form.
const NODE_MODULES_SEGMENT = "/node_modules/";

function isGroupSegment(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

/** Port of Next.js `normalizeAppPath`. */
function normalizeAppPath(entryName: string): string {
  const segments = entryName.split("/");
  let pathname = "";
  segments.forEach((segment, index) => {
    if (!segment || isGroupSegment(segment) || segment.startsWith("@")) return;
    if ((segment === "page" || segment === "route") && index === segments.length - 1) return;
    pathname += `/${segment}`;
  });
  return pathname || "/";
}

/** Port of Next.js `normalizePagePath`. */
function normalizePagePath(page: string, isDynamic: boolean): string {
  if (/^\/index(\/|$)/.test(page) && !isDynamic) return `/index${page}`;
  return page === "/" ? "/index" : page;
}

function generatesMultipleFiles(route: MetadataFileRoute): boolean {
  if (!route.isDynamic) return false;
  let code: string;
  try {
    code = fs.readFileSync(route.filePath, "utf8");
  } catch {
    return false;
  }
  return (
    hasExportedName(code, "generateSitemaps") || hasExportedName(code, "generateImageMetadata")
  );
}

/**
 * The entry name Next.js gives a metadata file (`createPagesMapping`):
 * `normalizeMetadataRoute` adds `.txt` / `.webmanifest` to root robots and
 * manifest files and a hash suffix under route groups and parallel routes,
 * then `normalizeMetadataPageToRoute` adds `.xml` to sitemaps, or
 * `[__metadata_id__]` when the file exports `generateSitemaps` or
 * `generateImageMetadata`. Dynamic segments keep their names.
 */
function metadataRouteName(
  route: MetadataFileRoute,
  appDir: string,
  matcher: ValidFileMatcher,
  metadataRouteSuffix: (parentSegments: string[], metaType: string) => string,
): string {
  let page = appEntryKey(toSlash(path.relative(appDir, route.filePath)), matcher);
  let suffix = "";
  if (page === "/robots") page += ".txt";
  else if (page === "/manifest") page += ".webmanifest";
  else suffix = metadataRouteSuffix(page.split("/").slice(1, -1), route.type);
  const { dir, name, ext } = path.parse(page);
  let entry = path.join(dir, `${name}${suffix ? `-${suffix}` : ""}${ext}`);
  if (generatesMultipleFiles(route)) entry += "/[__metadata_id__]";
  else if (entry.endsWith("/sitemap")) entry += ".xml";
  return normalizeAppPath(`app${entry}/route`);
}

/**
 * Next.js's App Router page key for a file relative to `appDir`
 * (`createPagesMapping`), which turns `%5F` into `_`.
 */
function appEntryKey(file: string, matcher: ValidFileMatcher): string {
  return `/${matcher.stripExtension(file)}`.replace(/%5F/g, "_");
}

/**
 * Whether `pages` has `_app`, `_document` or `_error`, which Next.js reads from
 * `<name>.<ext>` or `<name>/index.<ext>` (`getPageFromPath`).
 */
function hasReservedPagesFile(pagesDir: string, matcher: ValidFileMatcher): boolean {
  return ["_app", "_document", "_error"].some(
    (name) =>
      findFileWithExtensions(path.join(pagesDir, name), matcher) ||
      findFileWithExtensions(path.join(pagesDir, name, "index"), matcher),
  );
}

/**
 * Name each server route the way Next.js's build trace step does before
 * matching route keys: the entry name normalized with `normalizeAppPath` for
 * App Router entries (`app/(group)/api/hello/route` is `/app/api/hello`) and
 * `normalizePagePath` for Pages Router entries (`/pages/index`,
 * `/pages/api/hello`). Keys match anywhere in the name, so the documented
 * `/api/hello` and `/*` forms work. The built-in entries Next.js emits
 * (`discoverRoutes`) are included too: `_app`, `_document` and `_error` when
 * there are pages, `_not-found` when there are app entries, and
 * `_global-error` when there are no pages. Root server entries (`instrumentation`,
 * `proxy` or `middleware`) keep their entry names.
 */
export async function collectTraceRouteNames(options: {
  appDir: string | null;
  pagesDir: string | null;
  pageExtensions: readonly string[];
  /** Root server entry names, such as `instrumentation` and `proxy`. */
  rootEntries?: readonly string[];
}): Promise<string[]> {
  const { appDir, pagesDir } = options;
  const matcher = createValidFileMatcher(options.pageExtensions);
  const names = new Set<string>();

  let hasPages = false;
  if (pagesDir) {
    const { apiRouter, pagesRouter } = await import("../routing/pages-router.js");
    const [pages, apis] = await Promise.all([
      pagesRouter(pagesDir, options.pageExtensions, matcher),
      apiRouter(pagesDir, options.pageExtensions, matcher),
    ]);
    for (const route of [...pages, ...apis]) {
      const relative = matcher.stripExtension(toSlash(path.relative(pagesDir, route.filePath)));
      const page = `/${relative}`.replace(/\/index$/, "") || "/";
      names.add(`/pages${normalizePagePath(page, route.isDynamic)}`);
    }
    hasPages = names.size > 0 || hasReservedPagesFile(pagesDir, matcher);
    if (hasPages) {
      for (const name of ["_app", "_document", "_error"]) names.add(`/pages/${name}`);
    }
  }

  if (appDir) {
    const { metadataRouteSuffix, scanMetadataFiles } = await import("../server/metadata-routes.js");
    const appNames = new Set<string>();
    // Every page and route file is an entry, including pages that only fill
    // a parallel route slot (`app/@modal/photo/page` is `/app/photo`).
    for (const file of collectAppEntryFiles(appDir, matcher)) {
      appNames.add(normalizeAppPath(`app${appEntryKey(file, matcher)}`));
    }
    for (const route of scanMetadataFiles(appDir)) {
      appNames.add(metadataRouteName(route, appDir, matcher, metadataRouteSuffix));
    }
    // A root `not-found` file is an app entry too; it builds as `_not-found`.
    if (appNames.size > 0 || findFileWithExtensions(path.join(appDir, "not-found"), matcher)) {
      appNames.add("/app/_not-found");
    }
    if (!hasPages) appNames.add("/app/_global-error");
    for (const name of appNames) names.add(name);
  }

  for (const name of options.rootEntries ?? []) names.add(name);
  return [...names];
}

/**
 * App directory `page` and `route` files relative to `appDir`, like Next.js's
 * `collectAppFiles`, which skips private (`_`-prefixed) folders.
 */
function collectAppEntryFiles(appDir: string, matcher: ValidFileMatcher): string[] {
  const files: string[] = [];
  const walk = (dir: string, relative: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith("_")) continue;
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      const isDirectory =
        entry.isDirectory() || (entry.isSymbolicLink() && isDirectoryPath(absolute));
      if (isDirectory) walk(absolute, file);
      else if (matcher.isAppRouterPage(file)) files.push(file);
    }
  };
  walk(appDir, "");
  return files;
}

function isDirectoryPath(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function realPath(file: string): string | null {
  try {
    return toSlash(fs.realpathSync(file));
  } catch {
    return null;
  }
}

type TraceSelection = {
  /** Included files (matched path to real path) that some route keeps. */
  included: Map<string, string>;
  /**
   * Whether every route excludes a traced file, by its real path or by
   * `linked`, its path through the package's `node_modules/<name>` link.
   */
  isTracedFileExcluded: (file: string, linked: string | null) => boolean;
};

function selectFiles(options: NitroTraceIncludesOptions): TraceSelection {
  const { root, routes, includes, excludes } = options;
  // Patterns vinext cannot match exactly fail safe: such an include key
  // applies to every route, and such an exclude key or glob is ignored.
  const inexact = new Set<string>();
  const keyMatcher = (key: string, fallback: boolean) => {
    if (isTranslatedExactly(key)) return createContainsMatcher(key);
    inexact.add(key);
    return () => fallback;
  };
  const includeKeys = Object.keys(includes).map((key) => [key, keyMatcher(key, true)] as const);
  const excludeKeys = Object.keys(excludes).map((key) => [key, keyMatcher(key, false)] as const);
  const exactExcludes = (globs: readonly string[]) =>
    globs.filter((glob) => isTranslatedExactly(glob) || (inexact.add(glob), false));

  // Routes that match the same keys select the same files.
  const groups = new Map<string, { includes: string[]; excludes: string[] }>();
  for (const route of routes) {
    const matchedIncludes = includeKeys.filter(([, matches]) => matches(route)).map(([key]) => key);
    const matchedExcludes = excludeKeys.filter(([, matches]) => matches(route)).map(([key]) => key);
    groups.set(JSON.stringify([matchedIncludes, matchedExcludes]), {
      includes: [...new Set(matchedIncludes.flatMap((key) => includes[key]))],
      excludes: exactExcludes([...new Set(matchedExcludes.flatMap((key) => excludes[key]))]),
    });
  }
  if (inexact.size > 0) {
    options.warn(
      `[vinext] outputFileTracingIncludes/outputFileTracingExcludes pattern(s) ${[...inexact].join(", ")} ` +
        "use glob syntax vinext does not match exactly like Next.js: " +
        "such include keys apply to every route, and such excludes are ignored.",
    );
  }

  // Nitro lists traced files by real path, so excludes also match from the
  // project root's real path when the root is reached through a symlink.
  const roots = [...new Set([path.resolve(root), realPath(root) ?? path.resolve(root)])];
  const expanded = new Map<string, string[]>();
  const included = new Map<string, string>();
  const routeExcludes: Array<(file: string) => boolean> = [];
  for (const group of groups.values()) {
    const matchers = roots.map((base) => createPathMatcher(base, group.excludes));
    const isExcluded = (file: string) => matchers.some((matches) => matches(file));
    routeExcludes.push(isExcluded);
    for (const glob of group.includes) {
      let files = expanded.get(glob);
      if (!files) {
        // Like Next.js, read Windows separators (globs built with
        // `path.relative`) as `/`.
        files = globFiles(root, toSlash(glob));
        expanded.set(glob, files);
      }
      for (const file of files) {
        if (included.has(file) || isExcluded(file)) continue;
        // Skips files removed during the build.
        const real = realPath(file);
        if (real) included.set(file, real);
      }
    }
  }

  // Next.js keeps the server's own trace (`next-server.js.nft.json`) apart
  // and applies only the excludes of keys matching `next-server` to it
  // (`picomatch(key)('next-server')`). Nitro's trace also holds what the
  // server and its runtime need, so the server is one more owner of each
  // traced file.
  const serverExcludes = exactExcludes([
    ...new Set(
      Object.keys(excludes)
        .filter((key) => isTranslatedExactly(key) && matchesWholeName(key, "next-server"))
        .flatMap((key) => excludes[key]),
    ),
  ]);
  const serverMatchers = roots.map((base) => createPathMatcher(base, serverExcludes));
  routeExcludes.push((file) => serverMatchers.some((matches) => matches(file)));

  return {
    included,
    isTracedFileExcluded: (file, linked) =>
      routeExcludes.every(
        (isExcluded) => isExcluded(file) || (linked !== null && isExcluded(linked)),
      ),
  };
}

/**
 * Where a traced package is linked as `node_modules/<name>`, the path apps
 * write excludes against, when Nitro lists it by another real path (pnpm's
 * virtual store, wherever `virtualStoreDir` puts it). `null` otherwise.
 */
function linkedPackagePath(root: string, name: string, pkgPath: string): string | null {
  const linked = path.join(path.resolve(root), "node_modules", name);
  if (path.resolve(pkgPath) === linked) return null;
  const real = realPath(linked);
  return real !== null && real === realPath(pkgPath) ? linked : null;
}

function splitPackageName(segments: readonly string[]): string[] {
  return segments[0]?.startsWith("@") ? segments.slice(0, 2) : segments.slice(0, 1);
}

/**
 * Split a `node_modules` file path into its package name and root. A package
 * inside another package's `node_modules` keeps that layout (`nested`), like
 * Next.js's trace. pnpm's `.pnpm` store is the exception: nf3 writes those
 * packages at the top level, so they are read from the last boundary.
 */
function packageOfFile(file: string): Omit<PackageFiles, "files"> | null {
  const first = file.indexOf(NODE_MODULES_SEGMENT);
  if (first === -1) return null;
  const last = file.lastIndexOf(NODE_MODULES_SEGMENT);
  const outerBase = file.slice(0, first + NODE_MODULES_SEGMENT.length);
  const isPnpmStore = file.startsWith(".pnpm/", outerBase.length);
  const base = file.slice(0, last + NODE_MODULES_SEGMENT.length);
  const segments = file.slice(base.length).split("/");
  const nameSegments = splitPackageName(segments);
  if (nameSegments.length === 0 || nameSegments.length === segments.length) return null;
  const pkgPath = path.join(base, ...nameSegments);
  return {
    name: nameSegments.join("/"),
    path: pkgPath,
    nested: first !== last && !isPnpmStore ? path.relative(outerBase, pkgPath) : null,
  };
}

function groupByPackage(files: ReadonlyMap<string, string>): {
  packages: PackageFiles[];
  outsideNodeModules: number;
} {
  const packages = new Map<string, PackageFiles>();
  let outsideNodeModules = 0;
  for (const [file, real] of files) {
    const pkg = packageOfFile(file);
    if (!pkg) {
      outsideNodeModules++;
      continue;
    }
    let entry = packages.get(pkg.path);
    if (!entry) {
      entry = { ...pkg, files: [] };
      packages.set(pkg.path, entry);
    }
    entry.files.push({ path: file, real });
  }
  return { packages: [...packages.values()], outsideNodeModules };
}

/**
 * Drop traced files that every route excludes, and the package versions left
 * without files. Nitro writes a `package.json` for each version it keeps, so
 * an excluded `package.json` alone does not remove it.
 */
function removeExcludedTracedFiles(
  tracedPackages: TracedPackages,
  root: string,
  isExcluded: TraceSelection["isTracedFileExcluded"],
): void {
  for (const [name, pkg] of Object.entries(tracedPackages)) {
    for (const [version, entry] of Object.entries(pkg.versions)) {
      const linkedBase = linkedPackagePath(root, name, entry.path);
      entry.files = entry.files.filter((file) => {
        const linked = linkedBase && path.join(linkedBase, path.relative(entry.path, file));
        return !isExcluded(toSlash(file), linked && toSlash(linked));
      });
      if (entry.files.length === 0) delete pkg.versions[version];
    }
    if (Object.keys(pkg.versions).length === 0) delete tracedPackages[name];
  }
}

// Same fallback nf3 uses for traced package directories without a
// package.json, such as Prisma's generated `node_modules/.prisma`.
function readPackageJson(pkg: PackageFiles): TracedPackageVersion["pkgJSON"] {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkg.path, "package.json"), "utf8"));
  } catch {
    return { name: pkg.name, version: "0.0.0" };
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return toSlash(fs.realpathSync(a)) === toSlash(fs.realpathSync(b));
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * Build the Nitro hooks that apply `outputFileTracingIncludes` and
 * `outputFileTracingExcludes`, or `null` when neither option has globs. Globs
 * are expanded when the hooks run, after the server build.
 */
export function createNitroTraceIncludes(
  options: NitroTraceIncludesOptions,
): NitroTraceIncludes | null {
  const { includes, excludes, warn } = options;
  if (Object.keys(includes).length === 0 && Object.keys(excludes).length === 0) return null;
  let applied = false;
  /** Included files to copy after Nitro writes, by output path. */
  let pendingCopies = new Map<string, string>();
  let tracedFiles: TracedFiles | null = null;

  const apply = (tracedPackages: TracedPackages): void => {
    applied = true;
    pendingCopies = new Map();
    const { included, isTracedFileExcluded } = selectFiles(options);
    // nf3 places the versions of a package with several versions through the
    // trace parents of their files, which it reads from `tracedFiles` after
    // this hook.
    const original = new Map<TracedPackageVersion, { files: Set<string>; parents: string[] }>();
    for (const pkg of Object.values(tracedPackages)) {
      for (const version of Object.values(pkg.versions)) {
        const parents = new Set(
          version.files.flatMap((file) => tracedFiles?.[file]?.parents ?? []),
        );
        original.set(version, { files: new Set(version.files), parents: [...parents] });
      }
    }

    const { packages, outsideNodeModules } = groupByPackage(included);
    if (outsideNodeModules > 0) {
      warn(
        `[vinext] outputFileTracingIncludes matched ${outsideNodeModules} file(s) outside node_modules. ` +
          "Nitro's traced output only contains node_modules, so these files are not copied.",
      );
    }

    const otherCopies: string[] = [];
    for (const pkg of packages) {
      const versions = Object.values(tracedPackages[pkg.name]?.versions ?? {});
      // nf3 links the first version without trace parents as the package
      // root, so adding another copy could replace the copy the server bundle
      // actually resolves. Extend a copy Nitro already traced, which nf3
      // places where the bundle resolves it.
      const existing = versions.find((version) => samePath(version.path, pkg.path));
      if (existing) {
        // nf3 lists real paths.
        const existingFiles = new Set(existing.files);
        for (const file of pkg.files) {
          if (existingFiles.has(file.real)) continue;
          existingFiles.add(file.real);
          existing.files.push(file.path);
        }
        continue;
      }
      // nf3 writes every package it is given at the top level, so a nested
      // package keeps its layout by being copied after Nitro writes instead.
      if (pkg.nested !== null) {
        for (const file of pkg.files) {
          pendingCopies.set(path.join(pkg.nested, path.relative(pkg.path, file.path)), file.path);
        }
        continue;
      }
      if (versions.length === 0) {
        const pkgJSON = readPackageJson(pkg);
        tracedPackages[pkg.name] = {
          name: pkg.name,
          versions: {
            [pkgJSON.version || "0.0.0"]: {
              path: pkg.path,
              files: pkg.files.map((file) => file.path),
              pkgJSON,
            },
          },
        };
        continue;
      }
      otherCopies.push(pkg.path);
    }
    // Like Next.js, excludes apply to the traced files plus the includes, so
    // a version whose traced files are all excluded keeps its included files.
    removeExcludedTracedFiles(tracedPackages, options.root, isTracedFileExcluded);
    // Excluded files take their trace parents with them, so a version could
    // move: one left without parents becomes the root copy. Give its
    // remaining files the parents of every file it had, so nf3 places it
    // where it would without the excludes.
    if (tracedFiles) {
      for (const pkg of Object.values(tracedPackages)) {
        for (const entry of Object.values(pkg.versions)) {
          const before = original.get(entry);
          if (
            !before ||
            entry.files.filter((file) => before.files.has(file)).length === before.files.size
          ) {
            continue;
          }
          for (const file of entry.files) {
            tracedFiles[file] = { ...tracedFiles[file], parents: before.parents };
          }
        }
      }
    }
    if (otherCopies.length > 0) {
      warn(
        `[vinext] outputFileTracingIncludes matched files in ${otherCopies.join(", ")}, ` +
          "but Nitro traced a different copy of the same package, so these files are not copied.",
      );
    }
  };

  const copy = (from: string, to: string): void => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  };

  return {
    tracedFiles(files) {
      tracedFiles = files;
    },
    tracedPackages: apply,
    write(serverDir) {
      const outDir = path.join(serverDir, "node_modules");
      if (!applied) {
        // Nitro did not trace, so write what nf3 would have written.
        const tracedPackages: TracedPackages = {};
        apply(tracedPackages);
        for (const pkg of Object.values(tracedPackages)) {
          for (const version of Object.values(pkg.versions)) {
            const files = new Set(version.files);
            const packageJson = path.join(version.path, "package.json");
            if (fs.existsSync(packageJson)) files.add(packageJson);
            for (const file of files) {
              copy(file, path.join(outDir, pkg.name, path.relative(version.path, file)));
            }
          }
        }
      }
      for (const [target, file] of pendingCopies) copy(file, path.join(outDir, target));
    },
  };
}
