import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";

describe("resolvePostcssStringPlugins", () => {
  let resolvePostcssStringPlugins: (typeof import("../packages/vinext/src/index.js"))["_resolvePostcssStringPlugins"];

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/index.js");
    resolvePostcssStringPlugins = mod._resolvePostcssStringPlugins;
  });

  /**
   * Creates a temporary project directory with a mock PostCSS plugin
   * and a postcss config file. Returns the temp dir path.
   */
  async function createTmpProject(
    configFileName: string,
    configContent: string,
    opts?: { mockPluginContent?: string },
  ): Promise<string> {
    const fsp = await import("node:fs/promises");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-postcss-"));

    // Create a mock PostCSS plugin that the config can reference
    const pluginDir = path.join(dir, "node_modules", "mock-postcss-plugin");
    await fsp.mkdir(pluginDir, { recursive: true });

    const pluginContent =
      opts?.mockPluginContent ??
      `
module.exports = function mockPlugin(opts) {
  return {
    postcssPlugin: "mock-postcss-plugin",
    Once(root) {},
  };
};
module.exports.postcss = true;
`;
    await fsp.writeFile(path.join(pluginDir, "index.js"), pluginContent);
    await fsp.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "mock-postcss-plugin", version: "1.0.0", main: "index.js" }),
    );

    // Write the PostCSS config file
    await fsp.writeFile(path.join(dir, configFileName), configContent);

    return dir;
  }

  async function cleanupDir(dir: string) {
    const fsp = await import("node:fs/promises");
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  // --- No config file ---

  it("returns undefined when no PostCSS config exists", async () => {
    const fsp = await import("node:fs/promises");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-postcss-none-"));
    try {
      const result = await resolvePostcssStringPlugins(dir);
      expect(result).toBeUndefined();
    } finally {
      await cleanupDir(dir);
    }
  });

  // --- Array form with string plugin ---

  it("resolves string plugin names in array-form postcss.config.cjs", async () => {
    const dir = await createTmpProject(
      "postcss.config.cjs",
      `module.exports = { plugins: ["mock-postcss-plugin"] };`,
    );
    try {
      const result = await resolvePostcssStringPlugins(dir);
      expect(result).toBeDefined();
      expect(result!.plugins).toHaveLength(1);
      // The resolved plugin should be an object (PostCSS plugin instance)
      const plugin = result!.plugins[0];
      expect(plugin).toBeDefined();
      expect(typeof plugin === "object" || typeof plugin === "function").toBe(true);
    } finally {
      await cleanupDir(dir);
    }
  });

  it("resolves string plugin names in array-form postcss.config.mjs", async () => {
    const dir = await createTmpProject(
      "postcss.config.mjs",
      `export default { plugins: ["mock-postcss-plugin"] };`,
    );
    try {
      const result = await resolvePostcssStringPlugins(dir);
      expect(result).toBeDefined();
      expect(result!.plugins).toHaveLength(1);
    } finally {
      await cleanupDir(dir);
    }
  });

  // --- Object form (should be skipped) ---

  it("returns undefined for object-form plugins (postcss-load-config handles these)", async () => {
    const dir = await createTmpProject(
      "postcss.config.cjs",
      `module.exports = { plugins: { "mock-postcss-plugin": {} } };`,
    );
    try {
      const result = await resolvePostcssStringPlugins(dir);
      expect(result).toBeUndefined();
    } finally {
      await cleanupDir(dir);
    }
  });

  // --- Array form without string entries (already resolved) ---

  it("returns undefined when array plugins contain no strings", async () => {
    const dir = await createTmpProject(
      "postcss.config.cjs",
      `const plugin = require("mock-postcss-plugin");
module.exports = { plugins: [plugin()] };`,
    );
    try {
      const result = await resolvePostcssStringPlugins(dir);
      expect(result).toBeUndefined();
    } finally {
      await cleanupDir(dir);
    }
  });

  // --- Array tuple form: ["plugin-name", { options }] ---

  it("resolves array tuple form [name, options]", async () => {
    const dir = await createTmpProject(
      "postcss.config.cjs",
      `module.exports = { plugins: [["mock-postcss-plugin", { foo: "bar" }]] };`,
    );
    try {
      const result = await resolvePostcssStringPlugins(dir);
      expect(result).toBeDefined();
      expect(result!.plugins).toHaveLength(1);
    } finally {
      await cleanupDir(dir);
    }
  });

  // --- Mixed array with strings and already-resolved plugins ---

  it("handles mixed array with strings and pre-resolved plugins", async () => {
    const dir = await createTmpProject(
      "postcss.config.cjs",
      `const plugin = require("mock-postcss-plugin");
module.exports = { plugins: ["mock-postcss-plugin", plugin()] };`,
    );
    try {
      const result = await resolvePostcssStringPlugins(dir);
      expect(result).toBeDefined();
      expect(result!.plugins).toHaveLength(2);
    } finally {
      await cleanupDir(dir);
    }
  });

  // --- Plugin that exports a default function ---

  it("calls default export function for string plugin", async () => {
    const dir = await createTmpProject(
      "postcss.config.cjs",
      `module.exports = { plugins: ["mock-postcss-plugin"] };`,
      {
        mockPluginContent: `
module.exports = function(opts) {
  return {
    postcssPlugin: "mock-plugin",
    Once(root) {},
  };
};
module.exports.postcss = true;
`,
      },
    );
    try {
      const result = await resolvePostcssStringPlugins(dir);
      expect(result).toBeDefined();
      expect(result!.plugins).toHaveLength(1);
      // Should be the result of calling the function (a plugin object)
      expect(result!.plugins[0]).toHaveProperty("postcssPlugin", "mock-plugin");
    } finally {
      await cleanupDir(dir);
    }
  });

  // --- JSON/YAML configs are skipped ---

  it("returns undefined for .postcssrc.json (postcss-load-config handles these)", async () => {
    const fsp = await import("node:fs/promises");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-postcss-json-"));
    await fsp.writeFile(
      path.join(dir, ".postcssrc.json"),
      JSON.stringify({ plugins: { autoprefixer: {} } }),
    );
    try {
      const result = await resolvePostcssStringPlugins(dir);
      expect(result).toBeUndefined();
    } finally {
      await cleanupDir(dir);
    }
  });

  // --- Config file priority ---

  it("picks postcss.config.js over .postcssrc", async () => {
    const fsp = await import("node:fs/promises");
    const dir = await createTmpProject(
      "postcss.config.js",
      `module.exports = { plugins: ["mock-postcss-plugin"] };`,
    );
    // Also create a .postcssrc with object form
    await fsp.writeFile(
      path.join(dir, ".postcssrc"),
      JSON.stringify({ plugins: { autoprefixer: {} } }),
    );
    try {
      const result = await resolvePostcssStringPlugins(dir);
      // postcss.config.js has array-form with string — should resolve
      expect(result).toBeDefined();
      expect(result!.plugins).toHaveLength(1);
    } finally {
      await cleanupDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration test: Vite config hook injects resolved PostCSS
// ---------------------------------------------------------------------------

describe("PostCSS string plugin resolution in Vite config", () => {
  let tmpDir: string;

  afterAll(async () => {
    if (tmpDir) {
      const fsp = await import("node:fs/promises");
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("injects resolved PostCSS plugins into Vite css.postcss config", async () => {
    const fsp = await import("node:fs/promises");
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-postcss-int-"));

    // Symlink node_modules from project root
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    // Create a mock PostCSS plugin in node_modules
    const pluginDir = path.join(tmpDir, "node_modules", "mock-postcss-plugin");
    await fsp.mkdir(pluginDir, { recursive: true });
    await fsp.writeFile(
      path.join(pluginDir, "index.js"),
      `module.exports = function(opts) {
  return { postcssPlugin: "mock-postcss-plugin", Once(root) {} };
};
module.exports.postcss = true;`,
    );
    await fsp.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "mock-postcss-plugin", version: "1.0.0", main: "index.js" }),
    );

    // PostCSS config with array-form string plugin
    await fsp.writeFile(
      path.join(tmpDir, "postcss.config.cjs"),
      `module.exports = { plugins: ["mock-postcss-plugin"] };`,
    );

    // Minimal pages directory
    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );

    // Create a Vite server to test the resolved config
    const { createServer } = await import("vite");
    const vinext = (await import("../packages/vinext/src/index.js")).default;

    const server = await createServer({
      root: tmpDir,
      configFile: false,
      plugins: [vinext()],
      server: { port: 0 },
      logLevel: "silent",
    });

    try {
      // Check the resolved config has css.postcss set
      const postcssConfig = server.config.css?.postcss;
      expect(postcssConfig).toBeDefined();
      expect(typeof postcssConfig).toBe("object");
      const postcssObj = postcssConfig as { plugins: any[] };
      expect(postcssObj.plugins).toHaveLength(1);
      expect(postcssObj.plugins[0]).toHaveProperty("postcssPlugin", "mock-postcss-plugin");
    } finally {
      await server.close();
    }
  }, 30000);
});
