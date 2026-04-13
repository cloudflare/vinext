/**
 * Tests for startup-time caching of expensive filesystem operations.
 *
 * Task 1a: hasMdxFiles() should cache its result per (root, appDir, pagesDir) combination.
 * Task 1b: resolvePostcssStringPlugins() should cache its result per project root.
 */
import { afterEach, describe, it, expect, beforeAll, beforeEach, vi } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Task 1a: hasMdxFiles caching
// ---------------------------------------------------------------------------

describe("hasMdxFiles caching", () => {
  let hasMdxFiles: (typeof import("../packages/vinext/src/index.js"))["_hasMdxFiles"];
  let mdxScanCache: (typeof import("../packages/vinext/src/index.js"))["_mdxScanCache"];

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/index.js");
    hasMdxFiles = mod._hasMdxFiles;
    mdxScanCache = mod._mdxScanCache;
  });

  beforeEach(() => {
    // Clear the cache between tests to ensure isolation
    mdxScanCache.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when .mdx files exist in appDir", async () => {
    const fsp = await import("node:fs/promises");
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-mdx-"));
    const appDir = path.join(tmpDir, "app");
    await fsp.mkdir(appDir, { recursive: true });
    await fsp.writeFile(path.join(appDir, "page.mdx"), "# Hello");

    try {
      const result = hasMdxFiles(tmpDir, appDir, null);
      expect(result).toBe(true);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns false when no .mdx files exist", async () => {
    const fsp = await import("node:fs/promises");
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-mdx-"));
    const appDir = path.join(tmpDir, "app");
    await fsp.mkdir(appDir, { recursive: true });
    await fsp.writeFile(path.join(appDir, "page.tsx"), "export default () => null");

    try {
      const result = hasMdxFiles(tmpDir, appDir, null);
      expect(result).toBe(false);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not rescan the filesystem on second call with same root", async () => {
    const fsp = await import("node:fs/promises");
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-mdx-cache-"));
    const appDir = path.join(tmpDir, "app");
    await fsp.mkdir(appDir, { recursive: true });
    await fsp.writeFile(path.join(appDir, "page.mdx"), "# Hello");

    try {
      // First call — populates cache
      const result1 = hasMdxFiles(tmpDir, appDir, null);
      expect(result1).toBe(true);

      // Spy on readdirSync after first call
      const readdirSpy = vi.spyOn(fs, "readdirSync");

      // Second call — should use cache, no filesystem reads
      const result2 = hasMdxFiles(tmpDir, appDir, null);
      expect(result2).toBe(true);
      expect(readdirSpy).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("caches false results too (no redundant scans for missing mdx)", async () => {
    const fsp = await import("node:fs/promises");
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-mdx-nomdx-"));
    const appDir = path.join(tmpDir, "app");
    await fsp.mkdir(appDir, { recursive: true });
    await fsp.writeFile(path.join(appDir, "page.tsx"), "export default () => null");

    try {
      // First call
      const result1 = hasMdxFiles(tmpDir, appDir, null);
      expect(result1).toBe(false);

      const readdirSpy = vi.spyOn(fs, "readdirSync");

      // Second call — should hit cache
      const result2 = hasMdxFiles(tmpDir, appDir, null);
      expect(result2).toBe(false);
      expect(readdirSpy).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("caches independently per root directory", async () => {
    const fsp = await import("node:fs/promises");
    const tmpDir1 = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-mdx-root1-"));
    const tmpDir2 = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-mdx-root2-"));
    const appDir1 = path.join(tmpDir1, "app");
    const appDir2 = path.join(tmpDir2, "app");
    await fsp.mkdir(appDir1, { recursive: true });
    await fsp.mkdir(appDir2, { recursive: true });
    await fsp.writeFile(path.join(appDir1, "page.mdx"), "# Hello");
    await fsp.writeFile(path.join(appDir2, "page.tsx"), "export default () => null");

    try {
      expect(hasMdxFiles(tmpDir1, appDir1, null)).toBe(true);
      expect(hasMdxFiles(tmpDir2, appDir2, null)).toBe(false);
    } finally {
      await fsp.rm(tmpDir1, { recursive: true, force: true });
      await fsp.rm(tmpDir2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Task 1b: resolvePostcssStringPlugins caching
// ---------------------------------------------------------------------------

describe("resolvePostcssStringPlugins caching", () => {
  let resolvePostcssStringPlugins: (typeof import("../packages/vinext/src/plugins/postcss.js"))["resolvePostcssStringPlugins"];
  let postcssCache: (typeof import("../packages/vinext/src/plugins/postcss.js"))["postcssCache"];

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/plugins/postcss.js");
    resolvePostcssStringPlugins = mod.resolvePostcssStringPlugins;
    postcssCache = mod.postcssCache;
  });

  beforeEach(() => {
    postcssCache.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createTmpProject(configFileName: string, configContent: string): Promise<string> {
    const fsp = await import("node:fs/promises");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-postcss-cache-"));

    // Create a mock PostCSS plugin
    const pluginDir = path.join(dir, "node_modules", "mock-postcss-plugin");
    await fsp.mkdir(pluginDir, { recursive: true });
    await fsp.writeFile(
      path.join(pluginDir, "index.js"),
      `module.exports = function mockPlugin(opts) {
  return { postcssPlugin: "mock-postcss-plugin", Once(root) {} };
};
module.exports.postcss = true;`,
    );
    await fsp.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "mock-postcss-plugin", version: "1.0.0", main: "index.js" }),
    );

    await fsp.writeFile(path.join(dir, configFileName), configContent);
    return dir;
  }

  async function cleanupDir(dir: string) {
    const fsp = await import("node:fs/promises");
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  it("does not re-scan filesystem on second call with same projectRoot", async () => {
    const dir = await createTmpProject(
      "postcss.config.cjs",
      `module.exports = { plugins: ["mock-postcss-plugin"] };`,
    );

    try {
      // First call — populates cache
      const result1 = await resolvePostcssStringPlugins(dir);
      expect(result1).toBeDefined();
      expect(result1!.plugins).toHaveLength(1);

      // Spy on existsSync after first call
      const existsSpy = vi.spyOn(fs, "existsSync");

      // Second call — should use cache
      const result2 = await resolvePostcssStringPlugins(dir);
      expect(result2).toBeDefined();
      expect(result2!.plugins).toHaveLength(1);
      expect(existsSpy).not.toHaveBeenCalled();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("caches undefined results (no config file)", async () => {
    const fsp = await import("node:fs/promises");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-postcss-noconf-"));

    try {
      // First call — no config, returns undefined
      const result1 = await resolvePostcssStringPlugins(dir);
      expect(result1).toBeUndefined();

      const existsSpy = vi.spyOn(fs, "existsSync");

      // Second call — should use cache
      const result2 = await resolvePostcssStringPlugins(dir);
      expect(result2).toBeUndefined();
      expect(existsSpy).not.toHaveBeenCalled();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("returns the exact same object reference from cache", async () => {
    const dir = await createTmpProject(
      "postcss.config.cjs",
      `module.exports = { plugins: ["mock-postcss-plugin"] };`,
    );

    try {
      const result1 = await resolvePostcssStringPlugins(dir);
      const result2 = await resolvePostcssStringPlugins(dir);
      // Same reference — not re-computed
      expect(result1).toBe(result2);
    } finally {
      await cleanupDir(dir);
    }
  });

  it("caches independently per project root", async () => {
    const dir1 = await createTmpProject(
      "postcss.config.cjs",
      `module.exports = { plugins: ["mock-postcss-plugin"] };`,
    );
    const fsp = await import("node:fs/promises");
    const dir2 = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-postcss-noconf2-"));

    try {
      const result1 = await resolvePostcssStringPlugins(dir1);
      const result2 = await resolvePostcssStringPlugins(dir2);
      expect(result1).toBeDefined();
      expect(result2).toBeUndefined();
    } finally {
      await cleanupDir(dir1);
      await cleanupDir(dir2);
    }
  });
});
