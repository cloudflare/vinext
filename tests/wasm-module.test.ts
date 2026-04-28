import { Buffer } from "node:buffer";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  isWasmModuleRequest,
  renderWasmModuleCode,
  resolveWasmModuleFile,
  stripWasmModuleQuery,
} from "../packages/vinext/src/plugins/wasm-module.js";

const emptyWasmModule = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

describe("wasm ?module imports", () => {
  it("matches only Next edge WASM module imports", () => {
    // Ported from Next.js: test/e2e/edge-can-use-wasm-files/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/edge-can-use-wasm-files/index.test.ts
    expect(isWasmModuleRequest("./add.wasm?module")).toBe(true);
    expect(isWasmModuleRequest("./add.wasm?init")).toBe(false);
    expect(isWasmModuleRequest("./add.wasm?url")).toBe(false);
  });

  it("resolves relative wasm module imports against the importer", () => {
    const root = path.resolve("/repo/app");
    const importer = path.join(root, "src/add.js");

    expect(resolveWasmModuleFile("./add.wasm?module", importer, root)).toBe(
      path.join(root, "src/add.wasm"),
    );
    expect(stripWasmModuleQuery("./add.wasm?module")).toBe("./add.wasm");
  });

  it("exports a WebAssembly.Module that can be instantiated", async () => {
    const code = renderWasmModuleCode(emptyWasmModule);
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
    const mod = (await import(moduleUrl)) as { default: WebAssembly.Module };

    expect(mod.default).toBeInstanceOf(WebAssembly.Module);
    await expect(WebAssembly.instantiate(mod.default)).resolves.toBeInstanceOf(
      WebAssembly.Instance,
    );
  });
});
