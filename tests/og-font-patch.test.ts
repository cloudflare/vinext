import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createOgAssetsPlugin } from "../packages/vinext/src/plugins/og-assets.js";
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
  fakeOgDistDir = path.posix.join(tmpDir, "node_modules/@vercel/og/dist");
  await fsp.mkdir(fakeOgDistDir, { recursive: true });
  await fsp.writeFile(path.posix.join(fakeOgDistDir, "resvg.wasm"), Buffer.from("fake-resvg-wasm"));
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
        path.posix.join(fakeOgDistDir, "index.edge.js"),
      );
      if (!result) throw new Error("Expected transform to produce output, got null");
      code = result.code;
    });

    // ── Yoga WASM ────────────────────────────────────────────

    describe("yoga WASM", () => {
      it("uses a dynamic import with a catch fallback (avoids load-time crash on Node)", () => {
        expect(code).toContain('import("./yoga.wasm?module")');
        expect(code).toContain(".catch(");
      });

      it("reads yoga.wasm from disk on the Node.js fallback (no base64 inline)", () => {
        // The Node.js fallback (where ?module imports fail) must read the .wasm
        // file from disk and instantiate it — NOT inline a ~95 KiB base64 blob.
        // This keeps exactly one physical copy of the WASM in the output.
        expect(code).not.toContain(FAKE_YOGA_B64);
        expect(code).toContain('new URL("./yoga.wasm", import.meta.url)');
        expect(code).toContain("node:fs");
        expect(code).toContain("WebAssembly.instantiate");
      });

      it("does not reference new URL(yoga.wasm) at top level (workerd compat)", () => {
        // In workerd, import.meta.url is "worker" — a top-level new URL(...) would
        // throw TypeError at module load. The reference must live in the Node.js
        // fallback branch only.
        expect(code).not.toMatch(/^var\s+\w+\s*=\s*new URL\("\.\/yoga\.wasm"/m);
      });

      it("clears the inlined emscripten data URL (avoids loading bytes twice)", () => {
        expect(code).not.toContain("data:application/octet-stream;base64,");
      });
    });

    // ── Resvg WASM ───────────────────────────────────────────

    describe("resvg WASM", () => {
      it("uses a dynamic import with a catch fallback", () => {
        expect(code).toContain('import("./resvg.wasm?module")');
        expect(code).toMatch(/resvg.*\.catch\(/s);
      });

      it("does not use new URL() with import.meta.url at top level (workerd compat)", () => {
        // In workerd, import.meta.url is "worker" — a top-level new URL(...,
        // import.meta.url) would throw TypeError at module load time. Any
        // resolution must happen lazily inside the catch handler.
        expect(code).not.toMatch(/^var\s+\w+\s*=\s*new URL\("\.\/resvg\.wasm"/m);
      });

      it("reads resvg.wasm asynchronously on the Node.js fallback path", () => {
        expect(code).toContain("node:fs");
        expect(code).toContain("promises.readFile");
      });
    });

    // ── Critical invariant ───────────────────────────────────

    it("emits zero static `?module` WASM imports (Node.js can't resolve them)", () => {
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
    const writeDistDir = path.posix.join(tmpDir, "write-test/node_modules/@vercel/og/dist");
    fs.mkdirSync(writeDistDir, { recursive: true });

    const plugin = createOgFontPatchPlugin();
    const transform = unwrapHook(plugin.transform);
    transform.call(
      plugin,
      fakeEdgeEntry(FAKE_YOGA_B64),
      path.posix.join(writeDistDir, "index.edge.js"),
    );

    const yogaPath = path.posix.join(writeDistDir, "yoga.wasm");
    expect(fs.existsSync(yogaPath)).toBe(true);
    expect(fs.readFileSync(yogaPath)).toEqual(Buffer.from(FAKE_YOGA_B64, "base64"));
  });
});

describe("vinext:og-assets plugin", () => {
  it.each([
    ["resvg.wasm", "resvg.Cjh1zH0p.wasm"],
    ["yoga.wasm", "yoga.sbSbVeWy.wasm"],
    ["resvg.wasm", "resvg-legacyhash.wasm"],
  ])("rewrites the %s Node fallback to emitted asset %s", (baseName, emittedName) => {
    const plugin = createOgAssetsPlugin();
    const generateBundle = unwrapHook(plugin.generateBundle);
    const chunk = {
      type: "chunk",
      fileName: "_next/static/index.edge.js",
      code: `const wasm = import("./media/${emittedName}").catch(() => new URL("./${baseName}", import.meta.url));`,
      map: null,
    };
    const emittedFileName = `_next/static/media/${emittedName}`;
    const bundle = {
      [chunk.fileName]: chunk,
      [emittedFileName]: {
        type: "asset",
        fileName: emittedFileName,
      },
    };

    generateBundle.call({ environment: { name: "rsc" } }, {}, bundle);

    // Next.js verifies ImageResponse in the Node runtime and verifies copied
    // WASM/assets in standalone output:
    // https://github.com/vercel/next.js/blob/canary/test/e2e/og-api/index.test.ts
    expect(chunk.code).not.toContain(`new URL("./${baseName}", import.meta.url)`);
    expect(chunk.code).toContain(`new URL("./media/${emittedName}", import.meta.url)`);
  });
});
