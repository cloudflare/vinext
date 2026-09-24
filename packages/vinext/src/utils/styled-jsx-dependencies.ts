/**
 * Whether installed packages reach styled-jsx through their dependency graph.
 *
 * A package that ships `<style jsx>` precompiled imports `styled-jsx/style`
 * itself and declares styled-jsx in its manifest. It may sit behind other
 * packages (the app depends on A, A on B, B declares styled-jsx), so a
 * package counts when it declares styled-jsx or any installed dependency of
 * it does. Used by the dev decision to register styled-jsx up front and by the
 * Node build to keep such packages (and their parents) bundled.
 */
import fs from "node:fs";
import path, { toSlash } from "pathslash";

/** Where an installed package lists what it needs at runtime. */
const RUNTIME_DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

/**
 * Never traversed: `next` always depends on styled-jsx (for its own use), and
 * the rest never do — skipping them keeps every walk off the largest subtrees.
 */
const SKIPPED_PACKAGES = new Set(["next", "react", "react-dom", "scheduler", "vinext", "vite"]);

type InstalledPackage = {
  /** Real path of the package directory. */
  dir: string;
  declaresStyledJsx: boolean;
  dependencies: string[];
};

export type StyledJsxDependencyGraph = {
  /** Whether the package in `packageDir` declares styled-jsx or reaches a package that does. */
  packageReachesStyledJsx(packageDir: string): boolean;
  /**
   * Whether dependency `name`, resolved Node-style from `fromDir`, reaches
   * styled-jsx. Unresolvable dependencies do not.
   */
  dependencyReachesStyledJsx(fromDir: string, name: string): boolean;
};

function readRecord(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Create a graph that reads each installed manifest at most once and
 * remembers every answer, so repeated questions within one build or dev
 * session cost a map lookup. A walk stops at the first package that declares
 * styled-jsx; one that finds none marks every package it visited, since their
 * dependencies were all explored.
 */
export function createStyledJsxDependencyGraph(): StyledJsxDependencyGraph {
  const packages = new Map<string, InstalledPackage | null>();
  const reaches = new Map<string, boolean>();

  function readPackage(dir: string): InstalledPackage | null {
    let realDir: string;
    try {
      realDir = toSlash(fs.realpathSync.native(dir));
    } catch {
      return null;
    }
    const cached = packages.get(realDir);
    if (cached !== undefined) return cached;
    const manifest = readRecord(path.join(realDir, "package.json"));
    const dependencies = new Set<string>();
    for (const field of RUNTIME_DEPENDENCY_FIELDS) {
      const listed = manifest?.[field];
      if (typeof listed === "object" && listed !== null) {
        for (const name of Object.keys(listed)) dependencies.add(name);
      }
    }
    const installed: InstalledPackage | null = manifest
      ? {
          dir: realDir,
          declaresStyledJsx: dependencies.has("styled-jsx"),
          dependencies: [...dependencies].filter(
            (name) => name !== "styled-jsx" && !SKIPPED_PACKAGES.has(name),
          ),
        }
      : null;
    packages.set(realDir, installed);
    return installed;
  }

  /** Node's lookup: `<ancestor>/node_modules/<name>` for each non-`node_modules` ancestor. */
  function resolvePackageDir(fromDir: string, name: string): string | null {
    for (let dir = fromDir; ; dir = path.dirname(dir)) {
      if (path.basename(dir) !== "node_modules") {
        const candidate = path.join(dir, "node_modules", name);
        if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
      }
      if (path.dirname(dir) === dir) return null;
    }
  }

  function packageReachesStyledJsx(packageDir: string): boolean {
    const start = readPackage(packageDir);
    if (!start) return false;
    const known = reaches.get(start.dir);
    if (known !== undefined) return known;
    const visited = new Set([start.dir]);
    const pending = [start];
    for (let current = pending.pop(); current; current = pending.pop()) {
      if (current.declaresStyledJsx || reaches.get(current.dir) === true) {
        reaches.set(start.dir, true);
        return true;
      }
      if (reaches.get(current.dir) === false) continue;
      for (const name of current.dependencies) {
        const dependencyDir = resolvePackageDir(current.dir, name);
        const dependency = dependencyDir ? readPackage(dependencyDir) : null;
        if (!dependency || visited.has(dependency.dir)) continue;
        visited.add(dependency.dir);
        pending.push(dependency);
      }
    }
    for (const dir of visited) reaches.set(dir, false);
    return false;
  }

  return {
    packageReachesStyledJsx,
    dependencyReachesStyledJsx(fromDir, name) {
      if (name === "styled-jsx") return true;
      if (SKIPPED_PACKAGES.has(name)) return false;
      const dir = resolvePackageDir(fromDir, name);
      return dir !== null && packageReachesStyledJsx(dir);
    },
  };
}
