import fs from "node:fs";
import path, { toSlash } from "pathslash";

/**
 * Apply Next.js `outputFileTracingIncludes` / `outputFileTracingExcludes` to
 * Nitro's dependency trace.
 *
 * Nitro copies externalized packages into `.output/server/node_modules` using
 * a file-level trace, so files a package only reads at runtime (for example
 * TypeScript's `lib.*.d.ts`) are left out. Next.js lets apps add those files
 * with `outputFileTracingIncludes`. Nitro exposes the traced package list
 * through the `traceOpts.hooks.tracedPackages` hook before it writes the
 * output, so included files inside `node_modules` are added there and
 * excluded files are removed.
 *
 * Files outside `node_modules` are not part of Nitro's traced output and are
 * ignored here.
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
  path: string;
  files: string[];
};

// Nitro's tracer reports forward-slash real paths, so compare in that form.
const NODE_MODULES_SEGMENT = "/node_modules/";

function globFiles(root: string, patterns: readonly string[]): string[] {
  if (patterns.length === 0) return [];
  const files = new Set<string>();
  for (const match of fs.globSync([...patterns], { cwd: root })) {
    const absolute = path.resolve(root, match);
    try {
      if (!fs.statSync(absolute).isFile()) continue;
      files.add(toSlash(fs.realpathSync(absolute)));
    } catch {
      // Broken symlink or file removed during the build.
    }
  }
  return [...files];
}

/** Split a real `node_modules` file path into its package name and root. */
function packageOfFile(file: string): { name: string; path: string } | null {
  const index = file.lastIndexOf(NODE_MODULES_SEGMENT);
  if (index === -1) return null;
  const base = file.slice(0, index + NODE_MODULES_SEGMENT.length);
  const segments = file.slice(base.length).split("/");
  const nameSegments = segments[0]?.startsWith("@") ? segments.slice(0, 2) : segments.slice(0, 1);
  if (nameSegments.length === 0 || nameSegments.length === segments.length) return null;
  return {
    name: nameSegments.join("/"),
    path: path.join(base, ...nameSegments),
  };
}

function groupByPackage(files: readonly string[]): PackageFiles[] {
  const packages = new Map<string, PackageFiles>();
  for (const file of files) {
    const pkg = packageOfFile(file);
    if (!pkg) continue;
    let entry = packages.get(pkg.path);
    if (!entry) {
      entry = { ...pkg, files: [] };
      packages.set(pkg.path, entry);
    }
    entry.files.push(file);
  }
  return [...packages.values()];
}

function readPackageJson(packagePath: string): TracedPackageVersion["pkgJSON"] | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(packagePath, "package.json"), "utf8"));
  } catch {
    return null;
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
 * Build a `tracedPackages` hook for Nitro's dependency trace, or `null` when
 * neither option selects a file.
 */
export function createNitroTraceIncludesHook(
  root: string,
  includes: readonly string[],
  excludes: readonly string[],
): ((tracedPackages: TracedPackages) => void) | null {
  const included = groupByPackage(globFiles(root, includes));
  const excluded = new Set(globFiles(root, excludes));
  if (included.length === 0 && excluded.size === 0) return null;

  return (tracedPackages) => {
    for (const pkg of included) {
      const pkgJSON = readPackageJson(pkg.path);
      if (!pkgJSON) continue;
      const version = pkgJSON.version || "0.0.0";
      const traced = (tracedPackages[pkg.name] ??= { name: pkg.name, versions: {} });
      const existing = traced.versions[version];
      if (!existing) {
        traced.versions[version] = { path: pkg.path, files: [...pkg.files], pkgJSON };
        continue;
      }
      // Another copy of the same name and version is already traced from a
      // different location; leave Nitro's choice alone.
      if (!samePath(existing.path, pkg.path)) continue;
      for (const file of pkg.files) {
        if (!existing.files.includes(file)) existing.files.push(file);
      }
    }

    if (excluded.size === 0) return;
    for (const traced of Object.values(tracedPackages)) {
      for (const version of Object.values(traced.versions)) {
        version.files = version.files.filter((file) => !excluded.has(file));
      }
    }
  };
}
