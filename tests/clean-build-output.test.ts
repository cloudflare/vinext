import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toSlash } from "pathslash";
import { cleanBuildOutput } from "../packages/vinext/src/build/clean-output.js";

let tmpDir: string;

function writeFile(root: string, relativePath: string, content: string): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
  return target;
}

describe("cleanBuildOutput", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-clean-output-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes stale server modules from the build output by default", () => {
    const staleModule = writeFile(
      tmpDir,
      "dist/server/ssr/_next/static/stale-dead-module.js",
      "export default 1;\n",
    );

    const result = cleanBuildOutput({ root: tmpDir });

    expect(result.cleaned).toBe(true);
    expect(result.outDir).toBe(toSlash(path.join(tmpDir, "dist")));
    expect(fs.existsSync(staleModule)).toBe(false);
  });

  it("preserves the build output when emptyOutDir is explicitly disabled", () => {
    const staleModule = writeFile(
      tmpDir,
      "dist/server/ssr/_next/static/stale-dead-module.js",
      "export default 1;\n",
    );

    const result = cleanBuildOutput({ root: tmpDir, emptyOutDir: false });

    expect(result.cleaned).toBe(false);
    expect(fs.existsSync(staleModule)).toBe(true);
  });

  it("does not empty an output directory outside the project root by default", () => {
    const externalOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-external-output-"));
    try {
      const staleModule = writeFile(externalOutDir, "stale-dead-module.js", "export default 1;\n");
      const prerenderFiles = [
        "server/vinext-prerender.json",
        "server/prerendered-routes/about.html",
        "server/vinext-prerender-paths.json",
        "server/RSC_BUILD_ID",
      ].map((file) => writeFile(externalOutDir, file, "stale\n"));

      const result = cleanBuildOutput({ root: tmpDir, outDir: externalOutDir });

      expect(result.cleaned).toBe(false);
      expect(fs.existsSync(staleModule)).toBe(true);
      // The server would seed its cache from the previous build's prerendered pages.
      for (const file of prerenderFiles) expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(externalOutDir, { recursive: true, force: true });
    }
  });

  it("never removes the project root or a directory containing it", () => {
    const source = writeFile(tmpDir, "app/page.tsx", "export default 1;\n");

    for (const options of [
      { root: tmpDir, outDir: "." },
      { root: tmpDir, outDir: tmpDir, emptyOutDir: true },
      { root: tmpDir, outDir: "..", emptyOutDir: true },
    ]) {
      expect(() => cleanBuildOutput(options)).toThrow("contains the project root");
    }
    expect(fs.existsSync(source)).toBe(true);
  });

  it("keeps a .git directory in the outDir, as Vite does", () => {
    const externalOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-external-output-"));
    try {
      const gitHead = writeFile(externalOutDir, ".git/HEAD", "ref: refs/heads/main\n");
      const staleModule = writeFile(externalOutDir, "server/stale.js", "export default 1;\n");

      const result = cleanBuildOutput({ root: tmpDir, outDir: externalOutDir, emptyOutDir: true });

      expect(result.cleaned).toBe(true);
      expect(fs.existsSync(staleModule)).toBe(false);
      expect(fs.readFileSync(gitHead, "utf-8")).toBe("ref: refs/heads/main\n");
    } finally {
      fs.rmSync(externalOutDir, { recursive: true, force: true });
    }
  });

  it("empties the directory a symlinked outDir points to, as Vite does", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-output-target-"));
    try {
      const stale = writeFile(target, "server/index.js", "stale\n");
      const history = writeFile(target, ".git/HEAD", "ref: refs/heads/main\n");
      fs.symlinkSync(target, path.join(tmpDir, "dist"));

      expect(cleanBuildOutput({ root: tmpDir }).cleaned).toBe(true);

      expect(fs.lstatSync(path.join(tmpDir, "dist")).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(history)).toBe(true);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("removes a symlinked outDir whose target no longer exists", () => {
    fs.symlinkSync(path.join(tmpDir, "missing"), path.join(tmpDir, "dist"));

    expect(cleanBuildOutput({ root: tmpDir }).cleaned).toBe(true);

    expect(fs.lstatSync(path.join(tmpDir, "dist"), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("refuses a symlinked outDir that points at the project's .git directory", () => {
    const head = writeFile(tmpDir, ".git/HEAD", "ref: refs/heads/main\n");
    fs.symlinkSync(path.join(tmpDir, ".git"), path.join(tmpDir, "dist"));

    expect(() => cleanBuildOutput({ root: tmpDir })).toThrow(
      'The build.outDir ".git" overlaps the project\'s Git directory',
    );
    expect(fs.existsSync(head)).toBe(true);
  });

  it("refuses a symlinked outDir that points at a worktree's Git directories", () => {
    // A worktree's .git file names its Git directory, whose commondir file
    // names the repository's.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-worktree-repo-"));
    try {
      const head = writeFile(repo, ".git/HEAD", "ref: refs/heads/main\n");
      writeFile(repo, ".git/worktrees/site/commondir", "../..\n");
      const worktreeGitDir = path.join(repo, ".git/worktrees/site");
      writeFile(tmpDir, ".git", `gitdir: ${worktreeGitDir}\n`);

      for (const target of [worktreeGitDir, path.join(repo, ".git")]) {
        fs.rmSync(path.join(tmpDir, "dist"), { force: true });
        fs.symlinkSync(target, path.join(tmpDir, "dist"));
        expect(() => cleanBuildOutput({ root: tmpDir })).toThrow(
          "overlaps the project's Git directory",
        );
      }
      fs.rmSync(path.join(tmpDir, "dist"), { force: true });
      // An outDir that contains the repository's Git directory.
      expect(() => cleanBuildOutput({ root: tmpDir, outDir: repo, emptyOutDir: true })).toThrow(
        "overlaps the project's Git directory",
      );
      expect(fs.existsSync(head)).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reads a gitfile path that ends in spaces, and a symlinked Git directory's commondir", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-gitfile-"));
    try {
      const head = writeFile(repo, "main.git/HEAD", "ref: refs/heads/main\n");
      writeFile(repo, "main.git/worktrees/site/commondir", "../..\n");
      // The worktree's Git directory is reached through a symlink, and its
      // path ends in a space.
      fs.symlinkSync(path.join(repo, "main.git/worktrees/site"), path.join(repo, "link "));
      writeFile(tmpDir, ".git", `gitdir: ${path.join(repo, "link ")}\n`);
      fs.symlinkSync(path.join(repo, "main.git"), path.join(tmpDir, "dist"));

      expect(() => cleanBuildOutput({ root: tmpDir })).toThrow(
        "overlaps the project's Git directory",
      );
      expect(fs.existsSync(head)).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each(["\n\n", "\r", "\r\n\r\n"])(
    "reads a gitfile path that ends in %j, as Git does",
    (lineEnd) => {
      const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-gitfile-ending-"));
      try {
        const head = writeFile(gitDir, "HEAD", "ref: refs/heads/main\n");
        writeFile(tmpDir, ".git", `gitdir: ${gitDir}${lineEnd}`);
        fs.symlinkSync(gitDir, path.join(tmpDir, "dist"));

        expect(() => cleanBuildOutput({ root: tmpDir })).toThrow(
          "overlaps the project's Git directory",
        );
        expect(fs.existsSync(head)).toBe(true);
      } finally {
        fs.rmSync(gitDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ])("refuses an outDir in the Git directory %s names", (name) => {
    const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-env-git-dir-"));
    const previous = process.env[name];
    try {
      const head = writeFile(gitDir, "HEAD", "ref: refs/heads/main\n");
      // Git uses the variable instead of finding a .git above the project.
      process.env[name] = gitDir;
      fs.symlinkSync(gitDir, path.join(tmpDir, "dist"));

      expect(() => cleanBuildOutput({ root: tmpDir })).toThrow(
        "overlaps the project's Git directory",
      );
      expect(fs.existsSync(head)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
      fs.rmSync(gitDir, { recursive: true, force: true });
    }
  });

  it("reads quoted entries in Git's alternate object path lists", () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-quoted-alternates-"));
    const previous = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    try {
      const fromEnv = path.join(store, `env${path.delimiter}objects`);
      const fromFile = path.join(store, "file\tobjects");
      writeFile(fromEnv, "pack/objects.pack", "PACK");
      const pack = writeFile(fromFile, "pack/objects.pack", "PACK");
      process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = `"${fromEnv}"`;
      writeFile(tmpDir, ".git/objects/info/alternates", `"${fromFile.replaceAll("\t", "\\t")}"\n`);

      for (const target of [fromEnv, fromFile]) {
        fs.rmSync(path.join(tmpDir, "dist"), { force: true });
        fs.symlinkSync(target, path.join(tmpDir, "dist"));
        expect(() => cleanBuildOutput({ root: tmpDir })).toThrow(
          "overlaps the project's Git directory",
        );
      }
      expect(fs.existsSync(pack)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
      else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = previous;
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it("refuses an outDir in the repository a symlinked root sits in", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-logical-repo-"));
    try {
      // The project's target is tmpDir, outside the repository its link is in.
      const head = writeFile(repo, ".git/HEAD", "ref: refs/heads/main\n");
      const root = path.join(repo, "site");
      fs.symlinkSync(tmpDir, root);

      expect(() =>
        cleanBuildOutput({ root, outDir: path.join(repo, ".git"), emptyOutDir: true }),
      ).toThrow("overlaps the project's Git directory");
      expect(fs.existsSync(head)).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reads a quoted alternate that starts with #, through the link it names", () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-hash-alternate-"));
    try {
      const pack = writeFile(store, "alternate/pack/objects.pack", "PACK");
      fs.mkdirSync(path.join(store, "inner"));
      // Git reads "#link/../alternate" as a path, and its .. leaves the
      // link's target: <store>/alternate.
      fs.mkdirSync(path.join(tmpDir, ".git/objects/info"), { recursive: true });
      fs.symlinkSync(path.join(store, "inner"), path.join(tmpDir, ".git/objects/#link"));
      writeFile(tmpDir, ".git/objects/info/alternates", '"#link/../alternate"\n');
      fs.symlinkSync(path.join(store, "alternate"), path.join(tmpDir, "dist"));

      expect(() => cleanBuildOutput({ root: tmpDir })).toThrow(
        "overlaps the project's Git directory",
      );
      expect(fs.existsSync(pack)).toBe(true);
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it("refuses an outDir that holds a symlink to a protected directory", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-linked-app-"));
    try {
      writeFile(target, "page.tsx", "export default function Page() {}\n");
      fs.mkdirSync(path.join(tmpDir, "src"));
      fs.symlinkSync(target, path.join(tmpDir, "src", "app"));

      expect(() =>
        cleanBuildOutput({ root: tmpDir, outDir: "src", protectedDirs: { app: "src/app" } }),
      ).toThrow('The build.outDir "src" overlaps the app directory');
      expect(fs.lstatSync(path.join(tmpDir, "src", "app")).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("refuses an outDir that holds a link inside the target of a protected directory's link", () => {
    const links = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-nested-link-"));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-nested-target-"));
    try {
      writeFile(target, "app/page.tsx", "export default function Page() {}\n");
      // src/app leads through <links>/inner, a second link, to <target>/app.
      fs.symlinkSync(target, path.join(links, "inner"));
      fs.mkdirSync(path.join(tmpDir, "src"));
      fs.symlinkSync(path.join(links, "inner", "app"), path.join(tmpDir, "src", "app"));
      fs.symlinkSync(links, path.join(tmpDir, "dist"));

      expect(() => cleanBuildOutput({ root: tmpDir, protectedDirs: { app: "src/app" } })).toThrow(
        "overlaps the app directory",
      );
      expect(fs.lstatSync(path.join(links, "inner")).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(links, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("refuses an outDir that holds a symlinked folder on the way to GIT_INDEX_FILE", () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-index-folder-"));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-index-target-"));
    const previous = process.env.GIT_INDEX_FILE;
    try {
      writeFile(target, "index", "DIRC");
      // Only the folder is a link, and its target is outside the outDir.
      const link = path.join(store, "linked");
      fs.symlinkSync(target, link);
      process.env.GIT_INDEX_FILE = path.join(link, "index");
      fs.symlinkSync(store, path.join(tmpDir, "dist"));

      expect(() => cleanBuildOutput({ root: tmpDir })).toThrow(
        "overlaps the project's Git directory",
      );
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previous;
      fs.rmSync(store, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("refuses an outDir that holds a symlinked GIT_INDEX_FILE", () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-index-link-"));
    const previous = process.env.GIT_INDEX_FILE;
    try {
      const index = writeFile(store, "real/index", "DIRC");
      const link = path.join(store, "links", "index");
      fs.mkdirSync(path.dirname(link));
      fs.symlinkSync(index, link);
      process.env.GIT_INDEX_FILE = link;
      fs.symlinkSync(path.dirname(link), path.join(tmpDir, "dist"));

      expect(() => cleanBuildOutput({ root: tmpDir })).toThrow(
        "overlaps the project's Git directory",
      );
      expect(fs.existsSync(link)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previous;
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it("refuses an outDir that holds the index GIT_INDEX_FILE names", () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-env-index-"));
    const previous = process.env.GIT_INDEX_FILE;
    try {
      const index = writeFile(store, "index", "DIRC");
      process.env.GIT_INDEX_FILE = index;
      fs.symlinkSync(store, path.join(tmpDir, "dist"));

      expect(() => cleanBuildOutput({ root: tmpDir })).toThrow(
        "overlaps the project's Git directory",
      );
      expect(fs.existsSync(index)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previous;
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it("refuses an outDir in an alternate object directory the repository reads", () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-alternates-"));
    try {
      // .git/objects lists a relative alternate, which lists another.
      writeFile(tmpDir, ".git/objects/info/alternates", `# shared\n${path.join(store, "first")}\n`);
      writeFile(store, "first/info/alternates", "../second\n");
      const pack = writeFile(store, "second/pack/objects.pack", "PACK");

      for (const target of ["first", "second"]) {
        fs.rmSync(path.join(tmpDir, "dist"), { force: true });
        fs.symlinkSync(path.join(store, target), path.join(tmpDir, "dist"));
        expect(() => cleanBuildOutput({ root: tmpDir })).toThrow(
          "overlaps the project's Git directory",
        );
      }
      expect(fs.existsSync(pack)).toBe(true);
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it("resolves an absolute GIT_DIR through the links it names", () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-env-git-link-"));
    const previous = process.env.GIT_DIR;
    try {
      // Git reads <store>/link/../meta as <store>/inner/meta: the .. leaves
      // the link's target, <store>/inner/deeper.
      const head = writeFile(store, "inner/meta/HEAD", "ref: refs/heads/main\n");
      fs.mkdirSync(path.join(store, "inner/deeper"));
      fs.symlinkSync(path.join(store, "inner/deeper"), path.join(store, "link"));
      process.env.GIT_DIR = `${store}/link/../meta`;
      fs.symlinkSync(path.join(store, "inner/meta"), path.join(tmpDir, "dist"));

      expect(() => cleanBuildOutput({ root: tmpDir })).toThrow(
        "overlaps the project's Git directory",
      );
      expect(fs.existsSync(head)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "reads a backslash in a POSIX Git path as part of its name",
    () => {
      const store = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-env-backslash-"));
      const previous = process.env.GIT_DIR;
      try {
        const head = writeFile(store, "meta\\repo.git/HEAD", "ref: refs/heads/main\n");
        process.env.GIT_DIR = path.join(store, "meta\\repo.git");
        fs.symlinkSync(path.join(store, "meta\\repo.git"), path.join(tmpDir, "dist"));

        expect(() => cleanBuildOutput({ root: tmpDir })).toThrow(
          "overlaps the project's Git directory",
        );
        expect(fs.existsSync(head)).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = previous;
        fs.rmSync(store, { recursive: true, force: true });
      }
    },
  );

  it("follows a GIT_DIR that names a gitfile", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-env-gitfile-"));
    const previous = process.env.GIT_DIR;
    try {
      const head = writeFile(repo, "meta/HEAD", "ref: refs/heads/main\n");
      writeFile(repo, "gitfile", "gitdir: meta\n");
      process.env.GIT_DIR = path.join(repo, "gitfile");
      fs.symlinkSync(path.join(repo, "meta"), path.join(tmpDir, "dist"));

      expect(() => cleanBuildOutput({ root: tmpDir })).toThrow(
        "overlaps the project's Git directory",
      );
      expect(fs.existsSync(head)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses an outDir in the Git directory of a repository the project is nested in", () => {
    const head = writeFile(tmpDir, ".git/HEAD", "ref: refs/heads/main\n");
    const root = path.join(tmpDir, "apps/site");
    fs.mkdirSync(root, { recursive: true });

    for (const outDir of ["../../.git", "../../.git/objects"]) {
      expect(() => cleanBuildOutput({ root, outDir, emptyOutDir: true })).toThrow(
        "overlaps the project's Git directory",
      );
    }
    expect(fs.existsSync(head)).toBe(true);
  });

  it("refuses an outDir in a bare repository's Git directories that holds the project", () => {
    writeFile(tmpDir, "HEAD", "ref: refs/heads/main\n");
    const object = writeFile(tmpDir, "objects/ab/cdef", "blob\n");
    fs.mkdirSync(path.join(tmpDir, "refs"));
    const root = path.join(tmpDir, "site");
    fs.mkdirSync(root);

    expect(() => cleanBuildOutput({ root, outDir: "../objects", emptyOutDir: true })).toThrow(
      "overlaps the project's Git directory",
    );
    expect(fs.existsSync(object)).toBe(true);
    expect(cleanBuildOutput({ root }).cleaned).toBe(true);
  });

  it("keeps searching above a folder that only looks like a bare repository", () => {
    const head = writeFile(tmpDir, ".git/HEAD", "ref: refs/heads/main\n");
    // container has HEAD, objects and refs, but its HEAD isn't a Git HEAD.
    writeFile(tmpDir, "container/HEAD", "not a ref\n");
    fs.mkdirSync(path.join(tmpDir, "container/objects"));
    fs.mkdirSync(path.join(tmpDir, "container/refs"));
    const root = path.join(tmpDir, "container/site");
    fs.mkdirSync(root);

    expect(() =>
      cleanBuildOutput({ root, outDir: path.join(tmpDir, ".git"), emptyOutDir: true }),
    ).toThrow("overlaps the project's Git directory");
    expect(fs.existsSync(head)).toBe(true);
  });

  it("refuses an outDir that holds a link on the way to GIT_OBJECT_DIRECTORY", () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-env-objects-link-"));
    const previous = process.env.GIT_OBJECT_DIRECTORY;
    try {
      writeFile(store, "external/pack/objects.pack", "PACK");
      const link = path.join(store, "holder", "active-objects");
      fs.mkdirSync(path.dirname(link));
      fs.symlinkSync(path.join(store, "external"), link);
      process.env.GIT_OBJECT_DIRECTORY = link;
      fs.symlinkSync(path.dirname(link), path.join(tmpDir, "dist"));

      expect(() => cleanBuildOutput({ root: tmpDir })).toThrow(
        "overlaps the project's Git directory",
      );
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
      else process.env.GIT_OBJECT_DIRECTORY = previous;
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it("follows the alternates of GIT_COMMON_DIR's object directory", () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-env-common-alternates-"));
    const previous = process.env.GIT_COMMON_DIR;
    try {
      writeFile(store, "common/objects/info/alternates", `${path.join(store, "alternate")}\n`);
      const pack = writeFile(store, "alternate/pack/objects.pack", "PACK");
      process.env.GIT_COMMON_DIR = path.join(store, "common");
      fs.symlinkSync(path.join(store, "alternate"), path.join(tmpDir, "dist"));

      expect(() => cleanBuildOutput({ root: tmpDir })).toThrow(
        "overlaps the project's Git directory",
      );
      expect(fs.existsSync(pack)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.GIT_COMMON_DIR;
      else process.env.GIT_COMMON_DIR = previous;
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it("refuses an outDir that is a file, such as a bare repository's HEAD", () => {
    const head = writeFile(tmpDir, "HEAD", "ref: refs/heads/main\n");
    fs.mkdirSync(path.join(tmpDir, "objects"));
    fs.mkdirSync(path.join(tmpDir, "refs"));
    const root = path.join(tmpDir, "site");
    fs.mkdirSync(root);

    expect(() => cleanBuildOutput({ root, outDir: "../HEAD", emptyOutDir: true })).toThrow(
      'The build.outDir "../HEAD" is a file, not a directory',
    );
    expect(fs.existsSync(head)).toBe(true);
  });

  it("refuses an outDir inside the project's .git directory", () => {
    const object = writeFile(tmpDir, ".git/objects/ab/cdef", "blob\n");

    expect(() => cleanBuildOutput({ root: tmpDir, outDir: ".git/objects" })).toThrow(
      'The build.outDir ".git/objects" overlaps the project\'s Git directory',
    );
    expect(fs.existsSync(object)).toBe(true);
  });

  it("refuses a symlinked server directory in an outDir that isn't emptied", () => {
    const buildId = writeFile(tmpDir, "app/RSC_BUILD_ID", "not build output\n");
    fs.mkdirSync(path.join(tmpDir, "dist"));
    fs.symlinkSync(path.join(tmpDir, "app"), path.join(tmpDir, "dist", "server"));

    expect(() =>
      cleanBuildOutput({
        root: tmpDir,
        emptyOutDir: false,
        protectedDirs: { app: path.join(tmpDir, "app") },
      }),
    ).toThrow('The server output directory "app" overlaps the app directory "app"');
    expect(fs.existsSync(buildId)).toBe(true);
  });

  it("refuses a symlinked outDir that points into a protected source directory", () => {
    const page = writeFile(tmpDir, "src/app/page.tsx", "export default 1;\n");
    fs.symlinkSync(path.join(tmpDir, "src/app"), path.join(tmpDir, "dist"));

    expect(() =>
      cleanBuildOutput({ root: tmpDir, protectedDirs: { app: path.join(tmpDir, "src/app") } }),
    ).toThrow('The build.outDir "src/app" overlaps the app directory "src/app"');
    expect(fs.existsSync(page)).toBe(true);
  });

  it("refuses an outDir that is, contains or sits inside a protected source directory", () => {
    const page = writeFile(tmpDir, "src/app/page.tsx", "export default 1;\n");
    const image = writeFile(tmpDir, "public/logo.svg", "<svg/>");
    const protectedDirs = {
      app: path.join(tmpDir, "src/app"),
      pages: path.join(tmpDir, "src/pages"),
      public: path.join(tmpDir, "public"),
    };

    for (const [outDir, message] of [
      ["src/app", 'The build.outDir "src/app" overlaps the app directory "src/app"'],
      ["src", 'The build.outDir "src" overlaps the app directory "src/app"'],
      ["public/build", 'The build.outDir "public/build" overlaps the public directory "public"'],
      ["src/pages", 'The build.outDir "src/pages" overlaps the pages directory "src/pages"'],
    ] as const) {
      expect(() => cleanBuildOutput({ root: tmpDir, outDir, protectedDirs })).toThrow(message);
    }
    expect(fs.existsSync(page)).toBe(true);
    expect(fs.existsSync(image)).toBe(true);
  });

  it("compares the outDir with the project after resolving symlinks", () => {
    // `alias` points at the directory holding the project, so an outDir
    // written through it holds the project although its path doesn't.
    const realBase = fs.realpathSync(tmpDir);
    const root = path.join(realBase, "workspace", "project");
    const source = writeFile(root, "app/page.tsx", "export default 1;\n");
    fs.symlinkSync(realBase, path.join(realBase, "alias"));
    const aliasedParent = path.join(realBase, "alias", "workspace");

    expect(() => cleanBuildOutput({ root, outDir: aliasedParent, emptyOutDir: true })).toThrow(
      'The build.outDir ".." contains the project root',
    );
    expect(() =>
      cleanBuildOutput({
        root,
        outDir: path.join(aliasedParent, "project", "app"),
        emptyOutDir: true,
        protectedDirs: { app: path.join(root, "app") },
      }),
    ).toThrow('The build.outDir "app" overlaps the app directory "app"');
    expect(fs.existsSync(source)).toBe(true);
  });
});
