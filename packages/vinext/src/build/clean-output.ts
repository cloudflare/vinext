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

// The byte each escape in a C-style quoted path stands for.
const GIT_QUOTE_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * A C-style quoted path at the start of `text`, as Git writes one, and where
 * it ends; undefined when it isn't one.
 */
function unquoteGitPath(text: string): { path: string; end: number } | undefined {
  const bytes: number[] = [];
  let i = 1;
  while (i < text.length) {
    const char = String.fromCodePoint(text.codePointAt(i)!);
    if (char === '"') return { path: Buffer.from(bytes).toString("utf8"), end: i + 1 };
    if (char !== "\\") {
      bytes.push(...Buffer.from(char));
      i += char.length;
      continue;
    }
    const escape = text[i + 1] ?? "";
    const octal = /^[0-3][0-7]{2}/.exec(text.slice(i + 1))?.[0];
    if (octal) {
      bytes.push(parseInt(octal, 8));
      i += 4;
    } else if (escape in GIT_QUOTE_ESCAPES) {
      bytes.push(GIT_QUOTE_ESCAPES[escape]!);
      i += 2;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/** Git's path lists: entries split on `separator`, any of them quoted. */
function splitGitPathList(list: string, separator: string): string[] {
  const entries: string[] = [];
  let rest = list;
  while (rest) {
    const quoted = rest.startsWith('"') ? unquoteGitPath(rest) : undefined;
    const end = quoted
      ? quoted.end
      : rest.indexOf(separator) === -1
        ? rest.length
        : rest.indexOf(separator);
    entries.push(quoted ? quoted.path : rest.slice(0, end));
    rest = rest.slice(end);
    if (rest.startsWith(separator)) rest = rest.slice(separator.length);
  }
  return entries.filter(Boolean);
}

/**
 * The project's Git storage, as given and with symlinks resolved: the `.git` in
 * the project root or, as Git finds it, the nearest one above it, and any
 * directory or index that Git's environment variables name. In a worktree or
 * submodule `.git` (or GIT_DIR) is a gitfile naming the Git directory, which
 * names the repository's shared directory in its `commondir` file. Each
 * object directory's `info/alternates` lists more object directories it
 * reads.
 */
function resolveGitDirs(root: string): string[] {
  // Git strips only trailing CR and LF from these files; a path may end in
  // spaces.
  const readPathFile = (file: string, prefix = ""): string | undefined => {
    try {
      const content = fs.readFileSync(file, "utf8");
      if (!content.startsWith(prefix)) return undefined;
      return content.slice(prefix.length).replace(/[\r\n]+$/, "") || undefined;
    } catch {
      return undefined;
    }
  };
  const gitDirs: string[] = [];
  // Both the path Git uses, which may be a symlink, and its target.
  const protect = (file: string) => {
    const target = resolveRealPath(file);
    gitDirs.push(path.join(resolveRealPath(path.dirname(file)), path.basename(file)), target);
    return target;
  };
  // A Git directory or a gitfile naming one, and the repository's shared
  // directory.
  const addGitDir = (dir: string) => {
    protect(dir);
    const target = readPathFile(dir, "gitdir: ");
    const gitDir = target ? protect(path.resolve(path.dirname(dir), target)) : resolveRealPath(dir);
    const commonDir = readPathFile(path.join(gitDir, "commondir"));
    if (commonDir) protect(path.resolve(gitDir, commonDir));
  };
  // Relative to the working directory, as Git reads them.
  const env = process.env;
  if (env.GIT_DIR) addGitDir(path.resolve(env.GIT_DIR));
  const objectDirs = [
    env.GIT_OBJECT_DIRECTORY,
    ...splitGitPathList(env.GIT_ALTERNATE_OBJECT_DIRECTORIES ?? "", path.delimiter),
  ].flatMap((dir) => (dir ? [path.resolve(dir)] : []));
  for (const file of [env.GIT_COMMON_DIR, env.GIT_INDEX_FILE]) {
    if (file) protect(path.resolve(file));
  }

  let repoRoot: string | undefined = root;
  while (!fs.existsSync(path.join(repoRoot, ".git"))) {
    const parent = path.dirname(repoRoot);
    if (parent === repoRoot) {
      // Not in a repository.
      repoRoot = undefined;
      break;
    }
    repoRoot = parent;
  }
  if (repoRoot) addGitDir(path.join(repoRoot, ".git"));

  objectDirs.push(...gitDirs.map((dir) => path.join(dir, "objects")));
  // Git reads alternates of alternates; each line is a path relative to the
  // object directory whose file lists it.
  const seen = new Set<string>();
  for (let i = 0; i < objectDirs.length; i++) {
    const objectDir = protect(objectDirs[i]!);
    if (seen.has(objectDir)) continue;
    seen.add(objectDir);
    const alternates = readPathFile(path.join(objectDir, "info", "alternates"));
    for (const line of splitGitPathList(alternates?.replace(/\r/g, "") ?? "", "\n")) {
      if (!line.startsWith("#")) objectDirs.push(path.resolve(objectDir, line));
    }
  }
  return gitDirs;
}

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
  const gitDirs = resolveGitDirs(root);
  if (
    gitDirs.some(
      (gitDir) => isPathInsideOrEqual(gitDir, realOutDir) || isPathInside(realOutDir, gitDir),
    )
  ) {
    throw new Error(
      `[vinext] The ${label} "${shown(realOutDir)}" overlaps the project's Git directory. ` +
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
// their paths. A build writes only the ones it produces (no prerender files
// when it doesn't prerender), so any others are left from an earlier build.
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
