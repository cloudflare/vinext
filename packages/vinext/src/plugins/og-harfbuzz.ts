/**
 * vinext:og-harfbuzz — load @vercel/og's bundled HarfBuzz under vinext.
 *
 * @vercel/og 1.x inlines harfbuzzjs's Emscripten glue into both entry bundles.
 * Unmodified, that glue cannot start:
 *
 *   - Node ESM: its Node branch calls esbuild's `__require("fs")` and reads
 *     `__dirname`, neither of which exists in an ES module.
 *   - workerd: it reads `self.location.href`, takes the Node branch under
 *     `nodejs_compat`, and fetches `hb.wasm` from a relative URL. Workers also
 *     forbid compiling WASM from bytes, which Emscripten does for every
 *     JavaScript callback it adds to the WASM function table.
 *
 * The transform locates the HarfBuzz factory by syntax (the function that
 * names `"hb.wasm"` and reads Emscripten's `instantiateWasm` hook) and, inside
 * it only:
 *
 *   1. sets every `ENVIRONMENT_IS_*` flag to `false`, so no host branch runs;
 *   2. replaces `instantiateWasm` reads with a vinext loader that instantiates
 *      `hb.wasm` synchronously (a `?module` import on workerd, a disk read on
 *      Node), so a bad binary rejects initialization instead of hanging it;
 *   3. on workerd, serves callback modules from precompiled adapters instead
 *      of `new WebAssembly.Module(bytes)`.
 *
 * Whitespace, esbuild's renames and harfbuzzjs's wrapper code can change
 * freely. If a patch site is missing, the build fails with an explicit error
 * instead of shipping an OG route that breaks at runtime.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path, { toSlash } from "pathslash";
import MagicString from "magic-string";
import { parseAst, type ESTree, type Plugin } from "vite";
import { forEachAstChild, getAstName, staticStringValue } from "./ast-utils.js";
import { isFunctionNode } from "./ast-scope.js";
import { magicStringTransformResult } from "./transform-result.js";

const HARFBUZZ_WASM = "hb.wasm";

// Emscripten signature letters for WASM value types. Emscripten also uses `p`
// for pointers, which are i32 on wasm32.
const VALUE_TYPES: Record<string, number> = { i: 0x7f, j: 0x7e, f: 0x7d, d: 0x7c };
const VALUE_TYPE_LETTERS = new Map(Object.entries(VALUE_TYPES).map(([k, v]) => [v, k]));

/**
 * Resolve the `hb.wasm` binary that matches the glue inlined in @vercel/og.
 * @vercel/og and satori pin exact versions, so resolving through
 * @vercel/og → satori → harfbuzzjs yields the build the bundle was made from.
 */
export function resolveHarfbuzzWasmPath(ogEntry: string): string {
  const satoriEntry = createRequire(ogEntry).resolve("satori");
  return toSlash(createRequire(satoriEntry).resolve(`harfbuzzjs/${HARFBUZZ_WASM}`));
}

/**
 * Read every function type in a WASM binary as an Emscripten signature (result
 * letter, or `v` for none, then parameters). Any callback HarfBuzz calls
 * through its function table must have one of these types, so adapters for
 * all of them cover every callback the glue can register.
 */
export function readWasmFunctionSignatures(wasm: Uint8Array): string[] {
  let offset = 8;
  const readU32 = (): number => {
    let result = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = wasm[offset++];
      result |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result >>> 0;
    }
  };
  const readTypes = (): string | null => {
    let letters: string | null = "";
    for (let count = readU32(); count > 0; count--) {
      const letter = VALUE_TYPE_LETTERS.get(wasm[offset++]);
      letters = letter && letters !== null ? letters + letter : null;
    }
    return letters;
  };

  const signatures = new Set<string>();
  while (offset < wasm.length) {
    const sectionId = wasm[offset++];
    const sectionEnd = readU32() + offset;
    if (sectionId === 1) {
      for (let count = readU32(); count > 0; count--) {
        offset++; // 0x60 function type marker
        const params = readTypes();
        const results = readTypes();
        if (params !== null && results !== null && results.length <= 1) {
          signatures.add((results || "v") + params);
        }
      }
    }
    offset = sectionEnd;
  }
  return [...signatures];
}

/**
 * Build the module Emscripten's `convertJsFunctionToWasm` compiles for a
 * signature: it imports a JavaScript function as `e.f` and re-exports it as
 * `f`. Every section in it is shorter than 128 bytes, so each length and count
 * is a single LEB128 byte.
 */
