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

// Path separators: a backslash is a filename character on POSIX.
const PATH_SEPARATORS = process.platform === "win32" ? /[\\/]+/ : /\/+/;
// Symlinks followed on one path before giving up, as Linux does.
const MAX_SYMLINKS = 40;

/**
 * Where `file`, taken relative to `base`, leads through the filesystem, as Git
 * and the OS resolve it: the location of each symlink on the way, each in a
 * real directory, and the real path it ends at. A `..` leaves the directory
 * reached so far, so after a symlink it leaves the link's target, not the
 * link. Emptying any of these paths, or a directory holding one, removes
 * `file` or a link on its way.
 */
function walkPath(file: string, base?: string): { links: string[]; real: string } {
  const links: string[] = [];
  let current = base === undefined ? resolveRealPath(process.cwd()) : walkPath(base).real;
  let parts: string[] = [];
  const enter = (next: string) => {
    const root = path.parse(next).root;
    if (root) {
      // A drive-relative path like C:repo starts at that drive's working
      // directory.
      current = resolveRealPath(/[\\/]$/.test(root) ? root : path.resolve(root));
    }
    parts = [...next.slice(root.length).split(PATH_SEPARATORS), ...parts];
  };
  enter(file);
  let followed = 0;
  while (parts.length) {
    const part = parts.shift()!;
    if (!part || part === ".") continue;
    if (part === "..") {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, part);
    let target: string | undefined;
    try {
      if (fs.lstatSync(next).isSymbolicLink()) target = fs.readlinkSync(next);
    } catch {
      // Missing, so nothing after it exists either.
    }
    if (target === undefined || followed++ >= MAX_SYMLINKS) {
      current = next;
      continue;
    }
    // A relative target is relative to the link's directory, `current`.
    links.push(next);
    enter(target);
  }
  return { links, real: resolveRealPath(current) };
}

/** Every path that reaches `file`: as given, each link on its way, and its target. */
function pathForms(file: string): string[] {
  const { links, real } = walkPath(path.resolve(file));
  return [...new Set([path.resolve(file), ...links, real])];
}

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

// The entries in a Git directory, after gitrepository-layout(5), and Git LFS's
// object store. Any of them may be a symlink to storage elsewhere.
const GIT_DIR_ENTRIES = [
  "HEAD",
  "config",
  "config.worktree",
  "packed-refs",
  "index",
  "shallow",
  "commondir",
  "objects",
  "refs",
  "reftable",
  "logs",
  "hooks",
  "info",
  "branches",
  "remotes",
  "modules",
  "worktrees",
  "rr-cache",
  "lfs",
];

/**
 * The common directory of `dir`, each link on its way and resolved, if `dir`
 * is a Git directory, as Git checks one. The common directory is GIT_COMMON_DIR when set, else the one `dir`'s
 * `commondir` file names, else `dir`. It must hold the object directory
 * (GIT_OBJECT_DIRECTORY when set) and a `refs` folder, and `dir`'s HEAD must
 * name a ref or hold an object ID.
 */
