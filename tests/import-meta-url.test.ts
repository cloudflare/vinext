import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createImportMetaUrlPlugin,
  rewriteBuildChunkCjsGlobals,
  rewriteBundledDependencyCjsGlobals,
  rewriteImportMetaUrl,
  rewriteServerCjsGlobals,
} from "../packages/vinext/src/plugins/import-meta-url.js";
import { toSlash } from "pathslash";

function unwrapHook(hook: any): Function {
  return typeof hook === "function" ? hook : hook?.handler;
}

describe("vinext:import-meta-url plugin", () => {
  let tmpDir: string;
  let realRoot: string;
  let linkedRoot: string;
  let pagePath: string;
  let canonicalPagePath: string;
  let cjsDependencyPath: string;
  let esmDependencyPath: string;
  let unpackagedDependencyPath: string;

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-import-meta-url-"));
    realRoot = path.join(tmpDir, "real-app");
    linkedRoot = path.join(tmpDir, "linked-app");
    pagePath = path.join(realRoot, "pages", "index.tsx");

    await fsp.mkdir(path.dirname(pagePath), { recursive: true });
    await fsp.writeFile(pagePath, `export const url = import.meta.url;\n`);
    const cjsDependencyDir = path.join(realRoot, "node_modules", "cjs-source-identity");
    const esmDependencyDir = path.join(realRoot, "node_modules", "esm-source-identity");
    cjsDependencyPath = path.join(cjsDependencyDir, "index.js");
    esmDependencyPath = path.join(esmDependencyDir, "index.js");
    const typeModuleAppDir = path.join(tmpDir, "type-module-app");
    unpackagedDependencyPath = path.join(
      typeModuleAppDir,
      "node_modules",
      "unpackaged-dependency",
      "index.js",
    );
    await Promise.all([
      fsp.mkdir(cjsDependencyDir, { recursive: true }),
      fsp.mkdir(esmDependencyDir, { recursive: true }),
      fsp.mkdir(path.dirname(unpackagedDependencyPath), { recursive: true }),
    ]);
    await Promise.all([
      fsp.writeFile(path.join(cjsDependencyDir, "package.json"), '{"type":"commonjs"}\n'),
      fsp.writeFile(path.join(esmDependencyDir, "package.json"), '{"type":"module"}\n'),
      fsp.writeFile(cjsDependencyPath, "exports.paths = [__filename, __dirname];\n"),
      fsp.writeFile(esmDependencyPath, "export const path = __dirname;\n"),
      fsp.writeFile(path.join(typeModuleAppDir, "package.json"), '{"type":"module"}\n'),
      fsp.writeFile(unpackagedDependencyPath, "exports.path = __dirname;\n"),
    ]);
    // The plugin emits canonical forward-slash paths, so expectations are
    // built from the slash form (path.dirname preserves separators on win32).
    canonicalPagePath = toSlash(await fsp.realpath(pagePath));
    await fsp.symlink(realRoot, linkedRoot, "junction");
  });

  afterAll(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("normalizes client import.meta.url to a Turbopack-style /ROOT source URL", () => {
    const result = rewriteImportMetaUrl(
      `export const url = import.meta.url;\n`,
      pagePath,
      linkedRoot,
      "client",
    );

    expect(result?.code).toContain(`"file:///ROOT/pages/index.tsx"`);
  });

  it("preserves the real server source file URL", () => {
    const result = rewriteImportMetaUrl(
      `export const url = import.meta.url;\n`,
      pagePath,
      linkedRoot,
      "server",
    );

    expect(result?.code).toMatch(/"file:\/\/\/.*\/pages\/index\.tsx"/);
    expect(result?.code).not.toContain("linked-app");
  });

  it("does not rewrite the import.meta.url base argument in new URL asset expressions", () => {
    const result = rewriteImportMetaUrl(
      `const asset = new URL("./font.ttf", import.meta.url);\nconst url = import.meta.url;\n`,
      pagePath,
      linkedRoot,
      "client",
    );

    expect(result?.code).toContain(`new URL("./font.ttf", import.meta.url)`);
    expect(result?.code).toContain(`const url = "file:///ROOT/pages/index.tsx"`);
  });

  it("preserves import.meta?.url as the base argument in new URL asset expressions", () => {
    const result = rewriteImportMetaUrl(
      `const asset = new URL("./font.ttf", import.meta?.url);\nconst url = import.meta?.url;\n`,
      pagePath,
      linkedRoot,
      "client",
    );

    expect(result?.code).toContain(`new URL("./font.ttf", import.meta?.url)`);
    expect(result?.code).toContain(`const url = "file:///ROOT/pages/index.tsx"`);
  });

  it("rewrites optional chained import.meta.url reads", () => {
    const result = rewriteImportMetaUrl(
      `export const url = import.meta?.url;\n`,
      pagePath,
      linkedRoot,
      "client",
    );

    expect(result?.code).toContain(`"file:///ROOT/pages/index.tsx"`);
  });

  it("injects server __filename and __dirname derived from the source URL", () => {
    // Ported from Next.js:
    // test/e2e/app-dir/proxy-nfc-traced/proxy-nfc-traced.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/proxy-nfc-traced/proxy-nfc-traced.test.ts
    const result = rewriteServerCjsGlobals(
      `console.log(__filename, __dirname);\n`,
      pagePath,
      linkedRoot,
    );

    expect(result?.code).toContain(`var __filename = ${JSON.stringify(canonicalPagePath)};`);
    expect(result?.code).toContain(
      `var __dirname = ${JSON.stringify(path.dirname(canonicalPagePath))};`,
    );
    expect(result?.code).not.toContain("linked-app");
    expect(result?.code).toContain(`console.log(__filename, __dirname);`);
  });

  it("injects source paths for a CommonJS dependency optimizer input", async () => {
    const canonicalDependencyPath = toSlash(await fsp.realpath(cjsDependencyPath));
    const result = rewriteBundledDependencyCjsGlobals(
      `"use strict";\nexports.paths = [__filename, __dirname];\n`,
      `${cjsDependencyPath}?v=test`,
    );

    expect(result?.code).toContain(`"use strict";\nvar __filename`);
    expect(result?.code).toContain(`var __filename = ${JSON.stringify(canonicalDependencyPath)};`);
    expect(result?.code).toContain(
      `var __dirname = ${JSON.stringify(toSlash(path.dirname(canonicalDependencyPath)))};`,
    );
  });

  it("defaults an unpackaged node_modules dependency to CommonJS", async () => {
    const canonicalDependencyPath = toSlash(await fsp.realpath(unpackagedDependencyPath));
    const result = rewriteBundledDependencyCjsGlobals(
      `exports.path = __dirname;\n`,
      unpackagedDependencyPath,
    );

    expect(result?.code).toContain(
      `var __dirname = ${JSON.stringify(toSlash(path.dirname(canonicalDependencyPath)))};`,
    );
  });

  it("does not inject CommonJS globals into a dependency declared as ESM", () => {
    const result = rewriteBundledDependencyCjsGlobals(
      `export const paths = [__filename, __dirname];\n`,
      esmDependencyPath,
    );

    expect(result).toBeNull();
  });

  it("does not inject dependency globals mentioned only in comments and strings", () => {
    const result = rewriteBundledDependencyCjsGlobals(
      `// __filename\nexports.note = "__dirname";\n`,
      cjsDependencyPath,
    );

    expect(result).toBeNull();
  });

  it("defines free CommonJS globals relative to an emitted ESM chunk", () => {
    const result = rewriteBuildChunkCjsGlobals(
      `"use strict";\nconst value = await Promise.resolve(__dirname + __filename);\n`,
    );

    expect(result?.code).toContain(
      `"use strict";\nvar __filename = import.meta.filename;var __dirname = import.meta.dirname;`,
    );
  });

  it("does not redefine CommonJS globals already bound by an emitted chunk", () => {
    const result = rewriteBuildChunkCjsGlobals(
      `const __dirname = import.meta.dirname;\nawait Promise.resolve(__dirname);\n`,
    );

    expect(result).toBeNull();
  });

  it("uses one Vite capability plus a filtered optimizer adapter", () => {
    const { vitePlugin, optimizeDepsPlugin } = createImportMetaUrlPlugin({
      getRoot: () => realRoot,
    });
    const viteFilter = (
      vitePlugin.transform as {
        filter: { id: { include: RegExp; exclude: RegExp }; code: RegExp };
      }
    ).filter;
    const optimizerFilter = (
      optimizeDepsPlugin.transform as { filter: { id: RegExp; code: RegExp } }
    ).filter;

    expect(vitePlugin.name).toBe("vinext:import-meta-url");
    expect(optimizeDepsPlugin.name).toBe("vinext:import-meta-url:optimize-deps");
    expect(viteFilter.id.include.test(pagePath)).toBe(true);
    expect(viteFilter.id.include.test(cjsDependencyPath)).toBe(true);
    expect(viteFilter.id.exclude.test("\0virtual:fixture.ts")).toBe(true);
    expect(viteFilter.code.test("export const value = 1")).toBe(false);
    expect(viteFilter.code.test("export const value = __dirname")).toBe(true);
    expect(optimizerFilter.id.test(pagePath)).toBe(false);
    expect(optimizerFilter.id.test(cjsDependencyPath)).toBe(true);
    expect(optimizerFilter.code.test("exports.value = 1")).toBe(false);
  });

  it("keeps unaffected modules on the pre-parse fast path", () => {
    let rootReads = 0;
    const { vitePlugin } = createImportMetaUrlPlugin({
      getRoot: () => {
        rootReads += 1;
        return realRoot;
      },
    });
    const transform = unwrapHook(vitePlugin.transform);

    expect(
      transform.call(
        { environment: { mode: "dev", config: { consumer: "server" } } },
        "this is not valid javascript",
        cjsDependencyPath,
      ),
    ).toBeNull();
    expect(rootReads).toBe(0);
  });

  it("caches dependency package-format reads within the capability", () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const readFileSync = vi.spyOn(fs, "readFileSync");
    try {
      const before = readFileSync.mock.calls.length;

      expect(capability.isBundledCommonJsDependencyId(cjsDependencyPath)).toBe(true);
      const afterFirst = readFileSync.mock.calls.length;
      expect(capability.isBundledCommonJsDependencyId(`${cjsDependencyPath}?v=second`)).toBe(true);

      expect(afterFirst - before).toBe(1);
      expect(readFileSync.mock.calls.length).toBe(afterFirst);
    } finally {
      readFileSync.mockRestore();
    }
  });

  it("invalidates dependency format identity after a watched symlink retarget", async () => {
    const versionA = path.join(realRoot, "node_modules/dependency-version-a");
    const versionB = path.join(realRoot, "node_modules/dependency-version-b");
    const current = path.join(realRoot, "node_modules/current-dependency");
    const currentEntry = path.join(current, "index.js");
    await Promise.all([
      fsp.mkdir(versionA, { recursive: true }),
      fsp.mkdir(versionB, { recursive: true }),
    ]);
    await Promise.all([
      fsp.writeFile(path.join(versionA, "package.json"), '{"type":"commonjs"}\n'),
      fsp.writeFile(path.join(versionA, "index.js"), "exports.path = __dirname;\n"),
      fsp.writeFile(path.join(versionB, "package.json"), '{"type":"module"}\n'),
      fsp.writeFile(path.join(versionB, "index.js"), "export const path = __dirname;\n"),
    ]);
    await fsp.symlink(versionA, current, "junction");

    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    expect(capability.isBundledCommonJsDependencyId(currentEntry)).toBe(true);

    await fsp.unlink(current);
    await fsp.symlink(versionB, current, "junction");
    unwrapHook(capability.vitePlugin.watchChange).call({}, currentEntry, { event: "update" });

    expect(capability.isBundledCommonJsDependencyId(currentEntry)).toBe(false);
  });

  it("uses runtime-specific dependency globals only in server development", () => {
    const nodeCapability = createImportMetaUrlPlugin({
      getRoot: () => realRoot,
      getServerRuntime: () => "node",
    });
    const nodeTransform = unwrapHook(nodeCapability.vitePlugin.transform);
    const source = "exports.path = __dirname;";

    expect(
      nodeTransform.call(
        { environment: { mode: "dev", config: { consumer: "server" } } },
        source,
        cjsDependencyPath,
      )?.code,
    ).toContain("var __dirname =");
    expect(
      nodeTransform.call(
        { environment: { mode: "dev", config: { consumer: "client" } } },
        source,
        cjsDependencyPath,
      ),
    ).toBeNull();
    expect(
      nodeTransform.call(
        { environment: { mode: "build", config: { consumer: "server" } } },
        source,
        cjsDependencyPath,
      ),
    ).toBeNull();

    const workerCapability = createImportMetaUrlPlugin({
      getRoot: () => realRoot,
      getServerRuntime: () => "worker",
    });
    expect(
      unwrapHook(workerCapability.vitePlugin.transform).call(
        { environment: { mode: "dev", config: { consumer: "server" } } },
        source,
        cjsDependencyPath,
      )?.code,
    ).toContain('var __dirname = "/";');

    expect(rewriteBuildChunkCjsGlobals(source, "worker")?.code).toContain('var __dirname = "/";');
    expect(rewriteBuildChunkCjsGlobals("exports.path = __filename;", "worker")?.code).toContain(
      'var __filename = "/index.js";',
    );
  });

  it("does not inject when __filename or __dirname are declared at top level", () => {
    const result = rewriteServerCjsGlobals(
      [
        `const __filename = "local-file";`,
        `function __dirname() {`,
        `  return __dirname;`,
        `}`,
        `function read(__dirname) {`,
        `  return [__filename, __dirname];`,
        `}`,
      ].join("\n"),
      pagePath,
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("does not inject when exported declarations shadow the globals", () => {
    const result = rewriteServerCjsGlobals(
      [
        `console.log(__filename, __dirname);`,
        `export const __filename = "local-file";`,
        `export function __dirname() {`,
        `  return __dirname;`,
        `}`,
      ].join("\n"),
      pagePath,
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("does not inject names shadowed by top-level declarations, but injects unshadowed names", () => {
    const result = rewriteServerCjsGlobals(
      [
        `const file = __filename, __filename = "local-file";`,
        `for (let dir = __dirname, __dirname = "local-dir"; false;) {`,
        `  console.log(dir);`,
        `}`,
      ].join("\n"),
      pagePath,
      linkedRoot,
    );

    // __filename has a top-level const declaration, so it is not injected.
    // __dirname has no top-level declaration (the for-loop let is nested),
    // so it is injected and correctly shadowed by the nested let.
    expect(result).not.toBeNull();
    expect(result?.code).not.toContain(`var __filename = ${JSON.stringify(canonicalPagePath)};`);
    expect(result?.code).toContain(
      `var __dirname = ${JSON.stringify(path.dirname(canonicalPagePath))};`,
    );
  });

  it.each([
    [
      "an if statement",
      [`if (flag) {`, `  var __filename = "local-file";`, `}`, `console.log(__filename);`].join(
        "\n",
      ),
    ],
    [
      "a block statement",
      [`{`, `  var __dirname = "local-dir";`, `}`, `console.log(__dirname);`].join("\n"),
    ],
    [
      "a switch statement",
      [
        `switch (value) {`,
        `  case 1:`,
        `    var __filename = "local-file";`,
        `    break;`,
        `}`,
        `console.log(__filename);`,
      ].join("\n"),
    ],
    [
      "a try/finally statement",
      [`try {`, `  var __dirname = "local-dir";`, `} finally {}`, `console.log(__dirname);`].join(
        "\n",
      ),
    ],
    [
      "a labelled statement",
      [`label: var __filename = "local-file";`, `console.log(__filename);`].join("\n"),
    ],
    [
      "a loop body",
      [
        `for (const item of items) {`,
        `  var __dirname = "local-dir";`,
        `}`,
        `console.log(__dirname);`,
      ].join("\n"),
    ],
  ])("does not inject when %s contains a module-scoped var", (_caseName, source) => {
    const result = rewriteServerCjsGlobals(source, pagePath, linkedRoot);

    expect(result).toBeNull();
  });

  it("injects when the only var declarations live inside functions", () => {
    const result = rewriteServerCjsGlobals(
      [
        `function readFile() {`,
        `  var __filename = "local-file";`,
        `  return __filename;`,
        `}`,
        `function readDir() {`,
        `  var __dirname = "local-dir";`,
        `  return __dirname;`,
        `}`,
        `console.log(__filename, __dirname);`,
      ].join("\n"),
      pagePath,
      linkedRoot,
    );

    expect(result).not.toBeNull();
    expect(result?.code).toContain(`var __filename = ${JSON.stringify(canonicalPagePath)};`);
    expect(result?.code).toContain(
      `var __dirname = ${JSON.stringify(path.dirname(canonicalPagePath))};`,
    );
    expect(result?.code).toContain(`console.log(__filename, __dirname);`);
  });

  it("injects when only top-level assignment/update expressions reference the globals", () => {
    // With binding injection, top-level assignment or update expressions are
    // fine — they mutate the injected variable. We only skip injection when
    // there is an actual declaration that would conflict.
    const result = rewriteServerCjsGlobals(
      [`__filename = "local-file";`, `__dirname++;`].join("\n"),
      pagePath,
      linkedRoot,
    );

    expect(result).not.toBeNull();
    expect(result?.code).toContain(`var __filename = ${JSON.stringify(canonicalPagePath)};`);
    expect(result?.code).toContain(
      `var __dirname = ${JSON.stringify(path.dirname(canonicalPagePath))};`,
    );
    expect(result?.code).toContain(`__filename = "local-file";`);
    expect(result?.code).toContain(`__dirname++;`);
  });

  it("does not inject when class expression names shadow at top level", () => {
    const result = rewriteServerCjsGlobals(
      [
        `const FileClass = class __filename {`,
        `  method() {`,
        `    return __filename;`,
        `  }`,
        `};`,
        `const DirClass = class __dirname {`,
        `  field = __dirname;`,
        `};`,
      ].join("\n"),
      pagePath,
      linkedRoot,
    );

    // class expressions are not top-level declarations, so injection happens
    expect(result).not.toBeNull();
    expect(result?.code).toContain(`var __filename = ${JSON.stringify(canonicalPagePath)};`);
    expect(result?.code).toContain(
      `var __dirname = ${JSON.stringify(path.dirname(canonicalPagePath))};`,
    );
    // Inside the class body, `__filename` refers to the class name binding,
    // which shadows the injected var. This is correct JS semantics.
    expect(result?.code).toContain(`return __filename;`);
    expect(result?.code).toContain(`field = __dirname;`);
  });

  it("injects for pattern defaults and computed keys (free reads use injected var)", () => {
    const result = rewriteServerCjsGlobals(
      [
        `const { file = __filename, [__dirname]: dir } = source;`,
        `function read(value = __filename, { dir = __dirname } = {}) {`,
        `  return [file, dir, value];`,
        `}`,
        `try {`,
        `  read();`,
        `} catch ({ file = __filename }) {`,
        `  read(file);`,
        `}`,
      ].join("\n"),
      pagePath,
      linkedRoot,
    );

    expect(result).not.toBeNull();
    expect(result?.code).toContain(`var __filename = ${JSON.stringify(canonicalPagePath)};`);
    expect(result?.code).toContain(
      `var __dirname = ${JSON.stringify(path.dirname(canonicalPagePath))};`,
    );
    // Original references preserved
    expect(result?.code).toContain(`file = __filename`);
    expect(result?.code).toContain(`[__dirname]: dir`);
    expect(result?.code).toContain(`value = __filename`);
    expect(result?.code).toContain(`dir = __dirname`);
    expect(result?.code).toContain(`catch ({ file = __filename })`);
  });

  it("injects object shorthand server CJS globals without changing property names", () => {
    const result = rewriteServerCjsGlobals(
      `export const paths = { __filename, __dirname };\n`,
      pagePath,
      linkedRoot,
    );

    // With binding injection, `{ __filename, __dirname }` naturally expands to
    // `{ __filename: <injected-value>, __dirname: <injected-value> }`
    expect(result?.code).toContain(`var __filename = ${JSON.stringify(canonicalPagePath)};`);
    expect(result?.code).toContain(
      `var __dirname = ${JSON.stringify(path.dirname(canonicalPagePath))};`,
    );
    expect(result?.code).toContain(`{ __filename, __dirname }`);
  });

  it("does not inject when value imports shadow the globals", () => {
    const result = rewriteServerCjsGlobals(
      [`import { __filename } from "./types";`, `console.log(__filename);`].join("\n"),
      pagePath,
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("injects after TypeScript type-only constructs are erased", () => {
    // In production, Vite transforms strip TypeScript before this plugin
    // (enforce: "post") sees the code.  Both `import type` and `type` aliases
    // are erased, so the plugin sees plain JS like this:
    const result = rewriteServerCjsGlobals(`console.log(__filename);`, pagePath, linkedRoot);

    expect(result).not.toBeNull();
    expect(result?.code).toContain(`var __filename = ${JSON.stringify(canonicalPagePath)};`);
  });

  it("does not inject when destructuring declarations shadow the globals", () => {
    const result = rewriteServerCjsGlobals(
      [`const { __filename } = source;`, `console.log(__filename);`].join("\n"),
      pagePath,
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("does not inject when nested destructuring patterns shadow the globals", () => {
    const result = rewriteServerCjsGlobals(
      [
        `const { file: __filename } = source;`,
        `const [__dirname] = parts;`,
        `const { nested: { __dirname } } = source;`,
      ].join("\n"),
      pagePath,
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("does not inject when top-level for (var ...) declarations shadow the globals", () => {
    const result = rewriteServerCjsGlobals(
      [`for (var __filename = "local"; false;) {}`, `console.log(__filename);`].join("\n"),
      pagePath,
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("does not inject when top-level for-in (var ...) declarations shadow the globals", () => {
    const result = rewriteServerCjsGlobals(
      [`for (var __dirname in obj) {}`, `console.log(__dirname);`].join("\n"),
      pagePath,
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("does not inject when top-level for-of (var ...) declarations shadow the globals", () => {
    const result = rewriteServerCjsGlobals(
      [`for (var __filename of list) {}`, `console.log(__filename);`].join("\n"),
      pagePath,
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("inserts bindings after directive prologue so use server remains a directive", () => {
    const result = rewriteServerCjsGlobals(
      `"use server";\nconsole.log(__filename);\n`,
      pagePath,
      linkedRoot,
    );

    expect(result).not.toBeNull();
    // Injection lands immediately after the directive, so "use server" stays a
    // directive prologue entry.
    expect(result?.code).toMatch(/^"use server";\nvar __filename/);
  });

  it("inserts bindings after directive prologue so use strict remains a directive", () => {
    const result = rewriteServerCjsGlobals(
      `"use strict";\nconsole.log(__dirname);\n`,
      pagePath,
      linkedRoot,
    );

    expect(result).not.toBeNull();
    expect(result?.code).toMatch(/^"use strict";\nvar __dirname/);
  });

  it("injects after a shebang so the #! line stays first", () => {
    const result = rewriteServerCjsGlobals(
      `#!/usr/bin/env node\nconsole.log(__filename);\n`,
      pagePath,
      linkedRoot,
    );

    expect(result).not.toBeNull();
    // The shebang must remain the first bytes of the file; the injected var
    // goes after it, not at offset 0 (which would corrupt the shebang).
    expect(result?.code).toMatch(/^#!\/usr\/bin\/env node\nvar __filename/);
  });

  it("does not inject for an export-namespace alias (export * as __filename)", () => {
    const result = rewriteServerCjsGlobals(
      `export * as __filename from "./mod.js";\n`,
      pagePath,
      linkedRoot,
    );

    // The exported name is not a value read of __filename.
    expect(result).toBeNull();
  });

  it("does not inject for an export-specifier alias (export { foo as __filename })", () => {
    const result = rewriteServerCjsGlobals(
      [`const foo = 1;`, `export { foo as __filename };`].join("\n"),
      pagePath,
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("does not inject for an import-specifier alias (import { __filename as foo })", () => {
    const result = rewriteServerCjsGlobals(
      [`import { __filename as foo } from "./x.js";`, `console.log(foo);`].join("\n"),
      pagePath,
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("does not inject server CJS globals in build output paths", () => {
    const result = rewriteServerCjsGlobals(
      `console.log(__filename);\n`,
      path.join(realRoot, "dist", "server", "index.js"),
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("does not inject for node_modules modules", () => {
    const result = rewriteServerCjsGlobals(
      `console.log(__filename);\n`,
      path.join(realRoot, "node_modules", "pkg", "index.js"),
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("does not inject for non-script extensions", () => {
    const result = rewriteServerCjsGlobals(
      `console.log(__filename);\n`,
      path.join(realRoot, "pages", "data.json"),
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("does not inject for non-computed member access (obj.__filename is not a read)", () => {
    const result = rewriteServerCjsGlobals(
      `obj.__filename;\nobj.__dirname;\n`,
      pagePath,
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("does not inject for lookalike identifiers (__filenameFoo)", () => {
    const result = rewriteServerCjsGlobals(
      [`const __filenameFoo = 1;`, `console.log(__filenameFoo);`].join("\n"),
      pagePath,
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("does not inject for non-computed object literal keys", () => {
    const result = rewriteServerCjsGlobals(
      `const meta = { __filename: 1, __dirname: 2 };\n`,
      pagePath,
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("does not inject for non-computed class member names", () => {
    const result = rewriteServerCjsGlobals(
      `class C {\n  __filename() {}\n  __dirname = 1;\n}\n`,
      pagePath,
      linkedRoot,
    );

    expect(result).toBeNull();
  });

  it("injects for computed member reads (obj[__filename])", () => {
    const result = rewriteServerCjsGlobals(`console.log(obj[__filename]);\n`, pagePath, linkedRoot);

    expect(result?.code).toContain(`var __filename = ${JSON.stringify(canonicalPagePath)};`);
  });

  it("injects a name with a real read even when the other only appears as a member", () => {
    const result = rewriteServerCjsGlobals(
      `obj.__filename;\nconsole.log(__dirname);\n`,
      pagePath,
      linkedRoot,
    );

    // __dirname is read freely → injected; __filename only appears as a member
    // property → not injected.
    expect(result?.code).toContain(
      `var __dirname = ${JSON.stringify(path.dirname(canonicalPagePath))};`,
    );
    expect(result?.code).not.toContain(`var __filename =`);
  });

  it("reuses the cached plugin transform result per environment kind", () => {
    const { vitePlugin: plugin } = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const configResolved = unwrapHook(plugin.configResolved).bind(plugin);
    configResolved({ root: realRoot, build: { outDir: "dist" } });
    const transform = unwrapHook(plugin.transform);
    const source = `export const url = import.meta.url;\n`;
    const serverContext = { environment: { name: "rsc" } };
    const clientContext = { environment: { name: "client" } };

    const serverResult = transform.call(serverContext, source, pagePath);
    expect(serverResult).toBeTruthy();
    expect(transform.call(serverContext, source, pagePath)).toBe(serverResult);
    // The SSR environment maps to the same "server" replacement, so it shares
    // the server entry rather than recomputing.
    expect(transform.call({ environment: { name: "ssr" } }, source, pagePath)).toBe(serverResult);

    const clientResult = transform.call(clientContext, source, pagePath);
    expect(clientResult).not.toBe(serverResult);
    expect(clientResult?.code).toContain(`"file:///ROOT/pages/index.tsx"`);
    expect(transform.call(clientContext, source, pagePath)).toBe(clientResult);

    expect(transform.call(serverContext, `${source}console.log("changed");\n`, pagePath)).not.toBe(
      serverResult,
    );
  });

  it("invalidates cached server identities when a junction target changes", async () => {
    const versionA = path.join(realRoot, "version-a");
    const versionB = path.join(realRoot, "version-b");
    const versionAPage = path.join(versionA, "page.tsx");
    const versionBPage = path.join(versionB, "page.tsx");
    const current = path.join(realRoot, "current");
    const currentPage = path.join(current, "page.tsx");
    const source = `export const identity = [import.meta.url, __filename, __dirname];\n`;

    await Promise.all([
      fsp.mkdir(versionA, { recursive: true }),
      fsp.mkdir(versionB, { recursive: true }),
    ]);
    await Promise.all([fsp.writeFile(versionAPage, source), fsp.writeFile(versionBPage, source)]);
    const [canonicalVersionAPage, canonicalVersionBPage] = await Promise.all([
      fsp.realpath(versionAPage).then(toSlash),
      fsp.realpath(versionBPage).then(toSlash),
    ]);
    await fsp.symlink(versionA, current, "junction");

    const { vitePlugin: plugin } = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const configResolved = unwrapHook(plugin.configResolved).bind(plugin);
    configResolved({ root: realRoot, build: { outDir: "dist" } });
    const transform = unwrapHook(plugin.transform);
    const serverContext = { environment: { name: "rsc" } };

    const firstResult = transform.call(serverContext, source, currentPage);
    expect(firstResult?.code).toContain(canonicalVersionAPage);

    await fsp.unlink(current);
    await fsp.symlink(versionB, current, "junction");

    const secondResult = transform.call(serverContext, source, currentPage);
    expect(secondResult?.code).toContain(canonicalVersionBPage);
    expect(secondResult?.code).not.toContain(canonicalVersionAPage);
  });
});
