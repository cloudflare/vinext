import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plugin, PluginOption } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";

const originalCwd = process.cwd();
let createdRoot: string | undefined;

function setupProject(
  vitePackageJson: Record<string, unknown>,
  options: { typescript?: boolean } = {},
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-vite-major-"));
  createdRoot = root;
  fs.mkdirSync(path.join(root, "pages"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "vite"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "test-project", version: "1.0.0" }, null, 2),
  );
  fs.writeFileSync(
    path.join(root, "node_modules", "vite", "package.json"),
    JSON.stringify(vitePackageJson, null, 2),
  );
  if (options.typescript !== false) {
    fs.mkdirSync(path.join(root, "node_modules", "typescript", "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "typescript", "package.json"),
      JSON.stringify({ name: "typescript", version: "5.9.3" }),
    );
    fs.writeFileSync(path.join(root, "node_modules", "typescript", "lib", "typescript.js"), "");
  }
  fs.writeFileSync(
    path.join(root, "pages", "index.tsx"),
    "export default function Page() { return <div>hello</div>; }\n",
  );
  return root;
}

function isPlugin(plugin: PluginOption): plugin is Plugin {
  return !!plugin && !Array.isArray(plugin) && typeof plugin === "object" && "name" in plugin;
}

function findNamedPlugin(plugins: ReturnType<typeof vinext>, name: string) {
  return plugins.find((plugin): plugin is Plugin => isPlugin(plugin) && plugin.name === name);
}

async function configureCustomTsconfig(root: string, tsconfig: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(root, "next.config.mjs"),
    "export default { typescript: { tsconfigPath: 'web.tsconfig.json' } };\n",
  );
  fs.writeFileSync(path.join(root, "web.tsconfig.json"), JSON.stringify(tsconfig, null, 2));
  const plugins = vinext({ appDir: root });
  const configPlugin = findNamedPlugin(plugins, "vinext:config") as Plugin;
  const configHook =
    typeof configPlugin.config === "object" ? configPlugin.config.handler : configPlugin.config;
  await configHook?.call({} as never, { root }, { command: "serve", mode: "development" });
  return findNamedPlugin(plugins, "vinext:tsconfig-paths") as Plugin;
}

async function resolveWithCustomTsconfig(
  plugin: Plugin,
  id: string,
  importer: string,
  resolver: (id: string) => string | null,
) {
  const resolveId =
    typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
  const context = {
    resolve: async (candidate: string) => {
      const resolved = resolver(candidate);
      return resolved ? { id: resolved } : null;
    },
  } as unknown as ThisParameterType<NonNullable<typeof resolveId>>;
  return resolveId?.call(context, id, importer, { isEntry: false });
}

afterEach(() => {
  // Restore the cwd before removing the temp dir: each test chdir's into
  // `root`, and Windows refuses to delete a directory that is a process's
  // current working directory (EPERM). Clean up here, after the chdir, rather
  // than inside the test body where the cwd is still inside `root`.
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  if (createdRoot) {
    fs.rmSync(createdRoot, { recursive: true, force: true });
    createdRoot = undefined;
  }
});

