import { describe, it, expect } from "vite-plus/test";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";
import type { Plugin } from "vite-plus";

// ── Helpers ───────────────────────────────────────────────────
const IMAGES_DIR = path.resolve(import.meta.dirname, "./fixtures/images");
const PNG_PATH = path.join(IMAGES_DIR, "test-4x3.png");
const JPG_PATH = path.join(IMAGES_DIR, "test-8x6.jpg");

/** Unwrap a Vite plugin hook that may use the object-with-filter format */
function unwrapHook(hook: any): Function {
  return typeof hook === "function" ? hook : hook?.handler;
}

/** Extract the vinext:image-imports plugin from the plugin array */
function getImagePlugin(): Plugin & { _dimCache: Map<string, { width: number; height: number }> } {
  const plugins = vinext() as Plugin[];
  const plugin = plugins.find((p) => p.name === "vinext:image-imports");
  if (!plugin) throw new Error("vinext:image-imports plugin not found");
  return plugin as any;
}

// ── resolveId ─────────────────────────────────────────────────
describe("vinext:image-imports — resolveId", () => {
  it("resolves ?vinext-meta suffix to virtual module ID", () => {
    const plugin = getImagePlugin();
    const resolve = unwrapHook(plugin.resolveId);
    const result = resolve.call(plugin, "/abs/path/hero.jpg?vinext-meta", "/some/file.tsx");
    expect(result).toBe("\0vinext-image-meta:/abs/path/hero.jpg");
  });

  it("returns null for non-meta imports", () => {
    const plugin = getImagePlugin();
    const resolve = unwrapHook(plugin.resolveId);
    expect(resolve.call(plugin, "./hero.jpg", "/some/file.tsx")).toBeNull();
    expect(resolve.call(plugin, "react", "/some/file.tsx")).toBeNull();
    expect(resolve.call(plugin, "next/image", "/some/file.tsx")).toBeNull();
  });
});

// ── load ──────────────────────────────────────────────────────
describe("vinext:image-imports — load", () => {
  it("returns dimensions for a PNG file", async () => {
    const plugin = getImagePlugin();
    const load = plugin.load as Function;
    const result = await load.call(plugin, `\0vinext-image-meta:${PNG_PATH}`);
    expect(result).toContain("export default");
    const json = result.replace("export default ", "").replace(";", "");
    const dims = JSON.parse(json);
    expect(dims.width).toBe(4);
    expect(dims.height).toBe(3);
  });

  it("returns dimensions for a JPEG file", async () => {
    const plugin = getImagePlugin();
    const load = plugin.load as Function;
    const result = await load.call(plugin, `\0vinext-image-meta:${JPG_PATH}`);
    const json = result.replace("export default ", "").replace(";", "");
    const dims = JSON.parse(json);
    expect(dims.width).toBe(8);
    expect(dims.height).toBe(6);
  });

  it("returns 0x0 for non-existent file", async () => {
    const plugin = getImagePlugin();
    const load = plugin.load as Function;
    const result = await load.call(plugin, "\0vinext-image-meta:/no/such/file.png");
    const json = result.replace("export default ", "").replace(";", "");
    const dims = JSON.parse(json);
    expect(dims.width).toBe(0);
    expect(dims.height).toBe(0);
  });

  it("returns null for non-image-meta IDs", async () => {
    const plugin = getImagePlugin();
    const load = plugin.load as Function;
    expect(await load.call(plugin, "./hero.jpg")).toBeNull();
    expect(await load.call(plugin, "react")).toBeNull();
  });

  it("caches dimensions on second call", async () => {
    const plugin = getImagePlugin();
    plugin._dimCache.clear();
    const load = plugin.load as Function;
    await load.call(plugin, `\0vinext-image-meta:${PNG_PATH}`);
    expect(plugin._dimCache.has(PNG_PATH)).toBe(true);
    // Second call uses cache (no way to verify directly, but should not throw)
    const result = await load.call(plugin, `\0vinext-image-meta:${PNG_PATH}`);
    expect(result).toContain('"width":4');
  });
});

