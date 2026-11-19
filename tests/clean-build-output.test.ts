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
      'The build.outDir ".git" is inside the project\'s .git directory',
    );
    expect(fs.existsSync(head)).toBe(true);
  });

  it("refuses an outDir inside the project's .git directory", () => {
    const object = writeFile(tmpDir, ".git/objects/ab/cdef", "blob\n");

    expect(() => cleanBuildOutput({ root: tmpDir, outDir: ".git/objects" })).toThrow(
      'The build.outDir ".git/objects" is inside the project\'s .git directory',
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
