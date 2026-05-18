import { describe, it, expect, afterEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadNextConfig } from "../packages/vinext/src/config/next-config.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cfg-ext-"));
}

describe("loadNextConfig — Next.js next-config-ts-native extension/import parity", () => {
  // These tests mirror the fixtures under .nextjs-ref/test/e2e/app-dir/
  // next-config-ts-native-{mts,ts}/ that exercise extension probing,
  // .mts/.cts imports, nested imports, etc.
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Ported from Next.js: test/e2e/app-dir/next-config-ts-native-mts/nested-imports/
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-config-ts-native-mts/nested-imports/
  it("resolves nested .ts imports from next.config.ts (explicit .ts extension)", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { allowImportingTsExtensions: true } }),
    );
    fs.writeFileSync(path.join(tmpDir, "baz.ts"), `export const baz = 'baz';\n`);
    fs.writeFileSync(
      path.join(tmpDir, "bar.ts"),
      `import { baz } from './baz.ts';\nexport const barbaz = 'bar' + baz;\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "foo.ts"),
      `import { barbaz } from './bar.ts';\nexport const foobarbaz = 'foo' + barbaz;\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `import { foobarbaz } from './foo.ts';\nexport default { env: { FOOBARBAZ: foobarbaz } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.FOOBARBAZ).toBe("foobarbaz");
  });

  // Ported from Next.js: test/e2e/app-dir/next-config-ts-native-mts/import-js-extensions-{cjs,esm}/
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-config-ts-native-mts/import-js-extensions-cjs/
  it("resolves .mts/.cts/.mjs/.cjs/.ts/.js imports from next.config.mts", async () => {
    tmpDir = makeTempDir();
    // Mirrors fixtures dir
    const fix = path.join(tmpDir, "fixtures");
    fs.mkdirSync(fix);
    fs.writeFileSync(path.join(fix, "cjs.cjs"), `module.exports = 'cjs'\n`);
    fs.writeFileSync(path.join(fix, "mjs.mjs"), `export default 'mjs'\n`);
    fs.writeFileSync(path.join(fix, "cts.cts"), `module.exports = 'cts'\n`);
    fs.writeFileSync(path.join(fix, "mts.mts"), `export default 'mts'\n`);
    fs.writeFileSync(path.join(fix, "ts.ts"), `export default 'ts'\n`);
    fs.writeFileSync(path.join(fix, "js-cjs.js"), `module.exports = 'jsCJS'\n`);
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mts"),
      `import cjs from './fixtures/cjs.cjs'\n` +
        `import mjs from './fixtures/mjs.mjs'\n` +
        `import * as cts from './fixtures/cts.cts'\n` +
        `import mts from './fixtures/mts.mts'\n` +
        `import ts from './fixtures/ts.ts'\n` +
        `import js from './fixtures/js-cjs.js'\n` +
        `export default { env: { cjs, mjs, cts: (cts as any).default, mts, ts, js } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env).toEqual({
      cjs: "cjs",
      mjs: "mjs",
      cts: "cts",
      mts: "mts",
      ts: "ts",
      js: "jsCJS",
    });
  });

  // Ported from Next.js: test/e2e/app-dir/next-config-ts-native-mts/import-from-node-modules/
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-config-ts-native-mts/import-from-node-modules/
  it("resolves bare-import packages from next.config.ts (.cjs/.mjs/.js)", async () => {
    tmpDir = makeTempDir();
    // CJS package (no exports field, just main)
    const cjsPkg = path.join(tmpDir, "node_modules", "cjs");
    fs.mkdirSync(cjsPkg, { recursive: true });
    fs.writeFileSync(
      path.join(cjsPkg, "package.json"),
      JSON.stringify({ name: "cjs", main: "index.cjs" }),
    );
    fs.writeFileSync(path.join(cjsPkg, "index.cjs"), `module.exports = 'cjs'\n`);
    // MJS package
    const mjsPkg = path.join(tmpDir, "node_modules", "mjs");
    fs.mkdirSync(mjsPkg, { recursive: true });
    fs.writeFileSync(
      path.join(mjsPkg, "package.json"),
      JSON.stringify({ name: "mjs", main: "index.mjs" }),
    );
    fs.writeFileSync(path.join(mjsPkg, "index.mjs"), `export default 'mjs'\n`);
    // JS CJS package (no type field, default cjs)
    const jsCjs = path.join(tmpDir, "node_modules", "js-cjs");
    fs.mkdirSync(jsCjs, { recursive: true });
    fs.writeFileSync(
      path.join(jsCjs, "package.json"),
      JSON.stringify({ name: "js-cjs", main: "index.js" }),
    );
    fs.writeFileSync(path.join(jsCjs, "index.js"), `module.exports = 'jsCJS'\n`);
    // JS ESM package (type:module)
    const jsEsm = path.join(tmpDir, "node_modules", "js-esm");
    fs.mkdirSync(jsEsm, { recursive: true });
    fs.writeFileSync(
      path.join(jsEsm, "package.json"),
      JSON.stringify({ name: "js-esm", main: "index.js", type: "module" }),
    );
    fs.writeFileSync(path.join(jsEsm, "index.js"), `export default 'jsESM'\n`);

    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `import cjs from 'cjs'\n` +
        `import mjs from 'mjs'\n` +
        `import jsCJS from 'js-cjs'\n` +
        `import jsESM from 'js-esm'\n` +
        `export default { env: { cjs, mjs, jsCJS, jsESM } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env).toEqual({
      cjs: "cjs",
      mjs: "mjs",
      jsCJS: "jsCJS",
      jsESM: "jsESM",
    });
  });

  // Ported from Next.js: test/e2e/app-dir/next-config-ts-native-mts/nested-imports/
  // (CJS variant — package.json with no "type" field)
  it("resolves nested .ts imports when next.config.mts is in a CJS package", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.0.0" }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { allowImportingTsExtensions: true } }),
    );
    fs.writeFileSync(path.join(tmpDir, "baz.ts"), `export const baz = 'baz';\n`);
    fs.writeFileSync(
      path.join(tmpDir, "bar.ts"),
      `import { baz } from './baz.ts';\nexport const barbaz = 'bar' + baz;\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "foo.ts"),
      `import { barbaz } from './bar.ts';\nexport const foobarbaz = 'foo' + barbaz;\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mts"),
      `import { foobarbaz } from './foo.ts';\nexport default { env: { FOOBARBAZ: foobarbaz } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.FOOBARBAZ).toBe("foobarbaz");
  });
});
