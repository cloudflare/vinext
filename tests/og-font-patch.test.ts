import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import type { Plugin } from "vite-plus";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── Helpers ───────────────────────────────────────────────────

function unwrapHook(hook: any): Function {
  return typeof hook === "function" ? hook : hook?.handler;
}

function createOgFontPatchPlugin(): Plugin {
  const plugins = vinext() as Plugin[];
  const plugin = plugins.find((p) => p.name === "vinext:og-font-patch");
  if (!plugin) throw new Error("vinext:og-font-patch plugin not found");
  return plugin;
}

// ── Fixture data ──────────────────────────────────────────────

const FAKE_YOGA_B64 = Buffer.from("fake-yoga-wasm-bytes").toString("base64");

/** Minimal simulation of @vercel/og/dist/index.edge.js containing both WASM patterns */
function fakeEdgeEntry(yogaBase64: string): string {
  return [
    `import resvg_wasm from "./resvg.wasm?module";`,
    ``,
    `var h2 = {};`,
    `H = "data:application/octet-stream;base64,${yogaBase64}";`,
    ``,
    `var yoga_wasm_base64_esm_default = loadYoga;`,
    ``,
    `async function loadYoga2() {`,
    `  return wrapAssembly(await yoga_wasm_base64_esm_default());`,
    `}`,
    ``,
    `var initializedResvg = initWasm(resvg_wasm);`,
  ].join("\n");
}

// ── Test fixture setup ────────────────────────────────────────

let tmpDir: string;
let fakeOgDistDir: string;

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "og-font-patch-test-"));
  fakeOgDistDir = path.join(tmpDir, "node_modules/@vercel/og/dist");
  await fsp.mkdir(fakeOgDistDir, { recursive: true });
  await fsp.writeFile(path.join(fakeOgDistDir, "resvg.wasm"), Buffer.from("fake-resvg-wasm"));
});

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────

describe("vinext:og-font-patch plugin", () => {
  it("exists in the plugin array", () => {
    const plugin = createOgFontPatchPlugin();
    expect(plugin.name).toBe("vinext:og-font-patch");
    expect(plugin.enforce).toBe("pre");
  });

  it("returns null for non-@vercel/og modules", () => {
    const plugin = createOgFontPatchPlugin();
    const transform = unwrapHook(plugin.transform);
    expect(transform.call(plugin, "const x = 1;", "/app/page.tsx")).toBeNull();
  });

  it("returns null for @vercel/og/dist/index.node.js", () => {
    const plugin = createOgFontPatchPlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `const x = 1;`;
    expect(transform.call(plugin, code, "/node_modules/@vercel/og/dist/index.node.js")).toBeNull();
  });

  // ── Transform output assertions ────────────────────────────
  // All tests below assert on the same transform output. Run it once.

  describe("edge entry transform", () => {
    let code: string;

    beforeAll(() => {
      const plugin = createOgFontPatchPlugin();
      const transform = unwrapHook(plugin.transform);
      const result = transform.call(
        plugin,
        fakeEdgeEntry(FAKE_YOGA_B64),
        path.join(fakeOgDistDir, "index.edge.js"),
      );
      if (!result) throw new Error("Expected transform to produce output, got null");
      code = result.code;
    });

    // ── Yoga WASM ────────────────────────────────────────────

    describe("yoga WASM", () => {
      it("does NOT produce a static import of yoga.wasm?module", () => {
        expect(code).not.toMatch(/^import\s+\w+\s+from\s+["'].*yoga\.wasm/m);
      });

      it("uses dynamic import with catch fallback", () => {
        expect(code).toContain('import("./yoga.wasm?module")');
        expect(code).toContain(".catch(");
      });

      it("includes inline base64 bytes as Node.js fallback", () => {
        expect(code).toContain(FAKE_YOGA_B64);
        expect(code).toContain("WebAssembly.instantiate");
      });

      it("clears the emscripten data URL", () => {
        expect(code).not.toContain("data:application/octet-stream;base64,");
        expect(code).toContain('H = "";');
      });

      it("patches instantiateWasm with dual-path handler (module vs bytes)", () => {
        expect(code).toContain("instantiateWasm");
        // workerd path: instantiate from pre-compiled module → callback(inst)
        expect(code).toMatch(/WebAssembly\.instantiate\(mod,\s*imports\)/);
        // Node.js path: instantiate from bytes → callback(r.instance)
        expect(code).toMatch(/WebAssembly\.instantiate\(b,\s*imports\)/);
      });

      it("uses Buffer.from directly (no atob — fallback only runs on Node.js)", () => {
        // The catch path (mod === null) only executes on Node.js where Buffer is
        // always available. No need for an atob/Uint8Array browser fallback.
        expect(code).toContain("Buffer.from(__vi_yoga_b64");
        expect(code).not.toContain("atob(");
      });
    });

    // ── Resvg WASM ───────────────────────────────────────────

    describe("resvg WASM", () => {
      it("does NOT produce a static import of resvg.wasm?module", () => {
        expect(code).not.toMatch(/^import\s+\w+\s+from\s+["'].*resvg\.wasm/m);
      });

      it("uses dynamic import with catch fallback", () => {
        expect(code).toContain('import("./resvg.wasm?module")');
        expect(code).toMatch(/resvg.*\.catch\(/s);
      });

      it("uses new URL() inside catch handler, not at top level (workerd compat)", () => {
        // In workerd, import.meta.url is "worker" (not a valid URL base), so
        // top-level new URL() would throw TypeError at module load time.
        expect(code).toContain('new URL("./resvg.wasm"');
        expect(code).not.toMatch(/^var\s+\w+\s*=\s*new URL\("\.\/resvg\.wasm"/m);
      });

      it("reads resvg.wasm asynchronously via fs.promises", () => {
        expect(code).toContain("node:fs");
        expect(code).toContain("promises.readFile");
        expect(code).toContain("WebAssembly.compile");
      });

      it("preserves resvg_wasm variable name for downstream usage", () => {
        expect(code).toContain("initWasm(resvg_wasm)");
      });
    });

    // ── Critical invariant ───────────────────────────────────

    it("output contains zero static WASM module imports", () => {
      const staticWasmImports = code.match(
        /^import\s+\w+\s+from\s+["'][^"']*\.wasm[^"']*["']\s*;?$/gm,
      );
      expect(staticWasmImports).toBeNull();
    });
  });

  // ── Side effect: writes yoga.wasm to disk ──────────────────
  // Separate describe because it needs its own directory to avoid
  // conflicting with the shared transform above.

  it("writes yoga.wasm to disk at transform time", () => {
    const writeDistDir = path.join(tmpDir, "write-test/node_modules/@vercel/og/dist");
    fs.mkdirSync(writeDistDir, { recursive: true });

    const plugin = createOgFontPatchPlugin();
    const transform = unwrapHook(plugin.transform);
    transform.call(plugin, fakeEdgeEntry(FAKE_YOGA_B64), path.join(writeDistDir, "index.edge.js"));

    const yogaPath = path.join(writeDistDir, "yoga.wasm");
    expect(fs.existsSync(yogaPath)).toBe(true);
    expect(fs.readFileSync(yogaPath)).toEqual(Buffer.from(FAKE_YOGA_B64, "base64"));
  });
});
