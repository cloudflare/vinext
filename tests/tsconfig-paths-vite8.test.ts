import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plugin, PluginOption } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";

const originalCwd = process.cwd();
let createdRoot: string | undefined;

function setupProject(vitePackageJson: Record<string, unknown>): string {
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
  fs.writeFileSync(
    path.join(root, "pages", "index.tsx"),
    "export default function Page() { return <div>hello</div>; }\n",
  );
  return root;
}

function isPlugin(plugin: PluginOption): plugin is Plugin {
  return !!plugin && !Array.isArray(plugin) && typeof plugin === "object" && "name" in plugin;
}

async function collectPlugins(plugins: PluginOption[]): Promise<Plugin[]> {
  const collected: Plugin[] = [];
  for (const plugin of plugins) {
    const resolved = await plugin;
    if (!resolved) continue;
    if (Array.isArray(resolved)) {
      collected.push(...(await collectPlugins(resolved)));
    } else if (isPlugin(resolved)) {
      collected.push(resolved);
    }
  }
  return collected;
}

async function findNamedPlugin(plugins: ReturnType<typeof vinext>, name: string) {
  const collected = await collectPlugins(plugins);
  return collected.find((plugin) => plugin.name === name);
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

    expect(await findNamedPlugin(plugins, "vite-tsconfig-paths")).toBeDefined();
  });

  it("uses resolve.tsconfigPaths on Vite 8 instead of vite-tsconfig-paths", async () => {
    const root = setupProject({ name: "vite", version: "8.0.0" });
    process.chdir(root);

    const plugins = vinext({ appDir: root });

    expect(await findNamedPlugin(plugins, "vite-tsconfig-paths")).toBeUndefined();

    const configPlugin = (await findNamedPlugin(plugins, "vinext:config")) as {
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
    const configPlugin = (await findNamedPlugin(plugins, "vinext:config")) as {
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
    const configPlugin = (await findNamedPlugin(plugins, "vinext:config")) as {
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
    const configPlugin = (await findNamedPlugin(plugins, "vinext:config")) as {
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

    expect(await findNamedPlugin(plugins, "vite-tsconfig-paths")).toBeUndefined();

    const configPlugin = (await findNamedPlugin(plugins, "vinext:config")) as {
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

    expect(await findNamedPlugin(plugins, "vite-tsconfig-paths")).toBeDefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[vinext] Could not determine Vite major version from @voidzero-dev/vite-plus-core; assuming Vite 7",
    );
  });
});
