import { afterAll, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createHarfbuzzCallbackWasm,
  createOgHarfbuzzPlugin,
  readWasmFunctionSignatures,
  resolveHarfbuzzWasmPath,
} from "../packages/vinext/src/plugins/og-harfbuzz.js";

const require = createRequire(path.join(import.meta.dirname, "../packages/vinext/package.json"));
const nodeEntry = require.resolve("@vercel/og");
const ogDistDir = path.dirname(nodeEntry);
const edgeEntry = path.join(ogDistDir, "index.edge.js");
const harfbuzzWasmPath = resolveHarfbuzzWasmPath(nodeEntry);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-og-harfbuzz-"));

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

type TransformHandler = (code: string, id: string) => { code: string } | null;

function createTransform(command: "build" | "serve", root: string): TransformHandler {
  const plugin = createOgHarfbuzzPlugin();
  (plugin.configResolved as (config: { root: string; command: string }) => void)({
    root,
    command,
  });
  const { handler } = plugin.transform as { handler: TransformHandler };
  const context = {
    error(message: string): never {
      throw new Error(message);
    },
  };
  return (code, id) => handler.call(context, code, id);
}

let copyCount = 0;

/** Copy @vercel/og's dist next to a transformed entry so its relative assets resolve. */
function writeOgCopy(entryName: string, code: string, extraFiles: Record<string, string> = {}) {
  const distDir = path.join(tmpRoot, `og-${copyCount++}`, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  for (const file of fs.readdirSync(ogDistDir)) {
    if (/\.(?:wasm|ttf)$/.test(file))
      fs.copyFileSync(path.join(ogDistDir, file), path.join(distDir, file));
  }
  for (const [name, source] of Object.entries(extraFiles)) {
    fs.copyFileSync(source, path.join(distDir, name));
  }
  const entryPath = path.join(distDir, entryName);
  fs.writeFileSync(entryPath, code);
  return entryPath;
}

const RENDER = `
const { ImageResponse } = await import(process.env.OG_ENTRY);
const response = new ImageResponse(
  { type: "div", props: { style: { display: "flex", fontSize: 48 }, children: "Hello vinext" } },
  { width: 320, height: 120 },
);
const png = new Uint8Array(await response.arrayBuffer());
process.stdout.write(JSON.stringify({ status: response.status, signature: [...png.slice(0, 8)], size: png.length }));
`;

// Mirrors workerd: `WorkerGlobalScope` exists, `self.location` does not,
// `nodejs_compat` exposes `process.versions.node`, `?module` imports yield
// precompiled modules, and compiling WASM from bytes at runtime throws.
const WORKERD_SIMULATION = `
import fs from "node:fs";
import { register } from "node:module";

const CompiledModule = WebAssembly.Module;
const instantiate = WebAssembly.instantiate;
globalThis.__compileWasmModule = (file) => new CompiledModule(fs.readFileSync(file));
register(
  "data:text/javascript," +
    encodeURIComponent(\`
      import { fileURLToPath, pathToFileURL } from "node:url";
      export async function resolve(specifier, context, next) {
        if (/^[A-Za-z]:[\\\\\\\\/]/.test(specifier)) specifier = pathToFileURL(specifier).href;
        return next(specifier, context);
      }
      export async function load(url, context, next) {
        if (!url.endsWith(".wasm?module")) return next(url, context);
        const file = fileURLToPath(url.slice(0, -"?module".length));
        return {
          format: "module",
          shortCircuit: true,
          source: "export default globalThis.__compileWasmModule(" + JSON.stringify(file) + ");",
        };
      }
    \`),
);

const disallowed = () => new WebAssembly.CompileError("Wasm code generation disallowed by embedder");
function Module() { throw disallowed(); }
Module.prototype = CompiledModule.prototype;
Module.imports = CompiledModule.imports;
Module.exports = CompiledModule.exports;
Module.customSections = CompiledModule.customSections;
WebAssembly.Module = Module;
WebAssembly.compile = async () => { throw disallowed(); };
WebAssembly.compileStreaming = async () => { throw disallowed(); };
WebAssembly.instantiateStreaming = async () => { throw disallowed(); };
WebAssembly.instantiate = (source, imports) =>
  source instanceof CompiledModule ? instantiate(source, imports) : Promise.reject(disallowed());

globalThis.self = globalThis;
globalThis.WorkerGlobalScope = class WorkerGlobalScope {};
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
${RENDER}
`;

function render(entryPath: string, script: string): { status: number; signature: number[] } {
  const scriptPath = path.join(path.dirname(entryPath), `render-${copyCount++}.mjs`);
  fs.writeFileSync(scriptPath, script);
  const output = execFileSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: { ...process.env, OG_ENTRY: pathToFileURL(entryPath).href },
    timeout: 60_000,
  });
  return JSON.parse(output);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("@vercel/og HarfBuzz compatibility", () => {
  it("renders with the Worker bundle under workerd's runtime restrictions", () => {
    const root = path.join(tmpRoot, "workerd-project");
    const installedFiles = fs.readdirSync(ogDistDir);
    const result = createTransform("build", root)(fs.readFileSync(edgeEntry, "utf8"), edgeEntry);
    expect(result).not.toBeNull();

    const callbackImports = [
      ...result!.code.matchAll(/from "([^"]*harfbuzz-callback-\w+\.wasm)\?module"/g),
    ];
    expect(callbackImports.length).toBeGreaterThan(0);
    for (const [, file] of callbackImports) {
      expect(path.dirname(file)).toBe(
        path.join(root, ".vinext", "og-assets").replaceAll("\\", "/"),
      );
    }
    expect(fs.readdirSync(ogDistDir)).toEqual(installedFiles);

    const rendered = render(writeOgCopy("index.edge.js", result!.code), WORKERD_SIMULATION);
    expect(rendered.status).toBe(200);
    expect(rendered.signature).toEqual(PNG_SIGNATURE);
  });

  it("tolerates cosmetic changes to the bundled glue", () => {
    // Formatting and esbuild's collision renames shift between releases; none
    // of them may affect where the transform patches.
    const mutated = fs
      .readFileSync(edgeEntry, "utf8")
      .replaceAll("module2", "compiledCallbackModule")
      .replaceAll('Module["instantiateWasm"]', "Module.instantiateWasm")
      .replaceAll("self.location.href", "self.location.href.toString()")
      .replace(
        /module\.exports = new Promise\(function\(resolve, reject\) \{\s*hb\(\)\.then\(\(instance\) => \{\s*resolve\(hbjs\(instance\)\);\s*\}, reject\);\s*\}\);/,
        "module.exports = hb().then(hbjs);",
      );
    const result = createTransform("build", path.join(tmpRoot, "mutated-project"))(
      mutated,
      edgeEntry,
    );

    const rendered = render(writeOgCopy("index.edge.js", result!.code), WORKERD_SIMULATION);
    expect(rendered.signature).toEqual(PNG_SIGNATURE);
  });

  it("renders with the Node bundle in dev without writing to the OG package", () => {
    const installedFiles = fs.readdirSync(ogDistDir);
    const result = createTransform("serve", tmpRoot)(fs.readFileSync(nodeEntry, "utf8"), nodeEntry);
    expect(result).not.toBeNull();

    const entryPath = writeOgCopy("index.node.js", result!.code);
    expect(fs.existsSync(path.join(path.dirname(entryPath), "hb.wasm"))).toBe(false);
    expect(render(entryPath, RENDER).signature).toEqual(PNG_SIGNATURE);
    expect(fs.readdirSync(ogDistDir)).toEqual(installedFiles);
  });

  it("reads hb.wasm beside the built Node output", () => {
    const result = createTransform("build", tmpRoot)(fs.readFileSync(nodeEntry, "utf8"), nodeEntry);
    expect(result!.code).toContain('new URL("./hb.wasm", import.meta.url)');
    expect(result!.code).not.toContain(harfbuzzWasmPath);

    const entryPath = writeOgCopy("index.node.js", result!.code, { "hb.wasm": harfbuzzWasmPath });
    expect(render(entryPath, RENDER).signature).toEqual(PNG_SIGNATURE);
  });

  it("leaves yoga's instantiateWasm hook alone", () => {
    const result = createTransform("build", tmpRoot)(fs.readFileSync(edgeEntry, "utf8"), edgeEntry);
    expect(result!.code).toContain("t.instantiateWasm");
  });

  it("fails the build when the HarfBuzz factory no longer matches", () => {
    const code = fs
      .readFileSync(nodeEntry, "utf8")
      .replaceAll('Module["instantiateWasm"]', "Module.loader");
    expect(() => createTransform("build", tmpRoot)(code, nodeEntry)).toThrow(
      /Unsupported @vercel\/og HarfBuzz bundle .*names "hb\.wasm" and reads instantiateWasm, found 0/,
    );
  });

  it("fails the build when the environment detection no longer matches", () => {
    const code = fs.readFileSync(nodeEntry, "utf8").replaceAll("ENVIRONMENT_IS_NODE", "IS_NODE");
    expect(() => createTransform("build", tmpRoot)(code, nodeEntry)).toThrow(
      /does not declare ENVIRONMENT_IS_NODE/,
    );
  });
});

