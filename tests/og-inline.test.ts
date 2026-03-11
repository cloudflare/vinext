import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import vinext from "../packages/vinext/src/index.js";
import type { Plugin } from "vite";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── Helpers ───────────────────────────────────────────────────

/** Unwrap a Vite plugin hook that may use the object-with-filter format */
function unwrapHook(hook: any): Function {
  return typeof hook === "function" ? hook : hook?.handler;
}

/** Extract the vinext:og-inline-fetch-assets plugin from the plugin array */
function getOgInlinePlugin(): Plugin {
  const plugins = vinext() as Plugin[];
  const plugin = plugins.find((p) => p.name === "vinext:og-inline-fetch-assets");
  if (!plugin) throw new Error("vinext:og-inline-fetch-assets plugin not found");
  return plugin;
}

// ── Test fixture setup ────────────────────────────────────────

let tmpDir: string;
let fontPath: string;
const fontContent = Buffer.from("fake-font-data-for-testing");
const fontBase64 = fontContent.toString("base64");

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "og-inline-test-"));
  fontPath = path.join(tmpDir, "noto-sans.ttf");
  await fsp.writeFile(fontPath, fontContent);
});

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────

describe("vinext:og-inline-fetch-assets plugin", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exists in the plugin array", () => {
    const plugin = getOgInlinePlugin();
    expect(plugin.name).toBe("vinext:og-inline-fetch-assets");
    expect(plugin.enforce).toBe("pre");
  });

  // ── Guard clause ──────────────────────────────────────────

  it("returns null when code has no import.meta.url", async () => {
    const plugin = getOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import fs from 'node:fs';\nconst x = 1;`;
    const result = await transform.call(plugin, code, "/app/og.tsx");
    expect(result).toBeNull();
  });

  // ── Pattern 1: fetch ─────────────────────────────────────

  it("transforms fetch(new URL(..., import.meta.url)).then(r => r.arrayBuffer())", async () => {
    const plugin = getOgInlinePlugin();
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
    const plugin = getOgInlinePlugin();
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
    const plugin = getOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./nonexistent.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const moduleId = path.join(tmpDir, "og.tsx");

    const result = await transform.call(plugin, code, moduleId);
    // No file found → no replacement → returns null
    expect(result).toBeNull();
  });

  // ── Async assertion ──────────────────────────────────────

  it("returns a Promise (hook is async)", () => {
    const plugin = getOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./noto-sans.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const moduleId = path.join(tmpDir, "og.tsx");

    const result = transform.call(plugin, code, moduleId);
    expect(result).toBeInstanceOf(Promise);
  });

  // ── Cache hit ────────────────────────────────────────────

  it("reads the file only once for repeated transforms (cache hit)", async () => {
    const readFileSpy = vi.spyOn(fs.promises, "readFile");

    const plugin = getOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `const buf = fs.readFileSync(fileURLToPath(new URL("./noto-sans.ttf", import.meta.url)));`;
    const moduleId = path.join(tmpDir, "og.tsx");

    // First call — should read from disk
    await transform.call(plugin, code, moduleId);

    // Second call — should use cache
    await transform.call(plugin, code, moduleId);

    // fs.promises.readFile should have been called at most once for this path
    const calls = readFileSpy.mock.calls.filter(
      (call) => call[0] === path.join(tmpDir, "noto-sans.ttf"),
    );
    expect(calls.length).toBe(1);
  });
});
