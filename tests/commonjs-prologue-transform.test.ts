import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parseProgram } from "../packages/vinext/src/plugins/ast-utils.js";
import {
  commonJsEsmFacadeOptimizeDepsPlugin,
  stripEsmCommonJsExportFacade,
} from "../packages/vinext/src/plugins/commonjs-esm-facade.js";
import {
  commonJsProloguePlugin,
  moveCommonJsPrependedBlocksAfterPrologue,
} from "../packages/vinext/src/plugins/commonjs-prologue.js";

type CommonJsTransform = (code: string, id: string) => Promise<{ code: string } | null | undefined>;

const require = createRequire(path.join(import.meta.dirname, "../packages/vinext/package.json"));
const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures");
const id = path.join(FIXTURES_DIR, "module.js");

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

/** Converts `source` with vite-plugin-commonjs, then moves its prepended blocks. */
async function convert(source: string): Promise<string | undefined> {
  const converted = (await transformCommonJs(source, id))?.code;
  if (converted === undefined) throw new Error("vite-plugin-commonjs left the module unchanged");
  return moveCommonJsPrependedBlocksAfterPrologue(converted)?.toString();
}

type TransformHandler = (code: string, id: string) => { code: string } | null;

function runHandler(plugin: { transform?: unknown }, code: string): string {
  const { handler } = plugin.transform as { handler: TransformHandler };
  return handler.call(undefined, code, id)?.code ?? code;
}

/**
 * Converts `source` with vite-plugin-commonjs, then repairs the output the
 * way each pipeline does: Vite environments strip the export facade in the
 * conversion's wrapper and then run the prologue hook, and the dependency
 * optimizer runs the prologue hook and then its facade hook.
 */
async function convertAndRepair(source: string, pipeline: "vite" | "optimizer") {
  const code = (await transformCommonJs(source, id))?.code;
  if (code === undefined) throw new Error("vite-plugin-commonjs left the module unchanged");
  if (pipeline === "vite") {
    return runHandler(commonJsProloguePlugin, stripEsmCommonJsExportFacade(code) ?? code);
  }
  return runHandler(commonJsEsmFacadeOptimizeDepsPlugin, runHandler(commonJsProloguePlugin, code));
}

function exportedNames(code: string): string[] {
  return parseProgram(code).body.flatMap((statement) =>
    statement.type === "ExportNamedDeclaration"
      ? statement.specifiers.map((specifier) =>
          specifier.exported.type === "Identifier"
            ? specifier.exported.name
            : String(specifier.exported.value),
        )
      : [],
  );
}

function directives(code: string): string[] {
  const program = parseProgram(code);
  return program.body.flatMap((statement) =>
    statement.type === "ExpressionStatement" && typeof statement.directive === "string"
      ? [statement.directive]
      : [],
  );
}

