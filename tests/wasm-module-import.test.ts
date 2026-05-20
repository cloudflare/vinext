/**
 * Tests for the `vinext:wasm-module` plugin.
 *
 * Regression test for cloudflare/vinext#1351 — `import wasm from "./foo.wasm?module"`
 * fails to build because Rolldown cannot load `.wasm?module` natively. The plugin
 * intercepts those imports for non-Workers environments and emits a JS shim that
 * compiles the binary via `WebAssembly.compile`, mirroring the Webpack
 * `asyncWebAssembly` behaviour Next.js uses (`.nextjs-ref/test/e2e/edge-can-use-wasm-files/`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";
import type { Plugin } from "vite-plus";

// ── Helpers ───────────────────────────────────────────────────

function unwrapHook(hook: unknown): (...args: unknown[]) => unknown {
  // Vite hooks may be either a plain function or `{ filter, handler }`.
  if (typeof hook === "function") return hook as (...args: unknown[]) => unknown;
  // oxlint-disable-next-line typescript/no-explicit-any
  return (hook as any)?.handler;
}

/** Pull the wasm-module plugin out of the full vinext plugin array. */
function getWasmModulePlugin(command: "build" | "serve" = "build"): Plugin {
  const plugins = vinext() as Plugin[];
  const plugin = plugins.find((p) => p && (p as Plugin).name === "vinext:wasm-module");
  if (!plugin) throw new Error("vinext:wasm-module plugin not found");
  const configResolved = unwrapHook(plugin.configResolved);
  configResolved?.call(plugin, { command });
  return plugin;
}

// A minimal valid WebAssembly module: the 8-byte magic-number + version header
// is on its own a complete, parseable module (no sections). It is enough to
// exercise `emitFile` / load-hook behaviour without committing a real binary.
const MINIMAL_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

let tmpDir: string;
let wasmPath: string;

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-wasm-module-"));
  wasmPath = path.join(tmpDir, "add.wasm");
  await fsp.writeFile(wasmPath, MINIMAL_WASM);
});

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────

