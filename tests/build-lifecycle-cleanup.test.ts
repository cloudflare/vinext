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

  it("does not leave process or builder state after another build hook fails", async () => {
    const previousSession = process.env.__VINEXT_PAGES_CLIENT_ASSETS_BUILD_SESSION;
    delete process.env.__VINEXT_PAGES_CLIENT_ASSETS_BUILD_SESSION;
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

    try {
      await hook.handler(builder);
      // A later plugin can throw before vinext's finalizer. Nothing should need
      // a cleanup hook in order to retry the same builder.
      await expect(Promise.reject(new Error("later plugin failed"))).rejects.toThrow(
        "later plugin failed",
      );
      expect(process.env.__VINEXT_PAGES_CLIENT_ASSETS_BUILD_SESSION).toBeUndefined();
      // oxlint-disable-next-line typescript/unbound-method
      expect(builder.build).toBe(originalBuild);
      await hook.handler(builder);
      await expect(builder.build({} as Parameters<ViteBuilder["build"]>[0])).rejects.toThrow(
        "RSC build failed",
      );
      // oxlint-disable-next-line typescript/unbound-method
      expect(builder.build).toBe(originalBuild);
      expect(process.env.__VINEXT_PAGES_CLIENT_ASSETS_BUILD_SESSION).toBeUndefined();
    } finally {
      if (previousSession === undefined)
        delete process.env.__VINEXT_PAGES_CLIENT_ASSETS_BUILD_SESSION;
      else process.env.__VINEXT_PAGES_CLIENT_ASSETS_BUILD_SESSION = previousSession;
    }
  });
});
