import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  commonJsEsmFacadeOptimizeDepsPlugin,
  stripEsmCommonJsExportFacade,
} from "../packages/vinext/src/plugins/commonjs-esm-facade.js";
import {
  originalPositionFor,
  type SourceMapPayload,
} from "../packages/vinext/src/server/dev-stack-sourcemap.js";

type CommonJsTransform = (code: string, id: string) => Promise<{ code: string } | null | undefined>;

const require = createRequire(path.join(import.meta.dirname, "../packages/vinext/package.json"));
const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures");

/** The real vite-plugin-commonjs transform, with its filter accepting every id. */
function createCommonJsTransform(): CommonJsTransform {
  const commonjs = require("vite-plugin-commonjs").default;
  const plugin = commonjs({ filter: () => true });
  plugin.configResolved({
    root: FIXTURES_DIR,
    resolve: { alias: [], extensions: [".js"] },
    optimizeDeps: {},
    logger: console,
    createResolver: () => async () => undefined,
  });
  return (code, id) => plugin.transform(code, id);
}

const transformCommonJs = createCommonJsTransform();
const id = path.join(FIXTURES_DIR, "module.js");

async function transformAndStrip(source: string) {
  const output = (await transformCommonJs(source, id))?.code;
  if (output === undefined) throw new Error("vite-plugin-commonjs left the module unchanged");
  return { output, stripped: stripEsmCommonJsExportFacade(output) };
}

describe("stripEsmCommonJsExportFacade", () => {
  it("drops the facade the plugin derives from inlined CommonJS wrappers", async () => {
    const source = [
      `var require_re = __commonJS({ "re.js"(exports, module) { exports.t = {}; module.exports.src = []; } });`,
      `const re = require_re();`,
      `const t = re.t;`,
      `const src = re.src;`,
      `export { src, t };`,
    ].join("\n");
    const { output, stripped } = await transformAndStrip(source);

    expect(output).toContain("__CJS__export_t__ as t");
    expect(stripped).toBeDefined();
    expect(stripped).not.toContain("__CJS__export_");
    expect(stripped).not.toContain("export-statement");
    expect(stripped).toContain("export { src, t };");
  });

  it("keeps require() conversion and the local exports polyfill in ESM", async () => {
    const source = [
      `const dep = require("./dep.js");`,
      `exports.named = "cjs";`,
      `const named = dep.value;`,
      `export { named };`,
    ].join("\n");
    const { stripped } = await transformAndStrip(source);

    expect(stripped).toContain(`import * as __CJS__import__0__ from "./dep.js"`);
    expect(stripped).toContain("var module = { exports: {} }; var exports = module.exports;");
    expect(stripped).not.toContain("__CJS__export_named__");
    expect(stripped?.match(/\bexport\s*\{/g)).toEqual(["export {"]);
  });

  it("keeps the facade of a CommonJS module", async () => {
    const { output, stripped } = await transformAndStrip(`exports.named = "cjs";`);

    expect(output).toContain("__CJS__export_named__ as named");
    expect(stripped).toBeUndefined();
  });

  it("keeps the facade when `export` appears only in strings and comments", async () => {
    const { stripped } = await transformAndStrip(
      `// export default nothing\nmodule.exports = "export { named }";`,
    );

    expect(stripped).toBeUndefined();
  });

  it("leaves output without a facade alone", () => {
    expect(stripEsmCommonJsExportFacade(`export const a = 1;`)).toBeUndefined();
  });

  it("keeps code appended after the facade", () => {
    const output = [
      `export const a = 1;`,
      `/* [vite-plugin-commonjs] export-statement-S */`,
      `export { x as default }`,
      `/* [vite-plugin-commonjs] export-statement-E */`,
      `function __matchRequireRuntime0__(path) {}`,
    ].join("\n");

    expect(stripEsmCommonJsExportFacade(output)).toBe(
      `export const a = 1;\n\nfunction __matchRequireRuntime0__(path) {}`,
    );
  });
});

describe("commonJsEsmFacadeOptimizeDepsPlugin", () => {
  type TransformHandler = (
    code: string,
    id: string,
  ) => { code: string; map: SourceMapPayload } | null;
  const transform = commonJsEsmFacadeOptimizeDepsPlugin.transform as { handler: TransformHandler };

  it("maps code appended after the removed facade to its loaded position", () => {
    const loaded = [
      `export const a = 1;`,
      `/* [vite-plugin-commonjs] export-statement-S */`,
      `export { x as default }`,
      `/* [vite-plugin-commonjs] export-statement-E */`,
      `function __matchRequireRuntime0__(path) {}`,
    ].join("\n");
    const result = transform.handler.call(undefined, loaded, "/project/module.js");

    expect(result?.code).toBe(`export const a = 1;\n\nfunction __matchRequireRuntime0__(path) {}`);
    expect(originalPositionFor(result!.map, 3, 1)).toEqual({
      source: "/project/module.js",
      line: 5,
      column: 1,
    });
  });

  it("leaves CommonJS output alone", () => {
    const loaded = [
      `exports.a = 1;`,
      `/* [vite-plugin-commonjs] export-statement-S */`,
      `export { x as default }`,
      `/* [vite-plugin-commonjs] export-statement-E */`,
    ].join("\n");

    expect(transform.handler.call(undefined, loaded, "/project/module.js")).toBeNull();
  });
});
