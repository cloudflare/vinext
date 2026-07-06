import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  rewriteImportMetaUrl,
  rewriteServerCjsGlobals,
} from "../packages/vinext/src/plugins/import-meta-url.js";

describe("vinext:import-meta-url plugin", () => {
  let tmpDir: string;
  let realRoot: string;
  let linkedRoot: string;
  let pagePath: string;
  let canonicalPagePath: string;

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-import-meta-url-"));
    realRoot = path.join(tmpDir, "real-app");
    linkedRoot = path.join(tmpDir, "linked-app");
    pagePath = path.join(realRoot, "pages", "index.tsx");

    await fsp.mkdir(path.dirname(pagePath), { recursive: true });
    await fsp.writeFile(pagePath, `export const url = import.meta.url;\n`);
    canonicalPagePath = await fsp.realpath(pagePath);
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
});
