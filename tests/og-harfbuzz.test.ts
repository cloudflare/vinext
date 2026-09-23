import { afterAll, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  createOgHarfbuzzPlugin,
  resolveHarfbuzzWasmPath,
} from "../packages/vinext/src/plugins/og-harfbuzz.js";

const require = createRequire(path.join(import.meta.dirname, "../packages/vinext/package.json"));
const nodeEntry = require.resolve("@vercel/og");
const edgeEntry = path.join(path.dirname(nodeEntry), "index.edge.js");
const generatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-og-harfbuzz-"));
const plugin = createOgHarfbuzzPlugin();
(plugin.configResolved as (config: { root: string }) => void)({ root: generatedRoot });
const transform = plugin.transform as {
  handler: (code: string, id: string) => { code: string } | null;
};

afterAll(() => fs.rmSync(generatedRoot, { recursive: true, force: true }));

describe("@vercel/og HarfBuzz compatibility", () => {
  it("precompiles callback adapters for the Worker runtime", () => {
    const installedFiles = fs.readdirSync(path.dirname(edgeEntry));
    const result = transform.handler(fs.readFileSync(edgeEntry, "utf8"), edgeEntry);
    expect(result).not.toBeNull();
    const code = result!.code;
    expect(code).toContain("!ENVIRONMENT_IS_WORKER");
    expect(code).toContain('self.location?.href || ""');
    expect(code).toContain("__vi_hb_bridges[sig] || new WebAssembly.Module(bytes)");
    expect(code).toContain("module.exports = __vi_hb_mod.then(function(mod)");

    expect(code).toContain(`${resolveHarfbuzzWasmPath(edgeEntry)}?module`);
    const adapters = [...code.matchAll(/from "([^"]*hb-bridge-[\w]+\.wasm)\?module"/g)];
    expect(adapters.length).toBeGreaterThan(0);
    for (const [, filePath] of adapters) {
      expect(path.dirname(filePath)).toBe(path.join(generatedRoot, ".vinext", "og-assets"));
      expect(WebAssembly.validate(fs.readFileSync(filePath))).toBe(true);
    }
    expect(fs.readdirSync(path.dirname(edgeEntry))).toEqual(installedFiles);
  });

  it("provides Node ESM globals and a disk-read WASM fallback", () => {
    const installedFiles = fs.readdirSync(path.dirname(nodeEntry));
    const result = transform.handler(fs.readFileSync(nodeEntry, "utf8"), nodeEntry);
    expect(result).not.toBeNull();
    expect(result!.code).toContain(
      'import { createRequire as __vi_createRequire } from "node:module"',
    );
    expect(result!.code).not.toContain('import("./hb.wasm?module")');
    expect(result!.code).toContain('import("node:fs/promises")');
    expect(fs.readdirSync(path.dirname(nodeEntry))).toEqual(installedFiles);
  });
});
