import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { build, parseAst } from "vite";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createImportMetaUrlPlugin,
  rewriteImportMetaUrl,
  rewriteServerCjsGlobals,
} from "../packages/vinext/src/plugins/import-meta-url.js";
import { toSlash } from "pathslash";

function unwrapHook(hook: any): Function {
  return typeof hook === "function" ? hook : hook?.handler;
}

function expectSourceCjsGlobal(
  code: string | undefined,
  name: "__filename" | "__dirname",
  id: string,
): void {
  const filename = toSlash(fs.realpathSync(id));
  const value = name === "__filename" ? filename : path.posix.dirname(filename);
  expect(code).toContain(`var ${name} = ${JSON.stringify(value)};`);
}

function expectBundledCjsGlobal(code: string | undefined, name: "__filename" | "__dirname"): void {
  const marker = name === "__filename" ? "FILENAME" : "DIRNAME";
  expect(code).toMatch(
    new RegExp(
      `var ${name} = \\(\\{ get value\\(\\) \\{ return "__VINEXT_EMITTED_MODULE_${marker}_[a-f0-9]{32}__"; \\} \\}\\)\\.value;`,
    ),
  );
}

function expectBundledImportMetaUrl(code: string | undefined): void {
  expect(code).toMatch(
    /\(\{ get value\(\) \{ return "__VINEXT_EMITTED_MODULE_URL_[a-f0-9]{32}__"; \} \}\)\.value/,
  );
}

