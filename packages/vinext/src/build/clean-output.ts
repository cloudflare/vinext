import fs from "node:fs";
import path, { toSlash } from "pathslash";
import { isPathInside, isPathInsideOrEqual, resolveRealPath } from "../utils/path.js";

/** Source directories no output directory may contain or sit inside, by name. */
export type ProtectedSourceDirs = Record<string, string | false | null | undefined>;

type CleanBuildOutputOptions = {
  root: string;
  outDir?: string;
  emptyOutDir?: boolean;
  protectedDirs?: ProtectedSourceDirs;
};

type CleanBuildOutputResult = {
  cleaned: boolean;
  outDir: string;
};

function resolveOutDir(root: string, outDir: string | undefined): string {
  const resolvedRoot = path.resolve(root);
  if (!outDir) return path.join(resolvedRoot, "dist");
  return path.isAbsolute(outDir) ? outDir : path.resolve(resolvedRoot, outDir);
}

/**
 * Throw if `outDir`, which Vite or vinext empties, would take the project
 * with it: it may not contain the project root, nor contain or sit inside
 * one of `protectedDirs` (the app, pages and public directories). Paths are
 * compared after resolving symlinks, so an alias of the project counts too.
 */
export function assertOutputDirIsSafe(
  label: string,
  outDir: string,
  options: { root: string; protectedDirs?: ProtectedSourceDirs },
): void {
  const root = resolveRealPath(options.root);
  const realOutDir = resolveRealPath(path.resolve(options.root, outDir));
  const shown = (dir: string) => toSlash(path.relative(root, dir)) || ".";
  if (isPathInsideOrEqual(realOutDir, root)) {
    throw new Error(
      `[vinext] The ${label} "${shown(realOutDir)}" contains the project root. Building there ` +
        "would delete the project. Choose a build.outDir below or outside the project, such " +
        "as the default dist.",
    );
  }
  for (const [name, dir] of Object.entries(options.protectedDirs ?? {})) {
    if (!dir) continue;
    const realDir = resolveRealPath(path.resolve(options.root, dir));
    if (isPathInsideOrEqual(realOutDir, realDir) || isPathInsideOrEqual(realDir, realOutDir)) {
      throw new Error(
        `[vinext] The ${label} "${shown(realOutDir)}" overlaps the ${name} directory ` +
          `"${shown(realDir)}". Building there would delete or overwrite its files. Choose ` +
          "a build.outDir outside it, such as the default dist.",
      );
    }
  }
}

/**
 * The directories an environment build writes and Vite empties: each
 * `rolldownOptions.output` entry's `dir`, or the outDir for an entry without
 * one, as Vite's getResolvedOutDirs resolves them.
 */
export function resolveEnvironmentOutputDirs(
  root: string,
  build: { outDir: string; rolldownOptions?: { output?: unknown } },
): string[] {
  const outDir = path.resolve(root, build.outDir);
  const output = build.rolldownOptions?.output;
  if (!output) return [outDir];
  const outputs = (Array.isArray(output) ? output : [output]) as { dir?: string }[];
  return [...new Set(outputs.map(({ dir }) => (dir ? path.resolve(root, dir) : outDir)))];
}

function shouldCleanBuildOutput(options: CleanBuildOutputOptions, outDir: string): boolean {
  if (options.emptyOutDir === false) return false;
  if (options.emptyOutDir === true) return true;

  // As Vite does, empty only an outDir strictly inside the project root by default.
  return isPathInside(path.resolve(options.root), outDir);
}

/** Empty `dir` as Vite's emptyDir does, keeping a `.git` directory in it. */
function emptyDir(dir: string): void {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return;
  // A symlinked outDir is removed as a link; the directory it points to stays.
  if (!stat.isDirectory()) {
    fs.rmSync(dir, { force: true });
    return;
  }
  for (const entry of fs.readdirSync(dir)) {
    // A deploy repository checked out in the outDir keeps its history.
    if (entry === ".git") continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

export function cleanBuildOutput(options: CleanBuildOutputOptions): CleanBuildOutputResult {
  const outDir = resolveOutDir(options.root, options.outDir);
  if (!shouldCleanBuildOutput(options, outDir)) return { cleaned: false, outDir };

  assertOutputDirIsSafe("build.outDir", outDir, options);
  emptyDir(outDir);
  return { cleaned: true, outDir };
}
