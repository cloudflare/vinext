import fs from "node:fs";
import path from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

const WASM_MODULE_PREFIX = "\0vinext-wasm-module:";
const WASM_MODULE_QUERY_RE = /\.wasm\?module(?:$|[&#])/;

export function isWasmModuleRequest(id: string): boolean {
  return WASM_MODULE_QUERY_RE.test(id);
}

export function stripWasmModuleQuery(id: string): string {
  return id.replace(/\?module(?:$|[&#].*)/, "");
}

export function resolveWasmModuleFile(
  source: string,
  importer: string | undefined,
  root: string,
): string {
  const cleanSource = stripWasmModuleQuery(source.startsWith("\0") ? source.slice(1) : source);
  if (path.isAbsolute(cleanSource)) return path.resolve(cleanSource);

  if (cleanSource.startsWith(".") && importer) {
    const cleanImporter = stripWasmModuleQuery(
      importer.startsWith("\0") ? importer.slice(1) : importer,
    );
    return path.resolve(path.dirname(cleanImporter), cleanSource);
  }

  return path.resolve(root, cleanSource);
}

export function renderWasmModuleCode(bytes: Uint8Array): string {
  const base64 = Buffer.from(bytes).toString("base64");
  return `
const __vinextWasmBase64 = ${JSON.stringify(base64)};
function __vinextDecodeBase64(value) {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  if (typeof Buffer !== "undefined") {
    return Uint8Array.from(Buffer.from(value, "base64"));
  }
  throw new Error("Unable to decode WASM module bytes");
}
export default new WebAssembly.Module(__vinextDecodeBase64(__vinextWasmBase64));
`;
}

export function createWasmModulePlugin(getRoot: () => string): Plugin {
  let config: ResolvedConfig | undefined;

  return {
    name: "vinext:wasm-module",
    enforce: "pre",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    resolveId(source, importer) {
      if (!isWasmModuleRequest(source)) return null;

      // Cloudflare's Vite plugin understands `?module` WASM imports for Workers.
      // Only provide the fallback for plain vinext builds where Vite/Rolldown
      // would otherwise try to load a literal `*.wasm?module` file.
      if (
        config?.plugins.some(
          (plugin) =>
            plugin.name === "vite-plugin-cloudflare" ||
            plugin.name.startsWith("vite-plugin-cloudflare:"),
        )
      ) {
        return null;
      }

      return WASM_MODULE_PREFIX + resolveWasmModuleFile(source, importer, getRoot());
    },
    load(id) {
      if (!id.startsWith(WASM_MODULE_PREFIX)) return null;
      const file = id.slice(WASM_MODULE_PREFIX.length);
      return renderWasmModuleCode(fs.readFileSync(file));
    },
  };
}
