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
 * with it: it may not contain the project root or sit inside its `.git`, nor
 * contain or sit inside one of `protectedDirs` (the app, pages and public
 * directories). Paths are compared after resolving symlinks, so an alias of
 * the project counts too.
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
  const realGitDir = resolveRealPath(path.join(root, ".git"));
  if (isPathInsideOrEqual(realGitDir, realOutDir)) {
    throw new Error(
      `[vinext] The ${label} "${shown(realOutDir)}" is inside the project's .git directory. ` +
        "Building there would delete the repository. Choose a build.outDir outside it, such " +
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

/**
 * Empty `dir` as Vite's emptyDir does, keeping a `.git` directory in it. A
 * symlinked outDir keeps its link, and the directory it points to is
 * emptied; assertOutputDirIsSafe has already checked that directory.
 */
function emptyDir(dir: string): void {
  const stat = fs.statSync(dir, { throwIfNoEntry: false });
  if (!stat) {
    // A symlink to a directory that no longer exists: remove the link, so the
    // build creates the directory.
    fs.rmSync(dir, { force: true });
    return;
  }
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

// Files in <outDir>/server that belong to one build: its RSC build ID and its
// prerendered output. The server seeds its cache from them and deploy warms
// their paths, and a build that doesn't prerender writes none of them.
const BUILD_PRERENDER_FILES = [
  "vinext-prerender.json",
  "prerendered-routes",
  "vinext-prerender-paths.json",
  "RSC_BUILD_ID",
];

export function cleanBuildOutput(options: CleanBuildOutputOptions): CleanBuildOutputResult {
  const outDir = resolveOutDir(options.root, options.outDir);
  if (!shouldCleanBuildOutput(options, outDir)) {
    // An outDir that isn't emptied (outside the project root by default, as
    // in Vite, or with emptyOutDir: false) mustn't keep the previous build's
    // prerendered output, or the server would serve its pages.
    assertOutputDirIsSafe("build.outDir", outDir, options);
    const serverDir = path.join(outDir, "server");
    // server/ may itself be a symlink.
    assertOutputDirIsSafe("server output directory", serverDir, options);
    for (const file of BUILD_PRERENDER_FILES) {
      fs.rmSync(path.join(serverDir, file), { recursive: true, force: true });
    }
    return { cleaned: false, outDir };
  }

  assertOutputDirIsSafe("build.outDir", outDir, options);
  emptyDir(outDir);
  return { cleaned: true, outDir };
}