export function createHarfbuzzCallbackWasm(signature: string): Uint8Array<ArrayBuffer> {
  const typeCode = (letter: string): number => {
    const code = VALUE_TYPES[letter];
    if (code === undefined)
      throw new Error(`[vinext] Invalid WASM callback signature: ${signature}`);
    return code;
  };
  const [result, ...params] = signature;
  const results = result === "v" ? [] : [typeCode(result)];
  const functionType = [0x60, params.length, ...params.map(typeCode), results.length, ...results];
  if (functionType.length > 64)
    throw new Error(`[vinext] WASM callback signature too long: ${signature}`);
  const section = (id: number, contents: number[]) => [id, contents.length, ...contents];
  return Uint8Array.from([
    // "\0asm" magic, version 1
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, [1, ...functionType]),
    ...section(2, [1, 1, 0x65, 1, 0x66, 0x00, 0x00]), // import "e" "f" (func type 0)
    ...section(7, [1, 1, 0x66, 0x00, 0x00]), // export "f" (func 0)
  ]);
}

/** Write each callback adapter once and return its path by signature. */
function writeHarfbuzzCallbackModules(harfbuzzWasm: string, outDir: string): Map<string, string> {
  fs.mkdirSync(outDir, { recursive: true });
  const modules = new Map<string, string>();
  for (const signature of readWasmFunctionSignatures(fs.readFileSync(harfbuzzWasm))) {
    const filePath = path.join(outDir, `harfbuzz-callback-${signature}.wasm`);
    if (!fs.existsSync(filePath)) {
      // Write-then-rename so a concurrent build never imports a partial file.
      const tempPath = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tempPath, createHarfbuzzCallbackWasm(signature));
      fs.renameSync(tempPath, filePath);
    }
    modules.set(signature, filePath);
  }
  return modules;
}

// ── Patch sites ───────────────────────────────────────────────────────────────

type HarfbuzzPatchSites = {
  instantiateWasmReads: ESTree.MemberExpression[];
  /** Initializers of the factory's `ENVIRONMENT_IS_*` declarations. */
  environmentFlags: ESTree.Expression[];
  /** `new WebAssembly.Module(bytes)` calls with their enclosing function. */
  moduleCompilations: Array<{ node: ESTree.NewExpression; enclosingFunction: ESTree.Node }>;
};

const contains = (outer: ESTree.Node, inner: ESTree.Node) =>
  outer.start <= inner.start && inner.end <= outer.end;

/**
 * Find the HarfBuzz factory — the innermost function that both names
 * `"hb.wasm"` and reads `instantiateWasm` — and the patch sites inside it.
 * Scoping edits to that function keeps yoga's own Emscripten module, which
 * also reads `instantiateWasm`, untouched.
 */
function findHarfbuzzPatchSites(program: ESTree.Program): HarfbuzzPatchSites | string {
  const functionStack: ESTree.Node[] = [];
  const wasmNameScopes: ESTree.Node[][] = [];
  const instantiateWasmMembers: ESTree.MemberExpression[] = [];
  const environmentFlags: Array<{
    declarator: ESTree.VariableDeclarator;
    init: ESTree.Expression;
  }> = [];
  const moduleCompilations: HarfbuzzPatchSites["moduleCompilations"] = [];

  const visit = (node: ESTree.Node): void => {
    const isFunction = isFunctionNode(node);
    if (isFunction) functionStack.push(node);
    if (staticStringValue(node) === HARFBUZZ_WASM) {
      wasmNameScopes.push([...functionStack]);
    } else if (
      node.type === "MemberExpression" &&
      getAstName(node.property) === "instantiateWasm"
    ) {
      instantiateWasmMembers.push(node);
    } else if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name.startsWith("ENVIRONMENT_IS_") &&
      node.init
    ) {
      environmentFlags.push({ declarator: node, init: node.init });
    } else if (
      node.type === "NewExpression" &&
      node.callee.type === "MemberExpression" &&
      getAstName(node.callee.object) === "WebAssembly" &&
      getAstName(node.callee.property) === "Module" &&
      functionStack.length > 0
    ) {
      moduleCompilations.push({ node, enclosingFunction: functionStack[functionStack.length - 1] });
    }
    forEachAstChild(node, visit);
    if (isFunction) functionStack.pop();
  };
  visit(program);

  const factories = new Set<ESTree.Node>();
  for (const scopes of wasmNameScopes) {
    const factory = [...scopes]
      .reverse()
      .find((scope) => instantiateWasmMembers.some((member) => contains(scope, member)));
    if (factory) factories.add(factory);
  }
  if (factories.size !== 1) {
    return `expected one function that names "${HARFBUZZ_WASM}" and reads instantiateWasm, found ${factories.size}`;
  }
  const [factory] = factories;

  const flags = environmentFlags.filter(({ declarator }) => contains(factory, declarator));
  if (!flags.some(({ declarator }) => getAstName(declarator.id) === "ENVIRONMENT_IS_NODE")) {
    return "the factory does not declare ENVIRONMENT_IS_NODE";
  }
  return {
    instantiateWasmReads: instantiateWasmMembers.filter((member) => contains(factory, member)),
    environmentFlags: flags.map(({ init }) => init),
    moduleCompilations: moduleCompilations.filter(({ node }) => contains(factory, node)),
  };
}