// ── transform ─────────────────────────────────────────────────
describe("vinext:image-imports — transform", () => {
  // Fake file ID in the images directory so path.resolve works
  const fakeId = path.join(IMAGES_DIR, "page.tsx");

  /**
   * The transform's contract is that an `import X from './pic.png'` becomes a
   * `const X = { src, width, height, ... }` StaticImageData object, with
   * dimensions resolved through a sibling `?vinext-meta` import. We verify the
   * shape, not the synthesized intermediate variable names.
   */
  function expectImageBinding(code: string, name: string, fileBasename: string) {
    expect(code).not.toMatch(new RegExp(`import\\s+${name}\\s+from`));
    expect(code).toMatch(new RegExp(`const\\s+${name}\\s*=\\s*\\{[^}]*src\\s*:`));
    expect(code).toContain(path.join(IMAGES_DIR, fileBasename) + "?vinext-meta");
  }

  it("transforms a PNG import into StaticImageData", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import hero from './test-4x3.png';\nconsole.log(hero);`;
    const result = await transform.call(plugin, code, fakeId);
    expect(result).not.toBeNull();
    expectImageBinding(result.code, "hero", "test-4x3.png");
    expect(result.map).toBeDefined();
  });

  it("transforms a JPEG import", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import photo from './test-8x6.jpg';`;
    const result = await transform.call(plugin, code, fakeId);
    expect(result).not.toBeNull();
    expectImageBinding(result.code, "photo", "test-8x6.jpg");
  });

  it("transforms multiple image imports in one file", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import hero from './test-4x3.png';`,
      `import photo from './test-8x6.jpg';`,
      `export default function Page() { return null; }`,
    ].join("\n");
    const result = await transform.call(plugin, code, fakeId);
    expect(result).not.toBeNull();
    expectImageBinding(result.code, "hero", "test-4x3.png");
    expectImageBinding(result.code, "photo", "test-8x6.jpg");
  });

  it("returns null for files with no image imports", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import React from 'react';\nconst x = 1;`;
    const result = await transform.call(plugin, code, fakeId);
    expect(result).toBeNull();
  });

  it("returns null for node_modules files", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import hero from './hero.png';`;
    const result = await transform.call(plugin, code, path.join("node_modules", "pkg", "index.ts"));
    expect(result).toBeNull();
  });

  it("returns null for virtual modules (\\0 prefix)", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import hero from './hero.png';`;
    const result = await transform.call(plugin, code, "\0virtual:something");
    expect(result).toBeNull();
  });

  it("returns null for non-script files", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import hero from './hero.png';`;
    const result = await transform.call(plugin, code, "/app/styles.css");
    expect(result).toBeNull();
  });

  it("skips imports where the image file does not exist", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import ghost from './nonexistent.png';`;
    const result = await transform.call(plugin, code, fakeId);
    // Regex matches but fs.existsSync fails — no changes made
    expect(result).toBeNull();
  });

  it("preserves non-image imports alongside image imports", async () => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `import React from 'react';`,
      `import hero from './test-4x3.png';`,
      `import { useState } from 'react';`,
    ].join("\n");
    const result = await transform.call(plugin, code, fakeId);
    expect(result).not.toBeNull();
    // React imports should still be there
    expect(result.code).toContain(`import React from 'react'`);
    expect(result.code).toContain(`import { useState } from 'react'`);
    // Image import should be rewritten as a StaticImageData binding
    expectImageBinding(result.code, "hero", "test-4x3.png");
  });

  it.each([`'./test-4x3.png'`, `"./test-4x3.png"`])("handles import quoted as %s", async (q) => {
    const plugin = getImagePlugin();
    const transform = unwrapHook(plugin.transform);
    const result = await transform.call(plugin, `import hero from ${q};`, fakeId);
    expect(result).not.toBeNull();
    expectImageBinding(result.code, "hero", "test-4x3.png");
  });
});