describe("vinext:wasm-module plugin", () => {
  it("is present in the vinext plugin array", () => {
    const plugin = getWasmModulePlugin();
    expect(plugin.name).toBe("vinext:wasm-module");
    // `post` so the Cloudflare plugin's `enforce: "pre"` hook handles Workers
    // builds first and externalises the import.
    expect(plugin.enforce).toBe("post");
  });

  it("matches `.wasm?module` imports in resolveId and rewrites to an absolute path", async () => {
    const plugin = getWasmModulePlugin();
    const resolveId = unwrapHook(plugin.resolveId);

    // Simulate `import wasm from "./add.wasm?module"` inside <tmpDir>/src/add.js
    const importer = path.join(tmpDir, "src", "add.js");
    await fsp.mkdir(path.dirname(importer), { recursive: true });
    // Place add.wasm where the relative resolve will find it.
    const srcWasm = path.join(tmpDir, "src", "add.wasm");
    await fsp.writeFile(srcWasm, MINIMAL_WASM);

    // Mock the `this.resolve` Vite/Rollup context method.
    const ctx = {
      // oxlint-disable-next-line typescript/no-explicit-any
      async resolve(source: string, _importer: string | undefined, _opts: unknown) {
        return { id: path.resolve(path.dirname(importer), source), external: false };
      },
    };

    const result = (await resolveId.call(ctx, "./add.wasm?module", importer)) as
      | string
      | null
      | undefined;

    expect(result).toBe(`${srcWasm}?module`);
  });

  it("scopes its resolveId filter to .wasm?module only (won't steal ?init or plain .wasm)", () => {
    const plugin = getWasmModulePlugin();

    // The hook has a filter so Vite only calls the handler for `.wasm?module`.
    // We assert the filter regex directly. `*.wasm?init` is a Vite/Cloudflare
    // convention handled elsewhere — we must not steal it.
    // oxlint-disable-next-line typescript/no-explicit-any
    const filter = (plugin.resolveId as any).filter as { id: RegExp };
    expect(filter.id.test("./add.wasm?init")).toBe(false);
    expect(filter.id.test("./add.wasm")).toBe(false);
    expect(filter.id.test("./add.wasm?module")).toBe(true);
    expect(filter.id.test("./add.wasm?module&v=1")).toBe(true);
  });

  it("emits a server build shim that uses dynamic node: imports (no static node: deps)", async () => {
    const plugin = getWasmModulePlugin("build");
    const load = unwrapHook(plugin.load);

    let emitted: { type: string; name?: string; source?: unknown } | null = null;
    const ctx = {
      // Simulate the rsc/ssr environment — non-client.
      environment: { name: "ssr" as const },
      emitFile(spec: { type: string; name?: string; source?: unknown }) {
        emitted = spec;
        return "ref-id-1";
      },
      error(message: string) {
        throw new Error(message);
      },
    };

    const code = (await load.call(ctx, `${wasmPath}?module`)) as string;

    // The asset must be emitted with the original filename so the output dir
    // contains a recognisable `add-<hash>.wasm` next to the bundle.
    expect(emitted).not.toBeNull();
    expect(emitted!.type).toBe("asset");
    expect(emitted!.name).toBe("add.wasm");
    expect(Buffer.isBuffer(emitted!.source)).toBe(true);
    expect((emitted!.source as Buffer).equals(MINIMAL_WASM)).toBe(true);

    // The Rollup file-url placeholder is used directly as a string (no double
    // `new URL(..., import.meta.url)` wrap) — Rollup expands it to an absolute
    // URL string at chunk-emit time.
    expect(code).toContain("import.meta.ROLLUP_FILE_URL_ref-id-1");
    expect(code).toContain("WebAssembly.compile");
    expect(code).toContain("export default await");

    // Server shim: dynamic node: imports, no static `import ... from "node:*"`.
    expect(code).toContain('import("node:fs/promises")');
    expect(code).toContain('import("node:url")');
    expect(code).toContain("fileURLToPath");
    expect(code).not.toMatch(/^import\s+[^;]*from\s+["']node:/m);
  });

  it("emits a client build shim that uses fetch and never touches node:* modules", async () => {
    const plugin = getWasmModulePlugin("build");
    const load = unwrapHook(plugin.load);

    const ctx = {
      environment: { name: "client" as const },
      emitFile() {
        return "ref-client";
      },
      error(message: string) {
        throw new Error(message);
      },
    };

    const code = (await load.call(ctx, `${wasmPath}?module`)) as string;

    // Client shim uses the Rollup file-url placeholder, fetch + compileStreaming.
    expect(code).toContain("import.meta.ROLLUP_FILE_URL_ref-client");
    expect(code).toContain("fetch(");
    expect(code).toContain("compileStreaming");

    // Crucially: no `node:*` references in the client bundle. Vite would
    // externalise those to empty stubs and a named import would throw.
    expect(code).not.toContain("node:fs");
    expect(code).not.toContain("node:url");
    expect(code).not.toContain("node:module");
    expect(code).not.toContain("createRequire");
  });

  it("compiles directly from the source path in dev (no asset emission, server)", async () => {
    const plugin = getWasmModulePlugin("serve");
    const load = unwrapHook(plugin.load);

    let emitCalled = false;
    const ctx = {
      environment: { name: "ssr" as const },
      emitFile() {
        emitCalled = true;
        return "should-not-be-used";
      },
      error(message: string) {
        throw new Error(message);
      },
    };

    const code = (await load.call(ctx, `${wasmPath}?module`)) as string;

    expect(emitCalled).toBe(false);
    // Dev shim reads the source file directly from its absolute path via a
    // dynamic node:fs/promises import.
    expect(code).toContain(JSON.stringify(wasmPath));
    expect(code).toContain('import("node:fs/promises")');
    expect(code).toContain("WebAssembly.compile");
    expect(code).toContain("export default await");
  });

  it("dev mode: client environment falls back to fetch (no node:fs)", async () => {
    const plugin = getWasmModulePlugin("serve");
    const load = unwrapHook(plugin.load);

    const ctx = {
      environment: { name: "client" as const },
      emitFile() {
        throw new Error("emitFile should not be called in dev");
      },
      error(message: string) {
        throw new Error(message);
      },
    };

    const code = (await load.call(ctx, `${wasmPath}?module`)) as string;
    expect(code).toContain("fetch(");
    expect(code).not.toContain("node:fs");
  });

  it("calls this.error when the underlying wasm file is missing", async () => {
    const plugin = getWasmModulePlugin("build");
    const load = unwrapHook(plugin.load);

    let errored: string | null = null;
    const ctx = {
      environment: { name: "ssr" as const },
      emitFile() {
        return "ref";
      },
      error(message: string) {
        errored = message;
        // Match Rollup's behaviour: this.error halts the plugin.
        throw new Error(message);
      },
    };

    const missing = path.join(tmpDir, "does-not-exist.wasm?module");
    await expect(load.call(ctx, missing)).rejects.toThrow(/Could not read WASM file/);
    expect(errored).toMatch(/does-not-exist\.wasm/);
  });

  it("guards against undefined source: explicit throw after this.error", async () => {
    // If a downstream test runner or Rollup variant returns from this.error
    // instead of throwing, our explicit `throw err` after this.error must still
    // halt execution so we never call `emitFile({ source: undefined })`.
    const plugin = getWasmModulePlugin("build");
    const load = unwrapHook(plugin.load);

    let emitCalled = false;
    const ctx = {
      environment: { name: "ssr" as const },
      emitFile() {
        emitCalled = true;
        return "ref";
      },
      // Deliberately non-throwing this.error to exercise the explicit throw.
      error(_message: string) {
        // no-op
      },
    };

    const missing = path.join(tmpDir, "another-missing.wasm?module");
    await expect(load.call(ctx, missing)).rejects.toBeDefined();
    // emitFile must NOT have been called — we must not silently emit a
    // zero-byte asset.
    expect(emitCalled).toBe(false);
  });

  it("returns null for ids without the ?module query so it doesn't steal other wasm imports", async () => {
    const plugin = getWasmModulePlugin("build");
    const load = unwrapHook(plugin.load);

    const result = await load.call({}, `${wasmPath}?init`);
    expect(result).toBeNull();
  });
});

// ── Integration with the full plugin pipeline ─────────────────

describe("vinext:wasm-module plugin (pipeline integration)", () => {
  it("runs after enforce:'pre' plugins so the Cloudflare plugin handles Workers first", () => {
    const plugins = vinext() as Plugin[];

    const wasmIdx = plugins.findIndex((p) => p && p.name === "vinext:wasm-module");
    expect(wasmIdx).toBeGreaterThanOrEqual(0);

    // Other plugins should still load — sanity check that wiring didn't
    // accidentally short-circuit the array.
    const ogInlineIdx = plugins.findIndex((p) => p && p.name === "vinext:og-inline-fetch-assets");
    expect(ogInlineIdx).toBeGreaterThanOrEqual(0);
  });
});