describe("moveCommonJsPrependedBlocksAfterPrologue", () => {
  it("keeps a hashbang on the first line", async () => {
    const output = await convert("#!/usr/bin/env node\n\nmodule.exports = 123\n");
    expect(output).toMatch(/^#!\/usr\/bin\/env node\n\/\* \[vite-plugin-commonjs\]/);
    expect(() => parseProgram(output ?? "")).not.toThrow();
  });

  it("keeps the directive prologue ahead of hoisted imports", async () => {
    const output = await convert(
      '// leading comment\n"use client";\n\'use strict\';\nconst x = require("x");\nexport const y = x;\n',
    );
    expect(output?.startsWith("// leading comment\n\"use client\";\n'use strict';")).toBe(true);
    expect(directives(output ?? "")).toEqual(["use client", "use strict"]);
  });

  it("ends a directive without a semicolon before the moved blocks", async () => {
    const output = await convert('"use client"\nconst x = require("x");\nexport const y = x;\n');
    expect(output).toMatch(/^"use client";\/\* \[vite-plugin-commonjs\]/);
    expect(directives(output ?? "")).toEqual(["use client"]);
  });

  it("keeps a hashbang followed by directives", async () => {
    const output = await convert(
      '#!/usr/bin/env node\n"use server";\nmodule.exports = async function action() {};\n',
    );
    expect(output?.startsWith('#!/usr/bin/env node\n"use server";/* [vite-plugin-commonjs]')).toBe(
      true,
    );
    expect(directives(output ?? "")).toEqual(["use server"]);
  });

  it("keeps a hashbang first when the rest of the module fails to parse", () => {
    // vite-plugin-commonjs's polyfill block, then a module whose string
    // literal makes the hook parse it, and a syntax error.
    const code =
      "/* [vite-plugin-commonjs] export-runtime-S */ var module = { exports: {} }; var exports = module.exports; /* [vite-plugin-commonjs] export-runtime-E */" +
      '#!/usr/bin/env node\n"a";\nconst = ;\n';
    const output = moveCommonJsPrependedBlocksAfterPrologue(code)?.toString();
    expect(output).toMatch(
      /^#!\/usr\/bin\/env node\n\/\* \[vite-plugin-commonjs\] export-runtime-S/,
    );
  });

  it("leaves modules without a prologue unchanged", async () => {
    const converted = (
      await transformCommonJs('const x = require("x");\nmodule.exports = x;\n', id)
    )?.code;
    expect(converted).toBeDefined();
    expect(moveCommonJsPrependedBlocksAfterPrologue(converted ?? "")).toBeUndefined();
  });
});

// A module that mixes ESM exports with CommonJS assignments gets an export
// facade that duplicates its own exports. Both repairs must complete in either
// order: the facade must be classified while a hashbang is still behind the
// prepended blocks, and the directive prologue found while the facade is
// still there.
describe.each(["vite", "optimizer"] as const)(
  "CommonJS repairs of mixed ESM and CommonJS modules (%s)",
  (pipeline) => {
    const mixedBody =
      'const x = require("x");\nconst named = x;\nexports.named = named;\nexport { named };\n';

    it("keeps a hashbang first and removes the facade", async () => {
      const output = await convertAndRepair(`#!/usr/bin/env node\n${mixedBody}`, pipeline);
      expect(output).toMatch(/^#!\/usr\/bin\/env node\n/);
      expect(output).not.toContain("[vite-plugin-commonjs] export-statement-S");
      expect(exportedNames(output)).toEqual(["named"]);
    });

    it("keeps a directive first and removes the facade", async () => {
      const output = await convertAndRepair(`"use client";\n${mixedBody}`, pipeline);
      expect(directives(output)).toEqual(["use client"]);
      expect(output).not.toContain("[vite-plugin-commonjs] export-statement-S");
      expect(exportedNames(output)).toEqual(["named"]);
    });
  },
);

// Only the blocks vite-plugin-commonjs generates move: marker-like comments
// from the module's own source stay where the source put them.
describe("moveCommonJsPrependedBlocksAfterPrologue with source-authored markers", () => {
  const sourceBlock =
    "/* [vite-plugin-commonjs] user-S */ sideEffect(); /* [vite-plugin-commonjs] user-E */";

  it("does not move a source-authored block after the generated ones", async () => {
    const converted = (
      await transformCommonJs(`${sourceBlock}\n"use client";\nmodule.exports = require("x");\n`, id)
    )?.code;
    expect(converted).toMatch(/^\/\* \[vite-plugin-commonjs\] export-runtime-S \*\//);
    // In the source, `sideEffect()` runs first and "use client" is not a
    // directive. Moving the generated blocks would not change that, and the
    // source block must not move behind the string to turn it into one.
    expect(moveCommonJsPrependedBlocksAfterPrologue(converted ?? "")).toBeUndefined();
  });

  it("leaves a module that starts with a source-authored block alone", () => {
    const code = `${sourceBlock}\n"use client";\nexport const a = 1;\n`;
    expect(moveCommonJsPrependedBlocksAfterPrologue(code)).toBeUndefined();
  });
});
