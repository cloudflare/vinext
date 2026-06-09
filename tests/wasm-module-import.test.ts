/**
 * Unit tests for the `vinext:wasm-module-import` plugin.
 *
 * Covers issue #1351: `import x from '*.wasm?module'` in edge routes and
 * middleware should work in non-Cloudflare (plain Node.js) builds.
 *
 * The plugin intercepts `.wasm?module` imports, reads the WASM bytes, and
 * exports a compiled `WebAssembly.Module` via inlined base64.  It is a no-op
 * when `@cloudflare/vite-plugin` is present (that plugin handles ?module for
 * worker environments itself).
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import type { Plugin } from "vite-plus";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── Helpers ───────────────────────────────────────────────────

function unwrapHook(hook: unknown): (...args: unknown[]) => unknown {
  if (typeof hook === "function") return hook as (...args: unknown[]) => unknown;
  if (hook && typeof hook === "object" && "handler" in hook) {
    return (hook as { handler: (...args: unknown[]) => unknown }).handler;
  }
  throw new Error(`Cannot unwrap hook: ${JSON.stringify(hook)}`);
}

function findPlugin(name: string): Plugin {
  const plugins = vinext() as Plugin[];
  const plugin = plugins.find((p) => p.name === name);
  if (!plugin) throw new Error(`Plugin '${name}' not found in vinext() output`);
  return plugin;
}

// ── Fixture setup ─────────────────────────────────────────────

/**
 * Minimal valid WASM binary: the "add one" module used by the
 * edge-can-use-wasm-files Next.js test fixture.
 *
 * Exports: add_one(i32) -> i32, returns input + 1.
 * Taken from test/e2e/edge-can-use-wasm-files/add.wasm in the Next.js repo.
 */
const MINIMAL_WASM = Buffer.from(
  "0061736d0100000001090260000060017f017f03030200010405017001010105030100100619037f01418080c0000b7f00418080c0000b7f00418080c0000b072f04066d656d6f727902000b5f5f686561705f6261736503010a5f5f646174615f656e640302076164645f6f6e6500010a0c0202000b0700200041016a0b",
  "hex",
);

let tmpDir: string;
let wasmFilePath: string;

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-wasm-module-test-"));
  wasmFilePath = path.join(tmpDir, "add.wasm");
  await fsp.writeFile(wasmFilePath, MINIMAL_WASM);
});

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────

describe("vinext:wasm-module-import plugin", () => {
  it("is present in the vinext() plugin array", () => {
    const plugin = findPlugin("vinext:wasm-module-import");
    expect(plugin.name).toBe("vinext:wasm-module-import");
    expect(plugin.enforce).toBe("pre");
  });

  describe("load hook", () => {
    it("emits base64-inlined WebAssembly.compile() for a valid .wasm file", () => {
      const plugin = findPlugin("vinext:wasm-module-import");
      const load = unwrapHook(plugin.load);

      const virtualId = `\0vinext-wasm-module:${wasmFilePath}`;
      const result = load.call(plugin, virtualId) as string;

      expect(typeof result).toBe("string");

      // Must contain the inlined base64 of our WASM bytes.
      const expected64 = MINIMAL_WASM.toString("base64");
      expect(result).toContain(JSON.stringify(expected64));

      // Must compile from the buffer.
      expect(result).toContain("WebAssembly.compile");
      expect(result).toContain("atob(");

      // Must use top-level await (ESM-safe).
      expect(result).toMatch(/export default await WebAssembly\.compile/);
    });

    it("uses atob() rather than Buffer (universally available)", () => {
      const plugin = findPlugin("vinext:wasm-module-import");
      const load = unwrapHook(plugin.load);

      const result = load.call(plugin, `\0vinext-wasm-module:${wasmFilePath}`) as string;
      // atob() works on Node 16+, browsers, and workerd.
      expect(result).toContain("atob(");
      // Buffer is Node-only — must not appear.
      expect(result).not.toContain("Buffer.from");
    });

    it("throws when the WASM file does not exist", () => {
      const plugin = findPlugin("vinext:wasm-module-import");
      const load = unwrapHook(plugin.load);

      const fakeCtx = {
        error: (msg: string) => {
          throw new Error(msg);
        },
      };

      expect(() => {
        load.call(fakeCtx, `\0vinext-wasm-module:${path.join(tmpDir, "nonexistent.wasm")}`);
      }).toThrow(/Could not read WASM file/);
    });

    it("reads the actual file bytes without modifying them", () => {
      const plugin = findPlugin("vinext:wasm-module-import");
      const load = unwrapHook(plugin.load);

      const result = load.call(plugin, `\0vinext-wasm-module:${wasmFilePath}`) as string;

      // Decode the emitted base64 and compare to original bytes.
      const b64Match = result.match(/"([A-Za-z0-9+/]+=*?)"/);
      expect(b64Match).not.toBeNull();
      const decoded = Buffer.from(b64Match![1]!, "base64");
      expect(decoded).toEqual(MINIMAL_WASM);
    });
  });
});

// ── Integration smoke-test ─────────────────────────────────────

describe("vinext:wasm-module-import end-to-end (Node.js WebAssembly)", () => {
  it("the emitted base64 + WebAssembly.compile() chain produces a working module", async () => {
    const plugin = findPlugin("vinext:wasm-module-import");
    const load = unwrapHook(plugin.load);

    const result = load.call(plugin, `\0vinext-wasm-module:${wasmFilePath}`) as string;

    // Extract the base64 payload from the generated code and exercise the
    // full compile → instantiate → call chain in-process (no dynamic import
    // needed — we're testing the WASM compilation logic, not ESM evaluation).
    const b64Match = result.match(/"([A-Za-z0-9+/]+=*?)"/);
    expect(b64Match).not.toBeNull();
    const buf = Uint8Array.from(atob(b64Match![1]!), (c) => c.charCodeAt(0));

    // Compile the bytes into a WebAssembly.Module.
    const mod = await WebAssembly.compile(buf.buffer);
    expect(mod).toBeInstanceOf(WebAssembly.Module);

    // Instantiate with a pre-compiled Module — returns an Instance directly.
    // (Contrast with instantiate(bytes) which returns {module, instance}.)
    const instance = await WebAssembly.instantiate(mod, {});
    const addOne = instance.exports["add_one"] as CallableFunction;
    expect(addOne(10)).toBe(11);
    expect(addOne(0)).toBe(1);
  });
});