function expectFinalizedImportMetaUrl(code: string | undefined, fileName = "entry.js"): void {
  const urlNamespaceBinding = code?.match(
    /(?:^|\n)import \* as (__vinext_module_url_*) from "node:url";/,
  )?.[1];
  expect(urlNamespaceBinding).toBeDefined();
  const identityBinding = code?.match(
    /(?:^|\n)const (__vinext_module_identity_*) = \(\(\) => \{/,
  )?.[1];
  expect(identityBinding).toBeDefined();
  expect(code).toContain(
    `const value = fileURLToPath(({ get value() { return ${identityBinding}.url; } }).value);`,
  );
  expect(code).toContain("const runtimeUrl = import.meta.url;");
  expect(code).toContain("const runtimeFilename = import.meta.filename;");
  expect(code).toContain(
    `runtimeUrl.startsWith("file:") ? runtimeUrl : ${urlNamespaceBinding}.pathToFileURL(`,
  );
  expect(code).not.toContain('from "node:process"');
  expect(code).toContain(JSON.stringify(`/${fileName}`));
  expect(code).not.toMatch(/__VINEXT_EMITTED_MODULE_URL_[a-f0-9]{32}__/);
}

function expectFinalizedCjsGlobal(
  code: string | undefined,
  name: "__filename" | "__dirname",
  fileName = "entry.js",
): void {
  const processNamespaceBinding = code?.match(
    /(?:^|\n)import \* as (__vinext_module_process_*) from "node:process";/,
  )?.[1];
  expect(processNamespaceBinding).toBeDefined();
  const fsNamespaceBinding = code?.match(
    /(?:^|\n)import \* as (__vinext_module_fs_*) from "node:fs";/,
  )?.[1];
  expect(fsNamespaceBinding).toBeDefined();
  const identityBinding = code?.match(
    /(?:^|\n)const (__vinext_module_identity_*) = \(\(\) => \{/,
  )?.[1];
  expect(identityBinding).toBeDefined();
  const field = name === "__filename" ? "filename" : "dirname";
  const dirname = path.posix.dirname(fileName);
  expect(code).toContain(
    `var ${name} = ({ get value() { return ${identityBinding}.${field}; } }).value;`,
  );
  expect(code).toContain(`${processNamespaceBinding}.cwd()`);
  expect(code).toContain(`${fsNamespaceBinding}.existsSync(filename)`);
  if (name === "__filename") {
    expect(code).toContain(JSON.stringify(`/${fileName}`));
  } else if (dirname !== ".") {
    expect(code).toContain(JSON.stringify(`/${dirname}`));
  }
  expect(code).not.toMatch(/__VINEXT_EMITTED_MODULE_(?:FILE|DIR)NAME_[a-f0-9]{32}__/);
}

function transformOptimizedDependency(code: string, id: string) {
  const capability = createImportMetaUrlPlugin({ getRoot: () => path.dirname(id) });
  return unwrapHook(capability.optimizeDepsPlugin.transform).call({}, code, id);
}

describe("vinext:import-meta-url plugin", () => {
  let tmpDir: string;
  let realRoot: string;
  let linkedRoot: string;
  let pagePath: string;
  let localCjsPath: string;
  let cjsDependencyPath: string;
  let linkedCjsDependencyPath: string;
  let typedCjsDependencyPath: string;
  let esmDependencyPath: string;
  let unpackagedDependencyPath: string;

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-import-meta-url-"));
    realRoot = path.join(tmpDir, "real-app");
    linkedRoot = path.join(tmpDir, "linked-app");
    pagePath = path.join(realRoot, "pages", "index.tsx");
    localCjsPath = path.join(realRoot, "lib", "identity.cjs");

    await Promise.all([
      fsp.mkdir(path.dirname(pagePath), { recursive: true }),
      fsp.mkdir(path.dirname(localCjsPath), { recursive: true }),
    ]);
    await Promise.all([
      fsp.writeFile(pagePath, `export const url = import.meta.url;\n`),
      fsp.writeFile(localCjsPath, `exports.paths = [__filename, __dirname];\n`),
    ]);
    const cjsDependencyDir = path.join(realRoot, "node_modules", "cjs-source-identity");
    const linkedCjsDependencyDir = path.join(tmpDir, "workspace", "linked-cjs-source-identity");
    const typedCjsDependencyDir = path.join(realRoot, "node_modules", "typed-cjs-source-identity");
    const esmDependencyDir = path.join(realRoot, "node_modules", "esm-source-identity");
    cjsDependencyPath = path.join(cjsDependencyDir, "index.js");
    linkedCjsDependencyPath = path.join(linkedCjsDependencyDir, "index.js");
    typedCjsDependencyPath = path.join(typedCjsDependencyDir, "index.cts");
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
      fsp.mkdir(linkedCjsDependencyDir, { recursive: true }),
      fsp.mkdir(typedCjsDependencyDir, { recursive: true }),
      fsp.mkdir(esmDependencyDir, { recursive: true }),
      fsp.mkdir(path.dirname(unpackagedDependencyPath), { recursive: true }),
    ]);
    await Promise.all([
      fsp.writeFile(path.join(cjsDependencyDir, "package.json"), '{"type":"commonjs"}\n'),
      fsp.writeFile(
        path.join(linkedCjsDependencyDir, "package.json"),
        '{"name":"linked-cjs-source-identity","type":"commonjs"}\n',
      ),
      fsp.writeFile(path.join(typedCjsDependencyDir, "package.json"), '{"type":"commonjs"}\n'),
      fsp.writeFile(path.join(esmDependencyDir, "package.json"), '{"type":"module"}\n'),
      fsp.writeFile(cjsDependencyPath, "exports.paths = [__filename, __dirname];\n"),
      fsp.writeFile(linkedCjsDependencyPath, "exports.path = __dirname;\n"),
      fsp.writeFile(typedCjsDependencyPath, "const path: string = __dirname;\nexport = path;\n"),
      fsp.writeFile(esmDependencyPath, "export const path = __dirname;\n"),
      fsp.writeFile(path.join(typeModuleAppDir, "package.json"), '{"type":"module"}\n'),
      fsp.writeFile(unpackagedDependencyPath, "exports.path = __dirname;\n"),
    ]);
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

  it("preserves Vite's coerced import.meta.url base for emitted worker URLs", () => {
    // Regression: https://github.com/cloudflare/vinext/issues/2600
    const result = rewriteImportMetaUrl(
      'new Worker(new URL(/* @vite-ignore */ "/_next/static/echo.worker.js", "" + import.meta.url));',
      pagePath,
      linkedRoot,
      "client",
    );

    expect(result).toBeNull();
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

  it("injects portable server __filename and __dirname initializers", () => {
    const result = rewriteServerCjsGlobals(
      `console.log(__filename, __dirname);\n`,
      pagePath,
      linkedRoot,
    );

    expectSourceCjsGlobal(result?.code, "__filename", pagePath);
    expectSourceCjsGlobal(result?.code, "__dirname", pagePath);
    expect(result?.code).not.toContain("import.meta");
    expect(result?.code).toContain(`console.log(__filename, __dirname);`);
  });

  it("injects emitted-module fallbacks for a CommonJS dependency optimizer input", () => {
    const result = transformOptimizedDependency(
      `"use strict";\nexports.paths = [__filename, __dirname];\n`,
      `${cjsDependencyPath}?v=test`,
    );

    expect(result?.code).toContain(`"use strict";\nvar __filename`);
    expectBundledCjsGlobal(result?.code, "__filename");
    expectBundledCjsGlobal(result?.code, "__dirname");
    expect(result?.code).not.toContain(cjsDependencyPath);
  });

  it("classifies realpathed workspace CommonJS packages outside the app root", async () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transform = unwrapHook(capability.vitePlugin.transform);
    const source = "exports.path = __dirname;\n";

    expect(capability.isBundledCommonJsDependencyId(linkedCjsDependencyPath)).toBe(true);
    const devResult = transform.call(
      { environment: { mode: "dev", config: { consumer: "server" } } },
      source,
      linkedCjsDependencyPath,
    );
    expect(devResult?.code).toContain(
      `var __dirname = ${JSON.stringify(toSlash(path.dirname(await fsp.realpath(linkedCjsDependencyPath))))};`,
    );
    const buildResult = transform.call(
      { environment: { mode: "build", config: { consumer: "server" } } },
      source,
      linkedCjsDependencyPath,
    );
    expectBundledCjsGlobal(buildResult?.code, "__dirname");
  });

  it("parses typed CommonJS optimizer inputs using their source language", () => {
    const result = transformOptimizedDependency(
      "const path: string = __dirname;\nexport = path;\n",
      typedCjsDependencyPath,
    );

    expectBundledCjsGlobal(result?.code, "__dirname");
  });

  it.each(["const", "var"])(
    "does not treat an ambient declare %s as a runtime CommonJS binding",
    (kind) => {
      const result = transformOptimizedDependency(
        `declare ${kind} __dirname: string;\nexport = __dirname;\n`,
        typedCjsDependencyPath,
      );

      expectBundledCjsGlobal(result?.code, "__dirname");
    },
  );

  it("defaults an unpackaged node_modules dependency to CommonJS", () => {
    const result = transformOptimizedDependency(
      `exports.path = __dirname;\n`,
      unpackagedDependencyPath,
    );

    expectBundledCjsGlobal(result?.code, "__dirname");
  });

  it("does not inject CommonJS globals into a dependency declared as ESM", () => {
    const result = transformOptimizedDependency(
      `export const paths = [__filename, __dirname];\n`,
      esmDependencyPath,
    );

    expect(result).toBeNull();
  });

  it("marks optimized ESM dependency import.meta.url reads for emitted identity", () => {
    const result = transformOptimizedDependency(
      `import { fileURLToPath } from "node:url";\nconst value = fileURLToPath(import.meta.url);\nexport { value };\n`,
      esmDependencyPath,
    );

    expectBundledImportMetaUrl(result?.code);
    expect(result?.code).not.toContain(esmDependencyPath);
  });

  it("marks ESM dependency URL reads separated by comments", () => {
    const result = transformOptimizedDependency(
      [
        'import { createRequire } from "node:module";',
        'import { fileURLToPath } from "node:url";',
        "const filename = fileURLToPath(import.meta /* annotated */ .url);",
        "const require = createRequire(import.meta. /* annotated */ url);",
        "export { filename, require };",
      ].join("\n"),
      esmDependencyPath,
    );

    expect(result?.code.match(/__VINEXT_EMITTED_MODULE_URL_/g)).toHaveLength(2);
    expect(result?.code).not.toContain("import.meta /* annotated */ .url");
    expect(result?.code).not.toContain("import.meta. /* annotated */ url");
  });

  it("marks escaped URL reads with trivia across the full ImportMeta expression", () => {
    const source = [
      'import { createRequire } from "node:module";',
      'import { fileURLToPath } from "node:url";',
      "const filename = fileURLToPath(import /* annotated */ . meta . u\\u0072l);",
      "const require = createRequire(import . meta. \\u0075\\u0072\\u006c);",
      "const carriageReturn = import.meta// annotated\r.url;",
      "const lineSeparator = import.meta// annotated\u2028.url;",
      "export { carriageReturn, filename, lineSeparator, require };",
    ].join("\n");
    const optimized = transformOptimizedDependency(source, esmDependencyPath);
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const built = unwrapHook(capability.vitePlugin.transform).call(
      { environment: { mode: "build", config: { consumer: "server" } } },
      source,
      esmDependencyPath,
    );

    for (const result of [optimized, built]) {
      expect(result?.code.match(/__VINEXT_EMITTED_MODULE_URL_/g)).toHaveLength(4);
      expect(result?.code).not.toContain("import /* annotated */ . meta");
      expect(result?.code).not.toContain("import . meta");
    }
  });

  it("uses source identity for unbundled ESM dependencies and emitted identity for builds", () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transform = unwrapHook(capability.vitePlugin.transform);
    const source = [
      'import { createRequire } from "node:module";',
      'import { fileURLToPath } from "node:url";',
      "export const require = createRequire(import.meta.url);",
      "export const filename = fileURLToPath(import.meta.url);",
    ].join("\n");

    const devResult = transform.call(
      { environment: { mode: "dev", config: { consumer: "server" } } },
      source,
      esmDependencyPath,
    );
    expect(devResult?.code).toContain(pathToFileURL(fs.realpathSync(esmDependencyPath)).href);
    expect(devResult?.code).not.toContain("__VINEXT_EMITTED_MODULE_URL_");

    const buildResult = transform.call(
      { environment: { mode: "build", config: { consumer: "server" } } },
      source,
      esmDependencyPath,
    );
    expectBundledImportMetaUrl(buildResult?.code);

    const clientResult = transform.call(
      { environment: { mode: "build", config: { consumer: "client" } } },
      source,
      esmDependencyPath,
    );
    expect(clientResult).toBeNull();
  });

  it("finalizes optimized ESM dependency URLs relative to the emitted chunk", () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transformed = unwrapHook(capability.optimizeDepsPlugin.transform).call(
      {},
      `import { fileURLToPath } from "node:url";\nconst value = fileURLToPath(import.meta.url);\nexport { value };\n`,
      esmDependencyPath,
    );
    const emitted = unwrapHook(capability.optimizeDepsPlugin.renderChunk).call(
      {},
      transformed?.code ?? "",
      { fileName: "deps/esm-identity.js" },
      { format: "es" },
    );

    expectFinalizedImportMetaUrl(emitted?.code, "deps/esm-identity.js");
    expect(emitted?.code).not.toContain('from "node:fs"');
    expect(emitted?.code).not.toContain("existsSync");
  });

  it("evaluates a URL-only emitted module without cwd when its runtime URL is non-file", async () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transformed = unwrapHook(capability.optimizeDepsPlugin.transform).call(
      {},
      [
        'import { fileURLToPath } from "node:url";',
        "const filename = fileURLToPath(import.meta.url);",
        "export default { fetch() { return new Response(filename); } };",
      ].join("\n"),
      esmDependencyPath,
    );
    const emitted = unwrapHook(capability.optimizeDepsPlugin.renderChunk).call(
      {},
      transformed?.code ?? "",
      { fileName: "worker.mjs" },
      { format: "es" },
    );
    const code = emitted?.code ?? "";
    const processImport = code.match(/import \* as (\w+) from "node:process";/);
    // Workerd exposes the node:process module but not process.cwd(), and its
    // module-registry URL is not guaranteed to use the file: scheme.
    const workerdLikeCode = code
      .replace(processImport?.[0] ?? "", processImport ? `const ${processImport[1]} = {};` : "")
      .replace("const runtimeUrl = import.meta.url;", 'const runtimeUrl = "worker";');
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(workerdLikeCode).toString("base64")}`
    );
    const response = await module.default.fetch();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("/worker.mjs");
  });

  it("evaluates emitted CJS paths without import.meta.filename or cwd", async () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transformed = unwrapHook(capability.optimizeDepsPlugin.transform).call(
      {},
      "export const paths = [__filename, __dirname];",
      cjsDependencyPath,
    );
    const emitted = unwrapHook(capability.optimizeDepsPlugin.renderChunk).call(
      {},
      transformed?.code ?? "",
      { fileName: "chunks/worker.mjs" },
      { format: "es" },
    );
    const code = emitted?.code ?? "";
    const processImport = code.match(/import \* as (\w+) from "node:process";/);
    expect(processImport).not.toBeNull();
    const workerdLikeCode = code
      .replace(processImport![0], `const ${processImport![1]} = {};`)
      .replace("const filename = import.meta.filename;", "const filename = undefined;");
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(workerdLikeCode).toString("base64")}`
    );
    expect(module.paths).toEqual(["/chunks/worker.mjs", "/chunks"]);
  });

  it("preserves dependency new URL asset bases while rewriting direct identity reads", () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transform = unwrapHook(capability.vitePlugin.transform);
    const result = transform.call(
      { environment: { mode: "build", config: { consumer: "server" } } },
      `export const asset = new URL("./asset.bin", import.meta.url);\nexport const identity = import.meta.url;\n`,
      esmDependencyPath,
    );

    expect(result?.code).toContain('new URL("./asset.bin", import.meta.url)');
    expectBundledImportMetaUrl(result?.code);
  });

  it("does not inject dependency globals mentioned only in comments and strings", () => {
    const result = transformOptimizedDependency(
      `// __filename\nexports.note = "__dirname";\n`,
      cjsDependencyPath,
    );

    expect(result).toBeNull();
  });

  it("defines free CommonJS globals from portable emitted-module identity", () => {
    const result = rewriteServerCjsGlobals(
      `"use strict";\nconst value = await Promise.resolve(__dirname + __filename);\n`,
      pagePath,
      linkedRoot,
    );

    expectSourceCjsGlobal(result?.code, "__filename", pagePath);
    expectSourceCjsGlobal(result?.code, "__dirname", pagePath);
    expect(result?.code).not.toContain("process.cwd");
    expect(result?.code).not.toContain("__VINEXT_EMITTED_MODULE_");
  });

  it("does not rewrite marker-like user globals while finalizing optimized CJS", () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transformed = unwrapHook(capability.optimizeDepsPlugin.transform).call(
      {},
      [
        "exports.dirname = __dirname;",
        "exports.userValue = globalThis.__VINEXT_EMITTED_MODULE_FILENAME__;",
      ].join("\n"),
      cjsDependencyPath,
    );
    const result = unwrapHook(capability.optimizeDepsPlugin.renderChunk).call(
      {},
      transformed?.code ?? "",
      { fileName: "entry.js" },
      { format: "es" },
    );

    expect(result?.code).toContain(
      "exports.userValue = globalThis.__VINEXT_EMITTED_MODULE_FILENAME__;",
    );
    expectFinalizedCjsGlobal(result?.code, "__dirname");
  });

  it("finalizes an isolated marker without absorbing an adjacent string concat", () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transformed = unwrapHook(capability.optimizeDepsPlugin.transform).call(
      {},
      'exports.path = __dirname + "/foo";',
      cjsDependencyPath,
    );
    const emitted = unwrapHook(capability.optimizeDepsPlugin.renderChunk).call(
      {},
      transformed?.code ?? "",
      { fileName: "entry.js" },
      { format: "es" },
    );

    expectFinalizedCjsGlobal(emitted?.code, "__dirname");
    expect(emitted?.code).toContain('__dirname + "/foo"');
  });

  it("removes private marker randomness from emitted output", () => {
    const source = "exports.dirname = __dirname;";
    const firstCapability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const secondCapability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const first = unwrapHook(firstCapability.optimizeDepsPlugin.transform).call(
      {},
      source,
      cjsDependencyPath,
    );
    const second = unwrapHook(secondCapability.optimizeDepsPlugin.transform).call(
      {},
      source,
      cjsDependencyPath,
    );
    expect(first?.code).not.toBe(second?.code);

    const firstEmitted = unwrapHook(firstCapability.optimizeDepsPlugin.renderChunk).call(
      {},
      first?.code ?? "",
      { fileName: "entry.js" },
      { format: "es" },
    );
    const secondEmitted = unwrapHook(secondCapability.optimizeDepsPlugin.renderChunk).call(
      {},
      second?.code ?? "",
      { fileName: "entry.js" },
      { format: "es" },
    );
    expectFinalizedCjsGlobal(firstEmitted?.code, "__dirname");
    expectFinalizedCjsGlobal(secondEmitted?.code, "__dirname");
    expect(firstEmitted?.code).toBe(secondEmitted?.code);
  });

  it("finalizes private markers after a bundler renames their bindings", () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transformed = unwrapHook(capability.optimizeDepsPlugin.transform).call(
      {},
      "exports.dirname = __dirname;",
      cjsDependencyPath,
    );
    const renamed = transformed?.code
      .replace("var __dirname =", "var e =")
      .replace("exports.dirname = __dirname", "exports.dirname = e");
    const emitted = unwrapHook(capability.optimizeDepsPlugin.renderChunk).call(
      {},
      renamed ?? "",
      { fileName: "entry.js" },
      { format: "es" },
    );

    expect(emitted?.code).toContain(
      "var e = ({ get value() { return __vinext_module_identity.dirname; } }).value;",
    );
    expect(emitted?.code).toContain("__vinext_module_process.cwd()");
    expect(emitted?.code).not.toMatch(/__VINEXT_EMITTED_MODULE_DIRNAME_[a-f0-9]{32}__/);
  });

  it("finalizes private markers when CommonJS source shadows process and globalThis", () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transformed = unwrapHook(capability.optimizeDepsPlugin.transform).call(
      {},
      [
        'const process = { cwd() { throw new Error("captured process") } };',
        "const globalThis = {};",
        "const __vinext_module_process = {};",
        "exports.dirname = __dirname;",
        "exports.locals = [process, globalThis, __vinext_module_process];",
      ].join("\n"),
      cjsDependencyPath,
    );
    const emitted = unwrapHook(capability.optimizeDepsPlugin.renderChunk).call(
      {},
      transformed?.code ?? "",
      { fileName: "entry.js" },
      { format: "es" },
    );

    expectFinalizedCjsGlobal(emitted?.code, "__dirname");
    expect(emitted?.code).toContain('import * as __vinext_module_process_ from "node:process";');
    expect(emitted?.code).toContain("const process = {");
    expect(emitted?.code).toContain("const globalThis = {};");
    expect(emitted?.code).not.toContain("globalThis.process");
    expect(emitted?.code).not.toMatch(/__VINEXT_EMITTED_MODULE_DIRNAME_[a-f0-9]{32}__/);
  });

  it("selects a collision-free process binding with one emitted-code scan", () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transformed = unwrapHook(capability.optimizeDepsPlugin.transform).call(
      {},
      `const __vinext_module_process = 0;
const __vinext_module_process_ = 1;
const __vinext_module_fs = 2;
const __vinext_module_url = 3;
const __vinext_module_identity = 4;
const __vinext_module_process_${"_".repeat(4_096)} = 5;
exports.dirname = __dirname;`,
      cjsDependencyPath,
    );
    const emitted = unwrapHook(capability.optimizeDepsPlugin.renderChunk).call(
      {},
      transformed?.code ?? "",
      { fileName: "entry.js" },
      { format: "es" },
    );

    expect(emitted?.code).toContain('import * as __vinext_module_process__ from "node:process";');
    expect(emitted?.code).toContain('import * as __vinext_module_fs_ from "node:fs";');
    expect(emitted?.code).toContain("const __vinext_module_identity_ = (() => {");
    expectFinalizedCjsGlobal(emitted?.code, "__dirname");
  });

  it("selects collision-free bindings for emitted ESM dependency URLs", () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transformed = unwrapHook(capability.optimizeDepsPlugin.transform).call(
      {},
      `import { fileURLToPath } from "node:url";
const __vinext_module_url = 1;
const __vinext_module_identity = 2;
const value = fileURLToPath(import.meta.url);
export { value, __vinext_module_url, __vinext_module_identity };`,
      esmDependencyPath,
    );
    const emitted = unwrapHook(capability.optimizeDepsPlugin.renderChunk).call(
      {},
      transformed?.code ?? "",
      { fileName: "entry.js" },
      { format: "es" },
    );

    expect(emitted?.code).toContain('import * as __vinext_module_url_ from "node:url";');
    expect(emitted?.code).toContain("const __vinext_module_identity_ = (() => {");
    expectFinalizedImportMetaUrl(emitted?.code);
  });

  it("keeps concat markers isolated through a real Rolldown generate", async () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transformed = unwrapHook(capability.optimizeDepsPlugin.transform).call(
      {},
      '#!/usr/bin/env node\nexport const joined = __dirname + "/foo";',
      cjsDependencyPath,
    );
    const result = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        {
          name: "test:concat-cjs-entry",
          resolveId(id) {
            return id === "virtual:concat-cjs-entry" ? `\0${id}` : null;
          },
          load(id) {
            return id === "\0virtual:concat-cjs-entry" ? transformed?.code : null;
          },
        },
        capability.optimizeDepsPlugin,
      ],
      build: {
        ssr: true,
        write: false,
        rolldownOptions: { input: "virtual:concat-cjs-entry" },
      },
    });
    const [{ output }] = (Array.isArray(result) ? result : [result]) as Array<{
      output: Array<{ type: string; code?: string }>;
    }>;
    const chunk = output.find((item) => item.type === "chunk");

    expect(chunk?.code).toMatch(
      /^#!\/usr\/bin\/env node\nimport\s*\*\s*as\s+\w+\s+from\s*["'`]node:process["'`];/,
    );
    expect(chunk?.code).toContain("/foo");
    expect(chunk?.code).toMatch(/node:process/);
    expect(chunk?.code).not.toContain("__VINEXT_EMITTED_MODULE_");
  });

  it("quotes nested emitted chunk paths without losing spaces", () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transformed = unwrapHook(capability.optimizeDepsPlugin.transform).call(
      {},
      "exports.paths = [__filename, __dirname];",
      cjsDependencyPath,
    );
    const emitted = unwrapHook(capability.optimizeDepsPlugin.renderChunk).call(
      {},
      transformed?.code ?? "",
      { fileName: "chunks/path with spaces/entry.js" },
      { format: "es" },
    );

    expectFinalizedCjsGlobal(emitted?.code, "__filename", "chunks/path with spaces/entry.js");
    expectFinalizedCjsGlobal(emitted?.code, "__dirname", "chunks/path with spaces/entry.js");
    expect(emitted?.code.match(/\.existsSync\(/g)).toHaveLength(1);
  });

  it("finalizes exact private markers without reparsing the emitted chunk", () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transformed = unwrapHook(capability.optimizeDepsPlugin.transform).call(
      {},
      "exports.dirname = __dirname;",
      cjsDependencyPath,
    );
    const emitted = unwrapHook(capability.optimizeDepsPlugin.renderChunk).call(
      {},
      `${transformed?.code}\nreturn;`,
      { fileName: "entry.js" },
      { format: "es" },
    );

    expectFinalizedCjsGlobal(emitted?.code, "__dirname");
  });

  it("does not redefine CommonJS globals already bound by a source module", () => {
    const result = rewriteServerCjsGlobals(
      `const __dirname = import.meta.dirname;\nawait Promise.resolve(__dirname);\n`,
      pagePath,
      linkedRoot,
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
    expect(viteFilter.code.test("export const value = import.meta /* note */ .url")).toBe(true);
    expect(viteFilter.code.test("export const value = import.meta.env")).toBe(false);
    expect(viteFilter.code.test("export const value = import /* note */ . meta.u\\u0072l")).toBe(
      true,
    );
    expect(optimizerFilter.id.test(pagePath)).toBe(true);
    expect(optimizerFilter.id.test(cjsDependencyPath)).toBe(true);
    expect(optimizerFilter.code.test("exports.value = 1")).toBe(false);
    expect(optimizerFilter.code.test("export const value = import.meta.env")).toBe(false);
    expect(optimizerFilter.code.test("export const value = import.meta. /* note */ url")).toBe(
      true,
    );
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

  it("does not backtrack across repeated comment near-matches", () => {
    const blockDecoy = `import ${"/*x*/".repeat(30)}.metx.url`;
    const lineDecoy = `import ${"//x\r\n".repeat(30)}.metx.url`;
    const source = [
      `const blockDecoy = ${JSON.stringify(blockDecoy)};`,
      `const lineDecoy = \`${lineDecoy}\`;`,
      "export const url = import.meta.url;",
    ].join("\n");
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const filter = (
      capability.optimizeDepsPlugin.transform as {
        filter: { code: RegExp };
      }
    ).filter.code;

    expect(filter.test(source)).toBe(true);
    expectBundledImportMetaUrl(
      unwrapHook(capability.optimizeDepsPlugin.transform).call({}, source, esmDependencyPath)?.code,
    );
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

  it("uses source identity when unbundled and emitted identity when bundled", async () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transform = unwrapHook(capability.vitePlugin.transform);
    const source = "exports.path = __dirname;";

    const devResult = transform.call(
      { environment: { mode: "dev", config: { consumer: "server" } } },
      source,
      cjsDependencyPath,
    );
    expect(devResult?.code).toContain(
      `var __dirname = ${JSON.stringify(toSlash(path.dirname(await fsp.realpath(cjsDependencyPath))))};`,
    );
    expect(
      transform.call(
        { environment: { mode: "dev", config: { consumer: "client" } } },
        source,
        cjsDependencyPath,
      ),
    ).toBeNull();
    const buildResult = transform.call(
      { environment: { mode: "build", config: { consumer: "server" } } },
      source,
      cjsDependencyPath,
    );
    expectBundledCjsGlobal(buildResult?.code, "__dirname");
    const emittedResult = unwrapHook(capability.vitePlugin.renderChunk).call(
      { environment: { config: { consumer: "server" } } },
      buildResult?.code ?? "",
      { fileName: "worker/entry.js" },
      { format: "es" },
    );
    expectFinalizedCjsGlobal(emittedResult?.code, "__dirname", "worker/entry.js");
  });

  it("delegates deployed filenames to the configured environment resolver", () => {
    const resolveEmittedModuleFileName = vi.fn(
      (environmentName: string | undefined, fileName: string) =>
        environmentName === "ssr" ? path.posix.join("ssr", fileName) : fileName,
    );
    const createEmittedModuleFileNameResolver = vi.fn(() => resolveEmittedModuleFileName);
    const capability = createImportMetaUrlPlugin({
      getRoot: () => realRoot,
      createEmittedModuleFileNameResolver,
    });
    const config = {
      root: realRoot,
      build: { outDir: path.join(realRoot, "dist/server") },
      environments: {
        auxiliary: {
          consumer: "server",
          build: { outDir: path.join(realRoot, "dist/server/auxiliary") },
        },
        client: {
          consumer: "client",
          build: { outDir: path.join(realRoot, "dist/client") },
        },
        rsc: {
          consumer: "server",
          build: { outDir: path.join(realRoot, "dist/server") },
        },
        ssr: {
          consumer: "server",
          build: { outDir: path.join(realRoot, "dist/server/ssr") },
        },
      },
    };
    unwrapHook(capability.vitePlugin.configResolved).call({}, config);
    expect(createEmittedModuleFileNameResolver).toHaveBeenCalledWith(config);
    const buildResult = unwrapHook(capability.vitePlugin.transform).call(
      { environment: { name: "ssr", mode: "build", config: { consumer: "server" } } },
      "exports.path = __filename;",
      cjsDependencyPath,
    );
    const emittedResult = unwrapHook(capability.vitePlugin.renderChunk).call(
      { environment: { name: "ssr", config: { consumer: "server" } } },
      buildResult?.code ?? "",
      { fileName: "_next/static/split.js" },
      { format: "es" },
    );

    expectFinalizedCjsGlobal(emittedResult?.code, "__filename", "ssr/_next/static/split.js");
    expect(resolveEmittedModuleFileName).toHaveBeenCalledWith("ssr", "_next/static/split.js");

    const auxiliaryResult = unwrapHook(capability.vitePlugin.renderChunk).call(
      { environment: { name: "auxiliary", config: { consumer: "server" } } },
      buildResult?.code ?? "",
      { fileName: "worker.js" },
      { format: "es" },
    );
    expectFinalizedCjsGlobal(auxiliaryResult?.code, "__filename", "worker.js");
    expect(resolveEmittedModuleFileName).toHaveBeenCalledWith("auxiliary", "worker.js");
  });

  it("keeps emitted filenames unchanged without a deployment resolver", () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    unwrapHook(capability.vitePlugin.configResolved).call(
      {},
      {
        root: realRoot,
        build: { outDir: path.join(realRoot, "dist") },
        environments: {
          nitro: {
            consumer: "server",
            build: { outDir: path.join(realRoot, "dist") },
          },
          rsc: {
            consumer: "server",
            build: { outDir: path.join(realRoot, "node_modules/.nitro/vite/services/rsc") },
          },
          ssr: {
            consumer: "server",
            build: { outDir: path.join(realRoot, "node_modules/.nitro/vite/services/ssr") },
          },
        },
      },
    );
    const buildResult = unwrapHook(capability.vitePlugin.transform).call(
      { environment: { name: "ssr", mode: "build", config: { consumer: "server" } } },
      "exports.path = __filename;",
      cjsDependencyPath,
    );
    const emittedResult = unwrapHook(capability.vitePlugin.renderChunk).call(
      { environment: { name: "ssr", config: { consumer: "server" } } },
      buildResult?.code ?? "",
      { fileName: "_next/static/split.js" },
      { format: "es" },
    );

    expectFinalizedCjsGlobal(emittedResult?.code, "__filename", "_next/static/split.js");
    expect(emittedResult?.code).not.toContain("node_modules/.nitro");
  });

  it("keeps explicit project CommonJS parseable before lowering", async () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => realRoot });
    const transform = unwrapHook(capability.vitePlugin.transform);
    const source = `exports.paths = [__filename, __dirname];`;
    const canonicalLocalCjsPath = toSlash(await fsp.realpath(localCjsPath));

    const devResult = transform.call(
      { environment: { name: "ssr", mode: "dev", config: { consumer: "server" } } },
      source,
      localCjsPath,
    );
    expect(devResult?.code).toContain(`var __filename = ${JSON.stringify(canonicalLocalCjsPath)};`);

    const buildResult = transform.call(
      { environment: { name: "ssr", mode: "build", config: { consumer: "server" } } },
      source,
      localCjsPath,
    );
    expectBundledCjsGlobal(buildResult?.code, "__filename");
    expectBundledCjsGlobal(buildResult?.code, "__dirname");
    expect(() => parseAst(buildResult?.code ?? "")).not.toThrow();
    const emittedResult = unwrapHook(capability.vitePlugin.renderChunk).call(
      { environment: { config: { consumer: "server" } } },
      buildResult?.code ?? "",
      { fileName: "server/entry.js" },
      { format: "es" },
    );
    expectFinalizedCjsGlobal(emittedResult?.code, "__filename", "server/entry.js");
    expectFinalizedCjsGlobal(emittedResult?.code, "__dirname", "server/entry.js");
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
    expect(result?.code).not.toContain(`var __filename =`);
    expectSourceCjsGlobal(result?.code, "__dirname", pagePath);
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
    expectSourceCjsGlobal(result?.code, "__filename", pagePath);
    expectSourceCjsGlobal(result?.code, "__dirname", pagePath);
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
    expectSourceCjsGlobal(result?.code, "__filename", pagePath);
    expectSourceCjsGlobal(result?.code, "__dirname", pagePath);
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
    expectSourceCjsGlobal(result?.code, "__filename", pagePath);
    expectSourceCjsGlobal(result?.code, "__dirname", pagePath);
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
    expectSourceCjsGlobal(result?.code, "__filename", pagePath);
    expectSourceCjsGlobal(result?.code, "__dirname", pagePath);
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
    expectSourceCjsGlobal(result?.code, "__filename", pagePath);
    expectSourceCjsGlobal(result?.code, "__dirname", pagePath);
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
    expectSourceCjsGlobal(result?.code, "__filename", pagePath);
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

    expectSourceCjsGlobal(result?.code, "__filename", pagePath);
  });

  it("injects a name with a real read even when the other only appears as a member", () => {
    const result = rewriteServerCjsGlobals(
      `obj.__filename;\nconsole.log(__dirname);\n`,
      pagePath,
      linkedRoot,
    );

    // __dirname is read freely → injected; __filename only appears as a member
    // property → not injected.
    expectSourceCjsGlobal(result?.code, "__dirname", pagePath);
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