describe("HarfBuzz callback adapters", () => {
  const signatures = readWasmFunctionSignatures(fs.readFileSync(harfbuzzWasmPath));

  it("cover every callback signature harfbuzzjs registers", () => {
    // harfbuzzjs's `p` (pointer) is an i32 on wasm32.
    const registered = [
      ...fs
        .readFileSync(nodeEntry, "utf8")
        .matchAll(/addFunction\([\s\S]{0,4000}?,\s*"([vipjfd]+)"\)/g),
    ].map(([, signature]) => signature.replaceAll("p", "i"));
    expect(registered.length).toBeGreaterThan(0);
    for (const signature of registered) expect(signatures).toContain(signature);
  });

  it("are valid one-function modules that import e.f and export f", () => {
    for (const signature of signatures) {
      const module = new WebAssembly.Module(createHarfbuzzCallbackWasm(signature));
      expect(WebAssembly.Module.imports(module)).toEqual([
        { module: "e", name: "f", kind: "function" },
      ]);
      expect(WebAssembly.Module.exports(module)).toEqual([{ name: "f", kind: "function" }]);
    }
  });

  it("rejects signatures WASM cannot express", () => {
    expect(() => createHarfbuzzCallbackWasm("iv")).toThrow(/Invalid WASM callback signature/);
    expect(() => createHarfbuzzCallbackWasm("ix")).toThrow(/Invalid WASM callback signature/);
  });
});
