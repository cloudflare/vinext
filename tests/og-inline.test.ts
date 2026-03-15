import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import type { Plugin } from "vite-plus";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── Helpers ───────────────────────────────────────────────────

/** Unwrap a Vite plugin hook that may use the object-with-filter format */
function unwrapHook(hook: any): Function {
  return typeof hook === "function" ? hook : hook?.handler;
}

/**
 * Create a fresh vinext:og-inline-fetch-assets plugin instance.
 * Each call gets an independent cache so tests do not share state.
 */
function createOgInlinePlugin(command: "serve" | "build" = "serve"): Plugin {
  const plugins = vinext() as Plugin[];
  const plugin = plugins.find((p) => p.name === "vinext:og-inline-fetch-assets");
  if (!plugin) throw new Error("vinext:og-inline-fetch-assets plugin not found");
  const configResolved = unwrapHook(plugin.configResolved);
  configResolved?.call(plugin, { command });
  return plugin;
}

// ── Test fixture setup ────────────────────────────────────────

let tmpDir: string;
const fontContent = Buffer.from("fake-font-data-for-testing");
const fontBase64 = fontContent.toString("base64");

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "og-inline-test-"));
  await fsp.writeFile(path.join(tmpDir, "noto-sans.ttf"), fontContent);
});

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────

describe("vinext:og-inline-fetch-assets plugin", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exists in the plugin array", () => {
    const plugin = createOgInlinePlugin();
    expect(plugin.name).toBe("vinext:og-inline-fetch-assets");
    expect(plugin.enforce).toBe("pre");
  });

  // ── Guard clause ──────────────────────────────────────────

  it("returns null when code has no import.meta.url", async () => {
    const plugin = createOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import fs from 'node:fs';\nconst x = 1;`;
    const result = await transform.call(plugin, code, "/app/og.tsx");
    expect(result).toBeNull();
  });

  // ── Pattern 1: fetch ─────────────────────────────────────

  it("transforms fetch(new URL(..., import.meta.url)).then(r => r.arrayBuffer())", async () => {
    const plugin = createOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./noto-sans.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const moduleId = path.join(tmpDir, "og.tsx");

    const result = await transform.call(plugin, code, moduleId);
    expect(result).not.toBeNull();
    expect(result.code).toContain(JSON.stringify(fontBase64));
    expect(result.code).toContain("Promise.resolve(a.buffer)");
    expect(result.code).not.toContain("fetch(");
  });

  // ── Pattern 2: readFileSync ──────────────────────────────

  it("transforms fs.readFileSync(fileURLToPath(new URL(..., import.meta.url)))", async () => {
    const plugin = createOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `const buf = fs.readFileSync(fileURLToPath(new URL("./noto-sans.ttf", import.meta.url)));`;
    const moduleId = path.join(tmpDir, "og.tsx");

    const result = await transform.call(plugin, code, moduleId);
    expect(result).not.toBeNull();
    expect(result.code).toContain(`Buffer.from(${JSON.stringify(fontBase64)},"base64")`);
    expect(result.code).not.toContain("readFileSync");
  });

  // ── File not found ───────────────────────────────────────

  it("silently skips when the referenced file does not exist", async () => {
    const plugin = createOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./nonexistent.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const moduleId = path.join(tmpDir, "og.tsx");

    const result = await transform.call(plugin, code, moduleId);
    // No file found → no replacement → returns null
    expect(result).toBeNull();
  });

  // ── Async assertion ──────────────────────────────────────

  it("returns a Promise (hook is async)", () => {
    const plugin = createOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./noto-sans.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const moduleId = path.join(tmpDir, "og.tsx");

    const result = transform.call(plugin, code, moduleId);
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  // ── Build cache hit ──────────────────────────────────────

  it("reads the file only once for repeated build transforms (cache hit)", async () => {
    const readFileSpy = vi.spyOn(fs.promises, "readFile");

    const plugin = createOgInlinePlugin("build");
    const transform = unwrapHook(plugin.transform);
    const code = `const buf = fs.readFileSync(fileURLToPath(new URL("./noto-sans.ttf", import.meta.url)));`;
    const moduleId = path.join(tmpDir, "og.tsx");

    // First call — should read from disk
    await transform.call(plugin, code, moduleId);

    // Second call — should use cache
    await transform.call(plugin, code, moduleId);

    // Exactly once: first call reads from disk, second call hits the build cache.
    const calls = readFileSpy.mock.calls.filter(
      (call) => call[0] === path.join(tmpDir, "noto-sans.ttf"),
    );
    expect(calls.length).toBe(1);
  });

  // ── Dev mode stays fresh ─────────────────────────────────

  it("does not cache asset contents across serve transforms", async () => {
    const devFontPath = path.join(tmpDir, "dev-font.ttf");
    const initialFontBase64 = Buffer.from("dev-font-v1").toString("base64");
    const updatedFontBase64 = Buffer.from("dev-font-v2").toString("base64");
    await fsp.writeFile(devFontPath, Buffer.from("dev-font-v1"));

    const plugin = createOgInlinePlugin("serve");
    const transform = unwrapHook(plugin.transform);
    const code = `const buf = fs.readFileSync(fileURLToPath(new URL("./dev-font.ttf", import.meta.url)));`;
    const moduleId = path.join(tmpDir, "og.tsx");

    const firstResult = await transform.call(plugin, code, moduleId);
    expect(firstResult.code).toContain(
      `Buffer.from(${JSON.stringify(initialFontBase64)},"base64")`,
    );

    await fsp.writeFile(devFontPath, Buffer.from("dev-font-v2"));

    const secondResult = await transform.call(plugin, code, moduleId);
    expect(secondResult.code).toContain(
      `Buffer.from(${JSON.stringify(updatedFontBase64)},"base64")`,
    );
  });
});
