import { afterEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plugin, PluginOption } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";

const originalCwd = process.cwd();

function setupProject(viteVersion: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-vite-major-"));
  fs.mkdirSync(path.join(root, "pages"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "vite"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "test-project", version: "1.0.0" }, null, 2),
  );
  fs.writeFileSync(
    path.join(root, "node_modules", "vite", "package.json"),
    JSON.stringify({ name: "vite", version: viteVersion }, null, 2),
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

function findNamedPlugin(plugins: ReturnType<typeof vinext>, name: string) {
  return plugins.find((plugin): plugin is Plugin => isPlugin(plugin) && plugin.name === name);
}

afterEach(() => {
  process.chdir(originalCwd);
});

describe("Vite tsconfig paths support", () => {
  it("keeps vite-tsconfig-paths on Vite 7", async () => {
    const root = setupProject("7.3.1");
    process.chdir(root);

    const plugins = vinext({ appDir: root });

    expect(findNamedPlugin(plugins, "vite-tsconfig-paths")).toBeDefined();

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses resolve.tsconfigPaths on Vite 8 instead of vite-tsconfig-paths", async () => {
    const root = setupProject("8.0.0-beta.18");
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

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not override user-defined resolve.tsconfigPaths on Vite 8", async () => {
    const root = setupProject("8.0.0-beta.18");
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

    fs.rmSync(root, { recursive: true, force: true });
  });
});
