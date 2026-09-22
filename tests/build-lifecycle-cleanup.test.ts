import fs from "node:fs";
import path from "node:path";
import type { ViteBuilder } from "vite";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createBuildLifecyclePlugins,
  type BuildLifecycleContext,
} from "../packages/vinext/src/build/lifecycle.js";
import { resolveVinextPackageRoot } from "../packages/vinext/src/utils/vinext-root.js";

describe("Vite build lifecycle cleanup", () => {
  it("checks the standalone prerequisite before dependency upgrades", () => {
    const onPrepare = vi.fn();
    const vinextDist = path.join(resolveVinextPackageRoot(), "dist");
    const existsSync = fs.existsSync;
    const existsSpy = vi
      .spyOn(fs, "existsSync")
      .mockImplementation((candidate) =>
        candidate === vinextDist ? false : existsSync(candidate),
      );
    const context = {
      nextConfig: { output: "standalone" },
    } as BuildLifecycleContext;
    const plugins = createBuildLifecyclePlugins({
      createContext: () => context,
      isEnabled: () => true,
      onPrepare,
      shouldPrepare: () => true,
      shouldBuildPlainPages: () => false,
    });
    const hook = plugins[0]?.configResolved as { handler: (config: object) => void };

    try {
      expect(() => hook.handler({ build: {} })).toThrow("vinext dist/ not found");
      expect(onPrepare).not.toHaveBeenCalled();
    } finally {
      existsSpy.mockRestore();
    }
  });

  it("does not patch the builder across failed build attempts", async () => {
    const builder = {
      build: async () => {
        throw new Error("RSC build failed");
      },
    } as unknown as ViteBuilder;
    // oxlint-disable-next-line typescript/unbound-method
    const originalBuild = builder.build;
    const plugins = createBuildLifecyclePlugins({
      createContext: () => ({ hasAppDir: true, hasPagesDir: true }) as BuildLifecycleContext,
      isEnabled: () => true,
      shouldPrepare: () => false,
      shouldBuildPlainPages: () => false,
    });
    const hook = plugins[0]?.buildApp as { handler: (builder: ViteBuilder) => Promise<void> };

    await hook.handler(builder);
    // A later plugin can throw before vinext's finalizer. Retry must not
    // depend on a cleanup hook that Vite would never call in that case.
    await expect(builder.build({} as Parameters<ViteBuilder["build"]>[0])).rejects.toThrow(
      "RSC build failed",
    );
    // oxlint-disable-next-line typescript/unbound-method
    expect(builder.build).toBe(originalBuild);
    await hook.handler(builder);
    // oxlint-disable-next-line typescript/unbound-method
    expect(builder.build).toBe(originalBuild);
  });
});
