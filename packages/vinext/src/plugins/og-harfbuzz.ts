import fs from "node:fs";
import { createRequire } from "node:module";
import path from "pathslash";
import type { Plugin } from "vite";

function bridgeWasm(signature: string): Uint8Array {
  const typeCodes: Record<string, number> = { i: 127, p: 127, j: 126, f: 125, d: 124, e: 111 };
  const pack = (values: number[]) => [(values.length % 128) | 128, values.length >> 7, ...values];
  const types = (value: string) => pack(value.split("").map((type) => typeCodes[type]));
  const signatureSection = [
    1,
    96,
    ...types(signature.slice(1)),
    ...types(signature[0] === "v" ? "" : signature[0]),
  ];
  return Uint8Array.of(
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    1,
    ...pack(signatureSection),
    2,
    7,
    1,
    1,
    101,
    1,
    102,
    0,
    0,
    7,
    5,
    1,
    1,
    102,
    0,
    0,
  );
}

export function createOgHarfbuzzPlugin(): Plugin {
  return {
    name: "vinext:og-harfbuzz",
    enforce: "pre",
    transform: {
      filter: { id: /@vercel\/og.*index\.(?:edge|node)\.js/ },
      handler(code, id) {
        const initializer = `module.exports = new Promise(function(resolve, reject) {
      hb().then((instance) => {
        resolve(hbjs(instance));
      }, reject);
    });`;
        if (!code.includes(initializer)) return null;

        const require = createRequire(id);
        const distDir = path.dirname(id);
        const harfbuzzPath = createRequire(require.resolve("satori")).resolve("harfbuzzjs/hb.wasm");
        const wasmPath = path.join(distDir, "hb.wasm");
        if (!fs.existsSync(wasmPath)) fs.copyFileSync(harfbuzzPath, wasmPath);

        let patched = code
          .replace("_scriptName = self.location.href;", '_scriptName = self.location?.href || "";')
          .replace(
            'var ENVIRONMENT_IS_NODE = typeof process == "object" && process.versions?.node && process.type != "renderer";',
            'var ENVIRONMENT_IS_NODE = typeof process == "object" && process.versions?.node && process.type != "renderer" && !ENVIRONMENT_IS_WORKER;',
          )
          .replace(
            initializer,
            `module.exports = __vi_hb_mod.then(function(mod) {
      return hb({ instantiateWasm: function(imports, callback) {
        callback(new WebAssembly.Instance(mod, imports));
        return {};
      } }).then(hbjs);
    });`,
          );
        let loader = `var __vi_hb_mod = import("./hb.wasm?module").then(function(m) { return m.default; }).catch(function() {
  return import("node:fs/promises").then(function(fs) {
    return fs.readFile(new URL("./hb.wasm", import.meta.url)).then(function(bytes) { return WebAssembly.compile(bytes); });
  });
});\n`;
        let preamble = "";

        if (id.includes("index.node.js")) {
          loader = `var __vi_hb_mod = import("node:fs/promises").then(function(fs) {
  return fs.readFile(new URL("./hb.wasm", import.meta.url)).then(function(bytes) { return WebAssembly.compile(bytes); });
});\n`;
          preamble = `import { createRequire as __vi_createRequire } from "node:module";
import { dirname as __vi_dirname } from "node:path";
import { fileURLToPath as __vi_fileURLToPath } from "node:url";
var require = __vi_createRequire(import.meta.url);
var __dirname = __vi_dirname(__vi_fileURLToPath(import.meta.url));\n`;
        } else {
          const signatures = [
            ...new Set(
              [...code.matchAll(/(?:\}|\w+)\s*,\s*"([vipjfde]+)"\);/g)].map((match) => match[1]),
            ),
          ];
          const imports = signatures.map((signature, index) => {
            const filename = `hb-bridge-${signature}.wasm`;
            const filePath = path.join(distDir, filename);
            if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, bridgeWasm(signature));
            return `import __vi_hb_bridge_${index} from "./${filename}?module";`;
          });
          preamble = `${imports.join("\n")}\nvar __vi_hb_bridges = { ${signatures
            .map((signature, index) => `${JSON.stringify(signature)}: __vi_hb_bridge_${index}`)
            .join(", ")} };\n`;
          patched = patched.replace(
            "var module2 = new WebAssembly.Module(bytes);",
            "var module2 = __vi_hb_bridges[sig] || new WebAssembly.Module(bytes);",
          );
        }

        return { code: preamble + loader + patched, map: null };
      },
    },
  };
}