// ── Plugin ────────────────────────────────────────────────────────────────────

// Emscripten's `instantiateWasm(imports, receiveInstance)` hook, instantiated
// synchronously so failures reject the glue's promise instead of hanging it.
const INSTANTIATE_WASM = `function __vi_hb_instantiateWasm(imports, receiveInstance) {
  var instance = new WebAssembly.Instance(__vi_hb_module(), imports);
  receiveInstance(instance);
  return instance.exports;
}`;

export function createOgHarfbuzzPlugin(): Plugin {
  let callbackModuleDir: string;
  let isBuild = false;

  return {
    name: "vinext:og-harfbuzz",
    enforce: "pre",
    configResolved(config) {
      callbackModuleDir = path.join(toSlash(config.root), ".vinext", "og-assets");
      isBuild = config.command === "build";
    },
    transform: {
      filter: {
        id: /[\\/]@vercel[\\/]og[\\/]dist[\\/]index\.(?:edge|node)\.js(?:\?.*)?$/,
        code: /["'`]hb\.wasm["'`]/,
      },
      handler(code, id) {
        const ogEntry = toSlash(id.split("?", 1)[0]);
        const isWorkerd = ogEntry.endsWith("/index.edge.js");
        const fail = (reason: string): never =>
          this.error(
            `[vinext] Unsupported @vercel/og HarfBuzz bundle in ${ogEntry}: ${reason}. ` +
              "vinext must be updated to support this @vercel/og version.",
          );

        const sites = findHarfbuzzPatchSites(parseAst(code, { lang: "js" }));
        if (typeof sites === "string") return fail(sites);

        const output = new MagicString(code);
        for (const flag of sites.environmentFlags) {
          output.overwrite(flag.start, flag.end, "false");
        }
        for (const member of sites.instantiateWasmReads) {
          output.overwrite(member.start, member.end, "__vi_hb_instantiateWasm");
        }

        const harfbuzzWasm = resolveHarfbuzzWasmPath(ogEntry);
        const preamble: string[] = [];
        if (isWorkerd) {
          // `convertJsFunctionToWasm(func, sig)` compiles a callback module per
          // signature; substitute the precompiled adapter for that signature.
          if (sites.moduleCompilations.length === 0) {
            return fail("no callback module compilation (new WebAssembly.Module) was found");
          }
          for (const { node, enclosingFunction } of sites.moduleCompilations) {
            const signature = isFunctionNode(enclosingFunction)
              ? enclosingFunction.params[1]
              : undefined;
            if (signature?.type !== "Identifier") {
              return fail("the callback compiler does not take a (func, sig) signature");
            }
            output.prependLeft(
              node.start,
              `(__vi_hb_callbacks[${signature.name}.replace(/p/g, "i")] || `,
            );
            output.appendRight(node.end, ")");
          }

          const callbacks = [...writeHarfbuzzCallbackModules(harfbuzzWasm, callbackModuleDir)];
          preamble.push(
            `import __vi_hb_wasm from ${JSON.stringify(`${harfbuzzWasm}?module`)};`,
            ...callbacks.map(
              ([, file], index) =>
                `import __vi_hb_callback_${index} from ${JSON.stringify(`${file}?module`)};`,
            ),
            `var __vi_hb_callbacks = { ${callbacks
              .map(([signature], index) => `${signature}: __vi_hb_callback_${index}`)
              .join(", ")} };`,
            "function __vi_hb_module() { return __vi_hb_wasm; }",
          );
        } else {
          // Builds read the copy vinext:og-assets places beside the server
          // output; dev reads the installed binary directly.
          const location = isBuild
            ? `new URL("./${HARFBUZZ_WASM}", import.meta.url)`
            : JSON.stringify(harfbuzzWasm);
          preamble.push(
            `import { readFileSync as __vi_hb_readFileSync } from "node:fs";`,
            `function __vi_hb_module() { return new WebAssembly.Module(__vi_hb_readFileSync(${location})); }`,
          );
        }

        output.prepend(`${preamble.join("\n")}\n${INSTANTIATE_WASM}\n`);
        return magicStringTransformResult(output);
      },
    },
  };
}