describe("Vite tsconfig paths support", () => {
  it("keeps vite-tsconfig-paths on Vite 7", async () => {
    const root = setupProject({ name: "vite", version: "7.3.1" });
    process.chdir(root);

    const plugins = vinext({ appDir: root });

    expect(findNamedPlugin(plugins, "vite-tsconfig-paths")).toBeDefined();
  });

  it("uses resolve.tsconfigPaths on Vite 8 instead of vite-tsconfig-paths", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);

    const plugins = vinext({ appDir: root });

    expect(findNamedPlugin(plugins, "vite-tsconfig-paths")).toBeUndefined();

    const configPlugin = findNamedPlugin(plugins, "vinext:config") as {
      config?: (
        config: { root: string },
        env: { command: "serve"; mode: string },
      ) => Promise<{
        resolve?: Record<string, unknown>;
      }>;
    };
    const resolvedConfig = await configPlugin.config?.(
      { root },
      { command: "serve", mode: "development" },
    );

    expect(resolvedConfig?.resolve?.tsconfigPaths).toBe(true);
  });

  it("treats an empty typescript.tsconfigPath as the default tsconfig.json", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    fs.writeFileSync(
      path.join(root, "next.config.mjs"),
      "export default { typescript: { tsconfigPath: '' } };\n",
    );
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
    );
    fs.writeFileSync(
      path.join(root, "jsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "#/*": ["./legacy/*"] } } }),
    );

    const plugins = vinext({ appDir: root });
    const configPlugin = findNamedPlugin(plugins, "vinext:config") as {
      config?: (
        config: { root: string },
        env: { command: "serve"; mode: string },
      ) => Promise<{ resolve?: Record<string, unknown> }>;
    };
    const resolvedConfig = await configPlugin.config?.(
      { root },
      { command: "serve", mode: "development" },
    );

    expect(resolvedConfig?.resolve?.tsconfigPaths).toBe(true);
    expect(resolvedConfig?.resolve?.alias).toEqual(
      expect.objectContaining({
        "@": "/src",
      }),
    );
    expect(resolvedConfig?.resolve?.alias).not.toHaveProperty("#");
  });

  it("uses jsconfig when TypeScript is not resolvable from the app", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" }, { typescript: false });
    process.chdir(root);
    fs.writeFileSync(
      path.join(root, "next.config.mjs"),
      "export default { typescript: { tsconfigPath: 'web.tsconfig.json' } };\n",
    );
    fs.writeFileSync(
      path.join(root, "web.tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
    );
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "$/*": ["./typed/*"] } } }),
    );
    fs.writeFileSync(
      path.join(root, "jsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "#/*": ["./legacy/*"] } } }),
    );

    const plugins = vinext({ appDir: root });
    const configPlugin = findNamedPlugin(plugins, "vinext:config") as Plugin;
    const configHook =
      typeof configPlugin.config === "object" ? configPlugin.config.handler : configPlugin.config;
    const resolvedConfig = await configHook?.call(
      {} as never,
      { root },
      { command: "serve", mode: "development" },
    );

    expect(resolvedConfig?.resolve?.alias).toEqual(expect.objectContaining({ "#": "/legacy" }));
    expect(resolvedConfig?.resolve?.alias).not.toHaveProperty("@");
    expect(resolvedConfig?.resolve?.alias).not.toHaveProperty("$");
  });

  it("uses jsconfig when the app has TypeScript metadata without its compiler", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" }, { typescript: false });
    process.chdir(root);
    fs.mkdirSync(path.join(root, "node_modules", "typescript"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "typescript", "package.json"),
      JSON.stringify({ name: "typescript", version: "5.9.3" }),
    );
    fs.writeFileSync(
      path.join(root, "next.config.mjs"),
      "export default { typescript: { tsconfigPath: 'web.tsconfig.json' } };\n",
    );
    fs.writeFileSync(
      path.join(root, "web.tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
    );
    fs.writeFileSync(
      path.join(root, "jsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "#/*": ["./legacy/*"] } } }),
    );

    const plugins = vinext({ appDir: root });
    const configPlugin = findNamedPlugin(plugins, "vinext:config") as Plugin;
    const configHook =
      typeof configPlugin.config === "object" ? configPlugin.config.handler : configPlugin.config;
    const resolvedConfig = await configHook?.call(
      {} as never,
      { root },
      { command: "serve", mode: "development" },
    );

    expect(resolvedConfig?.resolve?.alias).toEqual(expect.objectContaining({ "#": "/legacy" }));
    expect(resolvedConfig?.resolve?.alias).not.toHaveProperty("@");
  });

  it("materializes simple tsconfig path aliases into resolve.alias on Vite 8", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["./*"],
            },
          },
        },
        null,
        2,
      ),
    );

    const plugins = vinext({ appDir: root });
    const configPlugin = findNamedPlugin(plugins, "vinext:config") as {
      config?: (
        config: { root: string },
        env: { command: "serve"; mode: string },
      ) => Promise<{
        resolve?: Record<string, unknown>;
      }>;
    };
    const resolvedConfig = await configPlugin.config?.(
      { root },
      { command: "serve", mode: "development" },
    );

    const alias = resolvedConfig?.resolve?.alias as Record<string, string>;
    expect(alias).toBeDefined();
    expect(alias["@"]).toBeDefined();
    expect(path.isAbsolute(alias["@"])).toBe(true);
    expect(alias["@"].replace(/\\/g, "/")).toContain(root.replace(/\\/g, "/"));
  });

  // Ported from Next.js: test/e2e/tsconfig-path/index.test.ts and
  // test/e2e/typescript-custom-tsconfig/test/index.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/tsconfig-path/index.test.ts
  it("uses typescript.tsconfigPath for App, Pages, and middleware resolution", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    fs.mkdirSync(path.join(root, "config"));
    fs.writeFileSync(
      path.join(root, "next.config.mjs"),
      "export default { typescript: { tsconfigPath: '/config/web.json' } };\n",
    );
    fs.writeFileSync(
      path.join(root, "config/web.json"),
      JSON.stringify(
        {
          include: ["config-only/**/*"],
          exclude: ["../app/**/*", "../pages/**/*", "../middleware.ts"],
          compilerOptions: {
            baseUrl: "./custom-src",
            paths: {
              foo: ["../bar.ts"],
            },
          },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(path.join(root, "bar.ts"), "export default 'bar123';\n");

    const plugins = vinext({ appDir: root });
    const configPlugin = findNamedPlugin(plugins, "vinext:config") as {
      config?: (
        config: { root: string },
        env: { command: "serve"; mode: string },
      ) => Promise<{
        resolve?: Record<string, unknown>;
      }>;
    };
    const resolvedConfig = await configPlugin.config?.(
      { root },
      { command: "serve", mode: "development" },
    );

    expect(resolvedConfig?.resolve?.alias).not.toHaveProperty("foo");
    expect(resolvedConfig?.resolve?.tsconfigPaths).toBe(false);
  });

  it("prefers exact paths and then the wildcard with the longest prefix", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const plugin = await configureCustomTsconfig(root, {
      compilerOptions: {
        paths: {
          "@/*": ["./broad/*"],
          "@/components/*": ["./components/*"],
          "@/components/button": ["./exact.ts"],
        },
      },
    });
    const importer = path.join(root, "pages/index.tsx");
    const resolver = (candidate: string) => candidate;
    const realRoot = fs.realpathSync(root);

    await expect(
      resolveWithCustomTsconfig(plugin, "@/components/button", importer, resolver),
    ).resolves.toHaveProperty("id", path.join(realRoot, "exact.ts"));
    await expect(
      resolveWithCustomTsconfig(plugin, "@/components/card", importer, resolver),
    ).resolves.toHaveProperty("id", path.join(realRoot, "components/card"));
  });

  it("does not apply custom paths to direct or symlinked dependency importers", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const plugin = await configureCustomTsconfig(root, {
      compilerOptions: { paths: { internal: ["./app-internal.ts"] } },
    });
    const directImporter = path.join(root, "node_modules/direct/index.js");
    fs.mkdirSync(path.dirname(directImporter), { recursive: true });
    fs.writeFileSync(directImporter, "");
    const linkedPackage = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-linked-dependency-"));
    fs.writeFileSync(path.join(linkedPackage, "index.js"), "");
    fs.symlinkSync(linkedPackage, path.join(root, "node_modules/linked"), "dir");
    const resolver = (candidate: string) =>
      candidate === path.join(root, "app-internal.ts") ? candidate : null;

    await expect(
      resolveWithCustomTsconfig(plugin, "internal", directImporter, resolver),
    ).resolves.toBeUndefined();
    await expect(
      resolveWithCustomTsconfig(plugin, "internal", path.join(linkedPackage, "index.js"), resolver),
    ).resolves.toBeUndefined();
    fs.rmSync(linkedPackage, { recursive: true, force: true });
  });

  it("keeps explicit paths above packages and baseUrl behind packages", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const plugin = await configureCustomTsconfig(root, {
      compilerOptions: {
        baseUrl: ".",
        paths: { explicit: ["./explicit.ts"] },
      },
    });
    const importer = path.join(root, "pages/index.tsx");
    const realRoot = fs.realpathSync(root);
    const packageId = path.join(root, "node_modules/package-name/index.js");
    fs.mkdirSync(path.dirname(packageId), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules/package-name/package.json"),
      JSON.stringify({ name: "package-name", main: "index.js" }),
    );
    fs.writeFileSync(packageId, "export default 'package';\n");
    const resolver = (candidate: string) => {
      if (candidate === "package-name") return packageId;
      if (candidate === path.join(realRoot, "package-name")) return candidate;
      if (candidate === path.join(realRoot, "explicit.ts")) return candidate;
      return null;
    };

    await expect(
      resolveWithCustomTsconfig(plugin, "package-name", importer, resolver),
    ).resolves.toHaveProperty("id", packageId);
    await expect(
      resolveWithCustomTsconfig(plugin, "explicit", importer, resolver),
    ).resolves.toHaveProperty("id", path.join(realRoot, "explicit.ts"));
  });

  it("uses baseUrl for bare project files that are not installed packages", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const plugin = await configureCustomTsconfig(root, {
      compilerOptions: { baseUrl: "." },
    });
    const importer = path.join(root, "pages/index.tsx");
    const candidate = path.join(fs.realpathSync(root), "base-value");

    await expect(
      resolveWithCustomTsconfig(plugin, "base-value", importer, (id) =>
        id === candidate ? id : null,
      ),
    ).resolves.toHaveProperty("id", candidate);
  });

  it.each([
    ["package tsconfig field", "config-preset", { tsconfig: "config/base.json" }],
    ["exported JSON subpath", "preset/base", { exports: { "./base": "./base.json" } }],
    ["scoped package", "@scope/preset", { tsconfig: "base.json" }],
  ])("resolves extends from a %s", async (_label, extendsSpecifier, packageJson) => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const packageName = extendsSpecifier.startsWith("@")
      ? extendsSpecifier.split("/").slice(0, 2).join("/")
      : extendsSpecifier.split("/")[0];
    const packageRoot = path.join(root, "node_modules", packageName);
    fs.mkdirSync(path.join(packageRoot, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: packageName, ...packageJson }),
    );
    const configFile =
      extendsSpecifier === "preset/base"
        ? path.join(packageRoot, "base.json")
        : path.join(
            packageRoot,
            "tsconfig" in packageJson ? packageJson.tsconfig : "tsconfig.json",
          );
    fs.writeFileSync(
      configFile,
      JSON.stringify({ compilerOptions: { paths: { inherited: ["./inherited.ts"] } } }),
    );

    const plugin = await configureCustomTsconfig(root, { extends: extendsSpecifier });
    const expectedConfigFile = fs.realpathSync(configFile);
    await expect(
      resolveWithCustomTsconfig(
        plugin,
        "inherited",
        path.join(root, "pages/index.tsx"),
        (candidate) => candidate,
      ),
    ).resolves.toHaveProperty("id", path.join(path.dirname(expectedConfigFile), "inherited.ts"));
  });

  it("prefers a types JSON target in conditional package exports", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const packageRoot = path.join(root, "node_modules/preset");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "preset",
        exports: {
          "./base": {
            types: "./base.json",
            default: "./index.js",
          },
        },
      }),
    );
    fs.writeFileSync(path.join(packageRoot, "index.js"), "export default {};");
    fs.writeFileSync(
      path.join(packageRoot, "base.json"),
      JSON.stringify({ compilerOptions: { paths: { inherited: ["./inherited.ts"] } } }),
    );

    const plugin = await configureCustomTsconfig(root, { extends: "preset/base" });
    await expect(
      resolveWithCustomTsconfig(
        plugin,
        "inherited",
        path.join(root, "pages/index.tsx"),
        (candidate) => candidate,
      ),
    ).resolves.toHaveProperty("id", path.join(fs.realpathSync(packageRoot), "inherited.ts"));
  });

  it("prefers a matching versioned types condition before plain types", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const packageRoot = path.join(root, "node_modules/preset");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "preset",
        exports: {
          "./base": {
            "types@>=5.9": "./typescript-5.9.json",
            types: "./fallback.json",
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(packageRoot, "typescript-5.9.json"),
      JSON.stringify({ compilerOptions: { paths: { selected: ["./typescript-5.9.ts"] } } }),
    );
    fs.writeFileSync(
      path.join(packageRoot, "fallback.json"),
      JSON.stringify({ compilerOptions: { paths: { selected: ["./fallback.ts"] } } }),
    );

    const plugin = await configureCustomTsconfig(root, { extends: "preset/base" });
    await expect(
      resolveWithCustomTsconfig(
        plugin,
        "selected",
        path.join(root, "pages/index.tsx"),
        (candidate) => candidate,
      ),
    ).resolves.toHaveProperty("id", path.join(fs.realpathSync(packageRoot), "typescript-5.9.ts"));
  });

  it("skips non-matching versioned types conditions", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const packageRoot = path.join(root, "node_modules/preset");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "preset",
        exports: {
          "./base": {
            "types@>=6": "./typescript-6.json",
            types: "./fallback.json",
          },
        },
      }),
    );
    fs.writeFileSync(path.join(packageRoot, "typescript-6.json"), JSON.stringify({}));
    fs.writeFileSync(
      path.join(packageRoot, "fallback.json"),
      JSON.stringify({ compilerOptions: { paths: { selected: ["./fallback.ts"] } } }),
    );

    const plugin = await configureCustomTsconfig(root, { extends: "preset/base" });
    await expect(
      resolveWithCustomTsconfig(
        plugin,
        "selected",
        path.join(root, "pages/index.tsx"),
        (candidate) => candidate,
      ),
    ).resolves.toHaveProperty("id", path.join(fs.realpathSync(packageRoot), "fallback.ts"));
  });

  it("tries later package export array targets when an earlier target is missing", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const packageRoot = path.join(root, "node_modules/preset");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "preset",
        exports: {
          "./base": ["./missing.json", "./base.json"],
        },
      }),
    );
    fs.writeFileSync(
      path.join(packageRoot, "base.json"),
      JSON.stringify({ compilerOptions: { paths: { inherited: ["./inherited.ts"] } } }),
    );

    const plugin = await configureCustomTsconfig(root, { extends: "preset/base" });
    await expect(
      resolveWithCustomTsconfig(
        plugin,
        "inherited",
        path.join(root, "pages/index.tsx"),
        (candidate) => candidate,
      ),
    ).resolves.toHaveProperty("id", path.join(fs.realpathSync(packageRoot), "inherited.ts"));
  });

  it("rejects package export targets that escape the package root", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const packageRoot = path.join(root, "node_modules/preset");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "preset", exports: { "./base": "./../outside.json" } }),
    );
    fs.writeFileSync(path.join(root, "node_modules/outside.json"), JSON.stringify({}));

    await expect(configureCustomTsconfig(root, { extends: "preset/base" })).rejects.toThrow(
      "Cannot read file 'preset/base'.",
    );
  });

  it.each(["./config/../base.json", String.raw`./config\..\base.json`])(
    "rejects package export targets with internal parent segments: %s",
    async (target) => {
      const root = setupProject({ name: "vite", version: "8.0.0" });
      process.chdir(root);
      const packageRoot = path.join(root, "node_modules/preset");
      fs.mkdirSync(path.join(packageRoot, "config"), { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "preset", exports: { "./base": target } }),
      );
      fs.writeFileSync(path.join(packageRoot, "base.json"), JSON.stringify({}));

      await expect(configureCustomTsconfig(root, { extends: "preset/base" })).rejects.toThrow(
        "Cannot read file 'preset/base'.",
      );
    },
  );

  it.each(["./config/./base.json", String.raw`./config\.\base.json`])(
    "rejects package export targets with internal current-directory segments: %s",
    async (target) => {
      const root = setupProject({ name: "vite", version: "8.0.0" });
      process.chdir(root);
      const packageRoot = path.join(root, "node_modules/preset");
      fs.mkdirSync(path.join(packageRoot, "config"), { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "preset", exports: { "./base": target } }),
      );
      fs.writeFileSync(path.join(packageRoot, "config/base.json"), JSON.stringify({}));

      await expect(configureCustomTsconfig(root, { extends: "preset/base" })).rejects.toThrow(
        "Cannot read file 'preset/base'.",
      );
    },
  );

  it("rejects package export targets containing a node_modules segment", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const packageRoot = path.join(root, "node_modules/preset");
    fs.mkdirSync(path.join(packageRoot, "node_modules"), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "preset",
        exports: { "./base": "./node_modules/base.json" },
      }),
    );
    fs.writeFileSync(path.join(packageRoot, "node_modules/base.json"), JSON.stringify({}));

    await expect(configureCustomTsconfig(root, { extends: "preset/base" })).rejects.toThrow(
      "Cannot read file 'preset/base'.",
    );
  });

  it("loads package export symlinks that resolve outside the package root", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const packageRoot = path.join(root, "node_modules/preset");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "preset", exports: { "./base": "./base.json" } }),
    );
    const outsideConfig = path.join(root, "outside.json");
    fs.writeFileSync(
      outsideConfig,
      JSON.stringify({ compilerOptions: { paths: { selected: ["./outside.ts"] } } }),
    );
    fs.symlinkSync(outsideConfig, path.join(packageRoot, "base.json"));

    const plugin = await configureCustomTsconfig(root, { extends: "preset/base" });
    await expect(
      resolveWithCustomTsconfig(
        plugin,
        "selected",
        path.join(root, "pages/index.tsx"),
        (candidate) => candidate,
      ),
    ).resolves.toHaveProperty("id", path.join(fs.realpathSync(root), "outside.ts"));
  });

  it("rejects package export targets containing backslashes on POSIX", async () => {
    if (process.platform === "win32") return;

    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const packageRoot = path.join(root, "node_modules/preset");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "preset", exports: { "./base": String.raw`./config\base.json` } }),
    );
    fs.writeFileSync(path.join(packageRoot, String.raw`config\base.json`), JSON.stringify({}));

    await expect(configureCustomTsconfig(root, { extends: "preset/base" })).rejects.toThrow(
      "Cannot read file 'preset/base'.",
    );
  });

  it("prefers the most specific matching package export pattern", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const packageRoot = path.join(root, "node_modules/preset");
    fs.mkdirSync(path.join(packageRoot, "generic"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "specific"), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "preset",
        exports: {
          "./foo/*": "./generic/*.json",
          "./foo/*.json": "./specific/*.json",
        },
      }),
    );
    fs.writeFileSync(
      path.join(packageRoot, "generic/base.json.json"),
      JSON.stringify({ compilerOptions: { paths: { selected: ["./generic.ts"] } } }),
    );
    fs.writeFileSync(
      path.join(packageRoot, "specific/base.json"),
      JSON.stringify({ compilerOptions: { paths: { selected: ["./specific.ts"] } } }),
    );

    const plugin = await configureCustomTsconfig(root, { extends: "preset/foo/base.json" });
    await expect(
      resolveWithCustomTsconfig(
        plugin,
        "selected",
        path.join(root, "pages/index.tsx"),
        (candidate) => candidate,
      ),
    ).resolves.toHaveProperty(
      "id",
      path.join(fs.realpathSync(packageRoot), "specific/specific.ts"),
    );
  });

  it("rebases inherited paths against a child baseUrl", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    fs.writeFileSync(
      path.join(root, "base.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: "./parent",
          paths: { "@/*": ["src/*"] },
        },
      }),
    );
    const plugin = await configureCustomTsconfig(root, {
      extends: "./base.json",
      compilerOptions: { baseUrl: "./child" },
    });

    await expect(
      resolveWithCustomTsconfig(
        plugin,
        "@/page",
        path.join(root, "pages/index.tsx"),
        (candidate) => candidate,
      ),
    ).resolves.toHaveProperty("id", path.join(fs.realpathSync(root), "child/src/page"));
  });

  it("reuses shared ancestors when applying later extends precedence", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    fs.writeFileSync(
      path.join(root, "base.json"),
      JSON.stringify({ compilerOptions: { paths: { selected: ["./base.ts"] } } }),
    );
    fs.writeFileSync(
      path.join(root, "a.json"),
      JSON.stringify({
        extends: "./base.json",
        compilerOptions: { paths: { selected: ["./a.ts"] } },
      }),
    );
    fs.writeFileSync(path.join(root, "b.json"), JSON.stringify({ extends: "./base.json" }));
    const plugin = await configureCustomTsconfig(root, { extends: ["./a.json", "./b.json"] });

    await expect(
      resolveWithCustomTsconfig(
        plugin,
        "selected",
        path.join(root, "pages/index.tsx"),
        (candidate) => candidate,
      ),
    ).resolves.toHaveProperty("id", path.join(fs.realpathSync(root), "base.ts"));
  });

  it("rejects package config subpaths that are not exported", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const packageRoot = path.join(root, "node_modules/preset");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "preset", exports: { ".": "./index.js" } }),
    );
    fs.writeFileSync(path.join(packageRoot, "private.json"), JSON.stringify({}));

    await expect(configureCustomTsconfig(root, { extends: "preset/private" })).rejects.toThrow(
      "Cannot read file 'preset/private'.",
    );
  });

  it("rejects package exports that mix subpaths and conditions", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const packageRoot = path.join(root, "node_modules/preset");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "preset",
        exports: {
          "./base": "./base.json",
          default: "./default.json",
        },
      }),
    );
    fs.writeFileSync(path.join(packageRoot, "base.json"), JSON.stringify({}));
    fs.writeFileSync(path.join(packageRoot, "default.json"), JSON.stringify({}));

    await expect(configureCustomTsconfig(root, { extends: "preset/base" })).rejects.toThrow(
      "Cannot read file 'preset/base'.",
    );
  });

  it("uses the main export from package exports that mix subpaths and conditions", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const packageRoot = path.join(root, "node_modules/preset");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "preset",
        exports: {
          ".": "./main.json",
          default: "./default.json",
        },
      }),
    );
    fs.writeFileSync(
      path.join(packageRoot, "main.json"),
      JSON.stringify({ compilerOptions: { paths: { selected: ["./main.ts"] } } }),
    );
    fs.writeFileSync(
      path.join(packageRoot, "default.json"),
      JSON.stringify({ compilerOptions: { paths: { selected: ["./default.ts"] } } }),
    );
    fs.writeFileSync(path.join(packageRoot, "main.ts"), "export default 'main';");
    fs.writeFileSync(path.join(packageRoot, "default.ts"), "export default 'default';");
    const plugin = await configureCustomTsconfig(root, { extends: "preset" });

    await expect(
      resolveWithCustomTsconfig(
        plugin,
        "selected",
        path.join(root, "pages/index.tsx"),
        (candidate) => candidate,
      ),
    ).resolves.toHaveProperty("id", path.join(fs.realpathSync(packageRoot), "main.ts"));
  });

  it("throws a TypeScript-style diagnostic for direct and package extends cycles", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    fs.writeFileSync(
      path.join(root, "cycle.json"),
      JSON.stringify({ extends: "./web.tsconfig.json" }),
    );
    await expect(configureCustomTsconfig(root, { extends: "./cycle.json" })).rejects.toThrow(
      "Circularity detected while resolving configuration:",
    );

    const packageRoot = path.join(root, "node_modules/cycle-preset");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "cycle-preset", tsconfig: "base.json" }),
    );
    fs.writeFileSync(
      path.join(packageRoot, "base.json"),
      JSON.stringify({ extends: path.join(root, "web.tsconfig.json") }),
    );
    await expect(configureCustomTsconfig(root, { extends: "cycle-preset" })).rejects.toThrow(
      "Circularity detected while resolving configuration:",
    );
  });

  it("keeps the last valid resolution when an extended config becomes invalid", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const parentPath = path.join(root, "base.json");
    fs.writeFileSync(
      parentPath,
      JSON.stringify({ compilerOptions: { paths: { selected: ["./valid.ts"] } } }),
    );
    const plugin = await configureCustomTsconfig(root, { extends: "./base.json" });
    let watcherCallback: ((event: string, file: string) => void) | undefined;
    const logger = { error: vi.fn() };
    const configureServer =
      typeof plugin.configureServer === "object"
        ? plugin.configureServer.handler
        : plugin.configureServer;
    await configureServer?.call(
      {} as never,
      {
        watcher: {
          add: vi.fn(),
          on: vi.fn((_event, callback) => {
            watcherCallback = callback;
          }),
        },
        moduleGraph: { invalidateAll: vi.fn() },
        ws: { send: vi.fn() },
        config: { logger },
      } as never,
    );
    fs.writeFileSync(parentPath, JSON.stringify({ extends: "./missing.json" }));
    watcherCallback?.("change", parentPath);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to reload custom tsconfig"),
      expect.objectContaining({ error: expect.any(Error) }),
    );
    await expect(
      resolveWithCustomTsconfig(
        plugin,
        "selected",
        path.join(root, "pages/index.tsx"),
        (candidate) => candidate,
      ),
    ).resolves.toHaveProperty("id", path.join(fs.realpathSync(root), "valid.ts"));
  });

  it("falls back only to jsconfig when the configured file is missing", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    fs.writeFileSync(
      path.join(root, "next.config.mjs"),
      "export default { typescript: { tsconfigPath: 'missing.json' } };\n",
    );
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { wrong: ["./wrong.ts"] } } }),
    );
    fs.writeFileSync(
      path.join(root, "jsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { right: ["./right.ts"] } } }),
    );

    const plugins = vinext({ appDir: root });
    const configPlugin = findNamedPlugin(plugins, "vinext:config") as {
      config?: (
        config: { root: string },
        env: { command: "serve"; mode: string },
      ) => Promise<{ resolve?: Record<string, unknown> }>;
    };
    const resolvedConfig = await configPlugin.config?.(
      { root },
      { command: "serve", mode: "development" },
    );

    expect(resolvedConfig?.resolve?.alias).not.toHaveProperty("right");
    expect(resolvedConfig?.resolve?.alias).not.toHaveProperty("wrong");
    expect(resolvedConfig?.resolve?.tsconfigPaths).toBe(false);
  });

  it("throws a TypeScript-style diagnostic when the configured path is a directory", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    fs.mkdirSync(path.join(root, "config"));
    fs.writeFileSync(
      path.join(root, "next.config.mjs"),
      "export default { typescript: { tsconfigPath: 'config' } };\n",
    );
    fs.writeFileSync(
      path.join(root, "jsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { fallback: ["./fallback.ts"] } } }),
    );

    const plugins = vinext({ appDir: root });
    const configPlugin = findNamedPlugin(plugins, "vinext:config") as {
      config?: (
        config: { root: string },
        env: { command: "serve"; mode: string },
      ) => Promise<unknown>;
    };

    await expect(
      configPlugin.config?.({ root }, { command: "serve", mode: "development" }),
    ).rejects.toThrow(`Cannot read file '${path.join(root, "config")}'.`);
  });

  it("throws for a malformed configured file", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    fs.writeFileSync(
      path.join(root, "next.config.mjs"),
      "export default { typescript: { tsconfigPath: 'broken.json' } };\n",
    );
    fs.writeFileSync(path.join(root, "broken.json"), "{ malformed");

    const plugins = vinext({ appDir: root });
    const configPlugin = findNamedPlugin(plugins, "vinext:config") as {
      config?: (
        config: { root: string },
        env: { command: "serve"; mode: string },
      ) => Promise<unknown>;
    };

    await expect(
      configPlugin.config?.({ root }, { command: "serve", mode: "development" }),
    ).rejects.toThrow('Failed to parse "');
  });

  it("throws a TypeScript-style diagnostic for a missing extends file", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    fs.writeFileSync(
      path.join(root, "next.config.mjs"),
      "export default { typescript: { tsconfigPath: 'web.tsconfig.json' } };\n",
    );
    fs.writeFileSync(
      path.join(root, "web.tsconfig.json"),
      JSON.stringify({ extends: "./missing.base.json" }),
    );

    const plugins = vinext({ appDir: root });
    const configPlugin = findNamedPlugin(plugins, "vinext:config") as {
      config?: (
        config: { root: string },
        env: { command: "serve"; mode: string },
      ) => Promise<unknown>;
    };

    await expect(
      configPlugin.config?.({ root }, { command: "serve", mode: "development" }),
    ).rejects.toThrow(
      `Cannot read file '${path.join(fs.realpathSync(root), "missing.base.json")}'.`,
    );
  });

  it("throws a TypeScript-style diagnostic for an invalid extends value", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    fs.writeFileSync(
      path.join(root, "next.config.mjs"),
      "export default { typescript: { tsconfigPath: 'web.tsconfig.json' } };\n",
    );
    fs.writeFileSync(
      path.join(root, "web.tsconfig.json"),
      JSON.stringify({ extends: { invalid: true } }),
    );

    const plugins = vinext({ appDir: root });
    const configPlugin = findNamedPlugin(plugins, "vinext:config") as {
      config?: (
        config: { root: string },
        env: { command: "serve"; mode: string },
      ) => Promise<unknown>;
    };

    await expect(
      configPlugin.config?.({ root }, { command: "serve", mode: "development" }),
    ).rejects.toThrow("Compiler option 'extends' requires a value of type string or Array.");
  });

  it.each([
    ["leading-slash", () => "/config/leading.json"],
    ["parent-relative", () => "../shared-tsconfig.json"],
  ])("supports %s configured paths", async (_label, configPathForRoot) => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    const configuredPath = configPathForRoot();
    const absoluteConfigPath = path.join(root, configuredPath);
    fs.mkdirSync(path.dirname(absoluteConfigPath), { recursive: true });
    fs.writeFileSync(
      absoluteConfigPath,
      JSON.stringify({ compilerOptions: { paths: { selected: ["./selected.ts"] } } }),
    );
    fs.writeFileSync(
      path.join(root, "next.config.mjs"),
      `export default { typescript: { tsconfigPath: ${JSON.stringify(configuredPath)} } };\n`,
    );

    const plugins = vinext({ appDir: root });
    const configPlugin = findNamedPlugin(plugins, "vinext:config") as {
      config?: (
        config: { root: string },
        env: { command: "serve"; mode: string },
      ) => Promise<{ resolve?: Record<string, unknown> }>;
    };
    const resolvedConfig = await configPlugin.config?.(
      { root },
      { command: "serve", mode: "development" },
    );

    expect(resolvedConfig?.resolve?.alias).not.toHaveProperty("selected");
    expect(resolvedConfig?.resolve?.tsconfigPaths).toBe(false);
  });

  it.each([
    ["serve", "development"],
    ["build", "production"],
  ] as const)("uses function-form phase-specific config during %s", async (command, mode) => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    fs.writeFileSync(
      path.join(root, "next.config.mjs"),
      `export default (phase) => ({ typescript: { tsconfigPath: phase.includes('development') ? 'dev.json' : 'build.json' } });\n`,
    );
    fs.writeFileSync(
      path.join(root, "dev.json"),
      JSON.stringify({ compilerOptions: { paths: { selected: ["./dev.ts"] } } }),
    );
    fs.writeFileSync(
      path.join(root, "build.json"),
      JSON.stringify({ compilerOptions: { paths: { selected: ["./build.ts"] } } }),
    );

    const plugins = vinext({ appDir: root });
    const configPlugin = findNamedPlugin(plugins, "vinext:config") as {
      config?: (
        config: { root: string },
        env: { command: "serve" | "build"; mode: string },
      ) => Promise<{ resolve?: Record<string, unknown> }>;
    };
    const resolvedConfig = await configPlugin.config?.({ root }, { command, mode });

    expect(resolvedConfig?.resolve?.alias).not.toHaveProperty("selected");
    expect(resolvedConfig?.resolve?.tsconfigPaths).toBe(false);
  });

  it("materializes path aliases inherited via tsconfig extends on Vite 8", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "tsconfig.base.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["src/*"],
            },
          },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify(
        {
          extends: "./tsconfig.base.json",
        },
        null,
        2,
      ),
    );

    const plugins = vinext({ appDir: root });
    const configPlugin = findNamedPlugin(plugins, "vinext:config") as {
      config?: (
        config: { root: string },
        env: { command: "serve"; mode: string },
      ) => Promise<{
        resolve?: Record<string, unknown>;
      }>;
    };
    const resolvedConfig = await configPlugin.config?.(
      { root },
      { command: "serve", mode: "development" },
    );

    expect(resolvedConfig?.resolve?.alias).toEqual(
      expect.objectContaining({
        "@": "/src",
      }),
    );
  });

  it("does not override user-defined resolve.tsconfigPaths on Vite 8", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);

    const plugins = vinext({ appDir: root });
    const configPlugin = findNamedPlugin(plugins, "vinext:config") as {
      config?: (
        config: { root: string; resolve?: Record<string, unknown> },
        env: { command: "serve"; mode: string },
      ) => Promise<{
        resolve?: Record<string, unknown>;
      }>;
    };
    const resolvedConfig = await configPlugin.config?.(
      { root, resolve: { tsconfigPaths: false } },
      { command: "serve", mode: "development" },
    );

    expect(resolvedConfig?.resolve?.tsconfigPaths).toBeUndefined();
  });

  it("uses bundled Vite version from npm alias packages", async () => {
    const root = setupProject({
      name: "@voidzero-dev/vite-plus-core",
      version: "0.1.11",
      bundledVersions: { vite: "8.0.0" },
    });
    process.chdir(root);

    const plugins = vinext({ appDir: root });

    expect(findNamedPlugin(plugins, "vite-tsconfig-paths")).toBeUndefined();

    const configPlugin = findNamedPlugin(plugins, "vinext:config") as {
      config?: (
        config: { root: string },
        env: { command: "serve"; mode: string },
      ) => Promise<{
        resolve?: Record<string, unknown>;
      }>;
    };
    const resolvedConfig = await configPlugin.config?.(
      { root },
      { command: "serve", mode: "development" },
    );

    expect(resolvedConfig?.resolve?.tsconfigPaths).toBe(true);
  });

  it("falls back to Vite 7 for npm alias packages without bundled versions", async () => {
    const root = setupProject({
      name: "@voidzero-dev/vite-plus-core",
      version: "0.1.11",
    });
    process.chdir(root);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const plugins = vinext({ appDir: root });

    expect(findNamedPlugin(plugins, "vite-tsconfig-paths")).toBeDefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[vinext] Could not determine Vite major version from @voidzero-dev/vite-plus-core; assuming Vite 7",
    );
  });
});