function findGitCommonDir(dir: string): { links: string[]; real: string } | undefined {
  try {
    let commonDir = walkPath(dir);
    if (process.env.GIT_COMMON_DIR) {
      commonDir = walkPath(process.env.GIT_COMMON_DIR);
    } else if (fs.existsSync(path.join(dir, "commondir"))) {
      const named = fs.readFileSync(path.join(dir, "commondir"), "utf8").replace(/[\r\n]+$/, "");
      commonDir = walkPath(named, dir);
    }
    const objectDir = process.env.GIT_OBJECT_DIRECTORY
      ? walkPath(process.env.GIT_OBJECT_DIRECTORY).real
      : path.join(commonDir.real, "objects");
    for (const entry of [objectDir, path.join(commonDir.real, "refs")]) {
      if (!fs.statSync(entry).isDirectory()) return undefined;
    }
    const head = path.join(dir, "HEAD");
    const validHead = fs.lstatSync(head).isSymbolicLink()
      ? fs.readlinkSync(head).startsWith("refs/")
      : /^(?:ref:\s*refs\/|[0-9a-f]{64}|[0-9a-f]{40})/i.test(fs.readFileSync(head, "utf8"));
    return validHead ? commonDir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The project's Git storage, as given, each link on the way and resolved: the
 * `.git` in the project root and every one above it, any bare repository
 * holding the project, and any directory or index that Git's environment
 * variables name. In a worktree or submodule `.git` (or
 * GIT_DIR) is a gitfile naming the Git directory, which names the
 * repository's shared directory in its `commondir` file. Each object
 * directory's `info/alternates` lists more object directories it reads.
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
  // Repositories whose object directories Git reads.
  const repoDirs: string[] = [];
  // `file`, relative to `base` as Git reads it: each link on its way and its
  // target.
  const protect = (file: string, base?: string) => {
    const { links, real } = walkPath(file, base);
    gitDirs.push(...links, real);
    return real;
  };
  const rootForms = pathForms(root);
  // A repository's Git directory, or only its Git entries (apart from any the
  // project is in) when the project sits inside it. Each entry is protected
  // as a path too, so a symlinked one keeps its target.
  const protectRepository = (dir: string) => {
    if (!rootForms.some((rootForm) => isPathInsideOrEqual(dir, rootForm))) protect(dir);
    // A split index keeps its shared part in sharedindex.<hash>.
    let sharedIndexes: string[] = [];
    try {
      sharedIndexes = fs.readdirSync(dir).filter((entry) => entry.startsWith("sharedindex."));
    } catch {
      // Not a directory yet.
    }
    for (const entry of [...GIT_DIR_ENTRIES, ...sharedIndexes]) {
      const file = path.join(dir, entry);
      if (!rootForms.some((rootForm) => isPathInsideOrEqual(file, rootForm))) protect(file);
    }
  };
  // A Git directory or a gitfile naming one, and the repository's shared
  // directory.
  const addGitDir = (dir: string) => {
    let gitDir = protect(dir);
    // A gitfile's path is relative to the directory it was named in.
    const target = readPathFile(gitDir, "gitdir: ");
    if (target) gitDir = protect(target, path.dirname(dir));
    repoDirs.push(gitDir);
    protectRepository(gitDir);
    const commonDir = readPathFile(path.join(gitDir, "commondir"));
    if (commonDir) {
      const common = protect(commonDir, gitDir);
      repoDirs.push(common);
      protectRepository(common);
    }
  };
  // Relative to the working directory, as Git reads them.
  const env = process.env;
  if (env.GIT_DIR) addGitDir(env.GIT_DIR);
  if (env.GIT_COMMON_DIR) {
    const { links, real } = walkPath(env.GIT_COMMON_DIR);
    gitDirs.push(...links);
    repoDirs.push(real);
    protectRepository(real);
  }
  if (env.GIT_INDEX_FILE) protect(env.GIT_INDEX_FILE);
  // Each object directory and the directory its path is relative to.
  const objectDirs: Array<{ dir: string; base?: string }> = [
    env.GIT_OBJECT_DIRECTORY,
    ...splitGitPathList(env.GIT_ALTERNATE_OBJECT_DIRECTORIES ?? "", path.delimiter),
  ].flatMap((dir) => (dir ? [{ dir }] : []));

  // A symlinked root (kept with resolve.preserveSymlinks) may sit in another
  // repository than its target, so search from every form of it. Git uses the
  // nearest repository, but emptying any one above the project destroys it,
  // so every one is protected.
  for (const form of rootForms) {
    for (let dir = form; ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, ".git"))) addGitDir(path.join(dir, ".git"));
      const commonDir = findGitCommonDir(dir);
      if (commonDir !== undefined) {
        // A bare repository holds the project: protect it and the common
        // directory it keeps its refs and objects in.
        const gitDir = walkPath(dir).real;
        repoDirs.push(gitDir, commonDir.real);
        gitDirs.push(...commonDir.links);
        protectRepository(dir);
        if (commonDir.real !== gitDir) protectRepository(commonDir.real);
      }
      if (path.dirname(dir) === dir) break;
    }
  }

  objectDirs.push(...repoDirs.map((dir) => ({ dir: path.join(dir, "objects") })));
  // Git reads alternates of alternates; each line is a path relative to the
  // object directory whose file lists it.
  const seen = new Set<string>();
  for (let i = 0; i < objectDirs.length; i++) {
    const objectDir = protect(objectDirs[i]!.dir, objectDirs[i]!.base);
    if (seen.has(objectDir)) continue;
    seen.add(objectDir);
    const alternates = readPathFile(path.join(objectDir, "info", "alternates"));
    // Git skips a comment line before unquoting it.
    for (const line of alternates?.split(/\r?\n/) ?? []) {
      if (!line || line.startsWith("#")) continue;
      const [entry] = splitGitPathList(line, "\n");
      if (entry) objectDirs.push({ dir: entry, base: objectDir });
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
 * with it: it may not be a file, contain the project root or overlap its Git
 * storage, nor contain or sit inside one of `protectedDirs` (the app, pages and public
 * directories). `outDir` is compared after resolving symlinks, as it is
 * emptied, and each protected path in every form that reaches it, so neither
 * an alias of the project nor a link on the way to it can be emptied.
 */
export function assertOutputDirIsSafe(
  label: string,
  outDir: string,
  options: { root: string; protectedDirs?: ProtectedSourceDirs },
): void {
  const root = resolveRealPath(options.root);
  const realOutDir = resolveRealPath(path.resolve(options.root, outDir));
  const shown = (dir: string) => toSlash(path.relative(root, dir)) || ".";
  // An outDir must be a directory, or not exist yet: emptying a file removes
  // it, whether it's the project's or Git's (a bare repository's HEAD).
  if (fs.statSync(realOutDir, { throwIfNoEntry: false })?.isDirectory() === false) {
    throw new Error(
      `[vinext] The ${label} "${shown(realOutDir)}" is a file, not a directory. Building ` +
        "there would delete it. Choose a build.outDir that is a directory or doesn't exist " +
        "yet, such as the default dist.",
    );
  }
  if (pathForms(options.root).some((form) => isPathInsideOrEqual(realOutDir, form))) {
    throw new Error(
      `[vinext] The ${label} "${shown(realOutDir)}" contains the project root. Building there ` +
        "would delete the project. Choose a build.outDir below or outside the project, such " +
        "as the default dist.",
    );
  }
  const gitDirs = resolveGitDirs(options.root);
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
    const overlaps = pathForms(path.resolve(options.root, dir)).some(
      (form) => isPathInsideOrEqual(realOutDir, form) || isPathInsideOrEqual(form, realOutDir),
    );
    if (overlaps) {
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
