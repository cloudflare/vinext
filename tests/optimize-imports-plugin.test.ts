import { describe, it, expect } from "vite-plus/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createOptimizeImportsPlugin } from "../packages/vinext/src/plugins/optimize-imports.js";
import type { Plugin } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";

function unwrapHook(hook: any): ((...args: any[]) => any) | undefined {
  return typeof hook === "function" ? hook : hook?.handler;
}

describe("vinext:optimize-imports plugin", () => {
  it("exists and has the correct name", () => {
    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => "/fake/root",
    ) as Plugin;
    expect(plugin.name).toBe("vinext:optimize-imports");
    expect(plugin.enforce).toBe("pre");
  });

  it("returns null for virtual modules", async () => {
    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => "/fake/root",
    ) as Plugin;
    const transform = unwrapHook(plugin.transform)!;
    const code = `import { Slot } from "radix-ui";`;
    const result = await (transform as any).call(plugin, code, "\0virtual:something");
    expect(result).toBeNull();
  });

  it("returns null for files without barrel imports", async () => {
    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => "/fake/root",
    ) as Plugin;
    const transform = unwrapHook(plugin.transform)!;
    const code = `import React from 'react';\nconst x = 1;`;
    const result = await (transform as any).call(plugin, code, "/app/page.tsx");
    expect(result).toBeNull();
  });

  it("returns null when barrel package mentioned but no resolvable entry", async () => {
    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => "/nonexistent/root",
    ) as Plugin;
    const transform = unwrapHook(plugin.transform)!;
    const code = `import { Slot } from "radix-ui";`;
    const buildStart = unwrapHook((plugin as any).buildStart);
    if (buildStart) buildStart.call(plugin);

    const result = await (transform as any).call(
      { ...plugin, environment: { name: "rsc" } },
      code,
      "/app/page.tsx",
    );
    expect(result).toBeNull();
  });

  it("picks up optimizePackageImports from vinext({ nextConfig })", async () => {
    const tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "vinext-inline-optimize-")),
    );

    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test-app" }));
    fs.mkdirSync(path.join(tmpDir, "node_modules", "custom-icons"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "node_modules", "custom-icons", "package.json"),
      JSON.stringify({ name: "custom-icons", type: "module", main: "./index.js" }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "node_modules", "custom-icons", "index.js"),
      `export { IconFoo } from "./foo";`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "node_modules", "custom-icons", "foo.js"),
      `export function IconFoo() { return null; }`,
    );

    try {
      const rawPlugins = vinext({
        nextConfig: { experimental: { optimizePackageImports: ["custom-icons"] } },
      }) as any[];
      const plugins = (
        await Promise.all(
          rawPlugins.map(async (plugin) => {
            if (plugin && typeof plugin.then === "function") return await plugin;
            return plugin;
          }),
        )
      ).flat() as Plugin[];

      const configPlugin = plugins.find((p) => p.name === "vinext:config") as Plugin & {
        config?: (...args: any[]) => Promise<any>;
      };
      const optimizePlugin = plugins.find((p) => p.name === "vinext:optimize-imports") as Plugin;

      expect(configPlugin).toBeDefined();
      expect(optimizePlugin).toBeDefined();

      await configPlugin.config?.(
        { root: tmpDir, plugins: [] },
        { command: "serve", mode: "development" },
      );

      const buildStart = unwrapHook((optimizePlugin as any).buildStart);
      if (buildStart) await buildStart.call(optimizePlugin);

      const transform = unwrapHook(optimizePlugin.transform)!;
      const result = await (transform as any).call(
        { ...optimizePlugin, environment: { name: "rsc" } },
        `import { IconFoo } from "custom-icons";\nexport default IconFoo;`,
        "/app/page.tsx",
      );

      expect(result).not.toBeNull();
      expect(result!.code).toContain(
        `import { IconFoo } from "${path.resolve(tmpDir, "node_modules", "custom-icons", "foo.js").split(path.sep).join("/")}"`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
