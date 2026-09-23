import { describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createOgHarfbuzzPlugin } from "../packages/vinext/src/plugins/og-harfbuzz.js";

const require = createRequire(path.join(import.meta.dirname, "../packages/vinext/package.json"));
const nodeEntry = require.resolve("@vercel/og");
const edgeEntry = path.join(path.dirname(nodeEntry), "index.edge.js");
const transform = createOgHarfbuzzPlugin().transform as {
  handler: (code: string, id: string) => { code: string } | null;
};

describe("@vercel/og HarfBuzz compatibility", () => {
  it("precompiles callback adapters for the Worker runtime", () => {
    const result = transform.handler(fs.readFileSync(edgeEntry, "utf8"), edgeEntry);
    expect(result).not.toBeNull();
    const code = result!.code;
    expect(code).toContain("!ENVIRONMENT_IS_WORKER");
    expect(code).toContain('self.location?.href || ""');
    expect(code).toContain("__vi_hb_bridges[sig] || new WebAssembly.Module(bytes)");
    expect(code).toContain("module.exports = __vi_hb_mod.then(function(mod)");

    const adapters = [...code.matchAll(/from "\.\/(hb-bridge-[\w]+\.wasm)\?module"/g)];
    expect(adapters.length).toBeGreaterThan(0);
    for (const [, filename] of adapters) {
      expect(
        WebAssembly.validate(fs.readFileSync(path.join(path.dirname(edgeEntry), filename))),
      ).toBe(true);
    }
  });

  it("provides Node ESM globals and a disk-read WASM fallback", () => {
    const result = transform.handler(fs.readFileSync(nodeEntry, "utf8"), nodeEntry);
    expect(result).not.toBeNull();
    expect(result!.code).toContain(
      'import { createRequire as __vi_createRequire } from "node:module"',
    );
    expect(result!.code).not.toContain('import("./hb.wasm?module")');
    expect(result!.code).toContain('import("node:fs/promises")');
    expect(fs.readFileSync(path.join(path.dirname(nodeEntry), "hb.wasm"))).toEqual(
      fs.readFileSync(
        createRequire(createRequire(nodeEntry).resolve("satori")).resolve("harfbuzzjs/hb.wasm"),
      ),
    );
  });
});
