/**
 * Node.js ESM loader hook for `.wasm` files.
 *
 * The Cloudflare worker build emits native CF WASM module import syntax:
 *   import resvg_wasm from "./resvg-Cjh1zH0p.wasm";
 *
 * In Cloudflare Workers the runtime binds the WASM file as a WebAssembly.Module.
 * Node.js with --experimental-wasm-modules instead tries to instantiate the WASM
 * and resolve its imports (e.g. "wbg") as Node packages, which fails.
 *
 * This hook intercepts any .wasm URL and returns a synthetic ES module whose
 * default export is `new WebAssembly.Module(bytes)` — the same thing CF provides.
 * The wasm-bindgen glue in worker-entry already has all the wbg imports inline
 * via getImports(), so instantiation succeeds once the Module is available.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function resolve(
  specifier: string,
  context: { parentURL?: string },
  nextResolve: (s: string, c: object) => Promise<{ url: string; format?: string }>
) {
  if (specifier.endsWith(".wasm")) {
    return nextResolve(specifier, context).then((result) => ({
      ...result,
      format: "vinext-wasm",
    }));
  }
  return nextResolve(specifier, context);
}

export async function load(
  url: string,
  context: { format?: string },
  nextLoad: (u: string, c: object) => Promise<{ source: string | Uint8Array; format: string }>
) {
  if (context.format === "vinext-wasm") {
    const filePath = fileURLToPath(url);
    const bytes = readFileSync(filePath);
    // Return a JS module whose default export is the compiled WebAssembly.Module.
    // We embed the bytes as a base64 literal so the hook is self-contained.
    const b64 = bytes.toString("base64");
    const source = `
const bytes = Buffer.from("${b64}", "base64");
const wasmModule = new WebAssembly.Module(bytes);
export default wasmModule;
`;
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
