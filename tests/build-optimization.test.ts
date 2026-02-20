/**
 * Build optimization tests — verifies tree-shaking and chunking configuration
 * is correctly applied to client builds.
 *
 * Tests the treeshake config, manualChunks function, and experimentalMinChunkSize
 * to ensure large barrel-exporting libraries (e.g. mermaid) produce smaller bundles.
 */
import { describe, it, expect } from "vitest";
import {
  clientManualChunks,
  clientTreeshakeConfig,
} from "../packages/vinext/src/index.js";

// ─── clientTreeshakeConfig ────────────────────────────────────────────────────

describe("clientTreeshakeConfig", () => {
  it("uses 'recommended' preset for safe defaults", () => {
    expect(clientTreeshakeConfig.preset).toBe("recommended");
  });

  it("sets moduleSideEffects to 'no-external' for aggressive vendor DCE", () => {
    // 'no-external' marks node_modules as side-effect-free (enabling DCE for
    // barrel-heavy libraries) while preserving side effects for local modules
    // (CSS imports, polyfills).
    expect(clientTreeshakeConfig.moduleSideEffects).toBe("no-external");
  });
});

// ─── clientManualChunks ───────────────────────────────────────────────────────

describe("clientManualChunks", () => {
  it("groups react into 'framework' chunk", () => {
    expect(clientManualChunks("/node_modules/react/index.js")).toBe("framework");
  });

  it("groups react-dom into 'framework' chunk", () => {
    expect(clientManualChunks("/node_modules/react-dom/client.js")).toBe("framework");
  });

  it("groups scheduler into 'framework' chunk", () => {
    expect(clientManualChunks("/node_modules/scheduler/index.js")).toBe("framework");
  });

  it("returns undefined for other node_modules (Rollup default splitting)", () => {
    expect(clientManualChunks("/node_modules/mermaid/dist/mermaid.js")).toBeUndefined();
    expect(clientManualChunks("/node_modules/lodash-es/lodash.js")).toBeUndefined();
    expect(clientManualChunks("/node_modules/@mui/material/index.js")).toBeUndefined();
    expect(clientManualChunks("/node_modules/d3-selection/src/index.js")).toBeUndefined();
  });

  it("returns undefined for user source files", () => {
    expect(clientManualChunks("/src/components/App.tsx")).toBeUndefined();
    expect(clientManualChunks("/src/pages/index.tsx")).toBeUndefined();
  });

  it("handles pnpm-style nested node_modules paths", () => {
    const pnpmPath = "/node_modules/.pnpm/react@19.0.0/node_modules/react/index.js";
    expect(clientManualChunks(pnpmPath)).toBe("framework");
  });

  it("handles scoped package names correctly", () => {
    // Scoped packages should not be grouped into framework
    expect(clientManualChunks("/node_modules/@tanstack/react-query/index.js")).toBeUndefined();
  });
});

// ─── Treeshake config applied to Vite builds ──────────────────────────────────

describe("treeshake config integration", () => {
  it("plugin config hook applies treeshake to non-SSR builds", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();

    // Find the main vinext plugin (has a config hook)
    const mainPlugin = plugins.find(
      (p: any) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    // Simulate a client build config (no build.ssr)
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-ts-test-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fsp.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default {};`,
    );

    try {
      const mockConfig = {
        root: tmpDir,
        build: {},
        plugins: [],
      };
      const result = await (mainPlugin as any).config(mockConfig, { command: "build" });

      // treeshake should be set on rollupOptions for non-SSR builds
      expect(result.build.rollupOptions.treeshake).toEqual({
        preset: "recommended",
        moduleSideEffects: "no-external",
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("plugin config hook does NOT apply treeshake to SSR builds", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();

    const mainPlugin = plugins.find(
      (p: any) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-ts-test-ssr-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fsp.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default {};`,
    );

    try {
      const mockConfig = {
        root: tmpDir,
        build: { ssr: "virtual:vinext-server-entry" },
        plugins: [],
      };
      const result = await (mainPlugin as any).config(mockConfig, { command: "build" });

      // treeshake should NOT be set for SSR builds
      expect(result.build.rollupOptions.treeshake).toBeUndefined();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("multi-env build scopes treeshake to client environment only", async () => {
    // In App Router builds (multi-env), treeshake must NOT be set globally
    // (which would leak into RSC/SSR) — it should only appear on the client
    // environment's rollupOptions.
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();

    const mainPlugin = plugins.find(
      (p: any) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-ts-test-multienv-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    // Create an app/ directory to trigger multi-env mode (hasAppDir = true)
    await fsp.mkdir(path.join(tmpDir, "app"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "app", "layout.tsx"),
      `export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }`,
    );
    await fsp.writeFile(
      path.join(tmpDir, "app", "page.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fsp.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default {};`,
    );

    try {
      const mockConfig = {
        root: tmpDir,
        build: {},
        plugins: [],
      };
      const result = await (mainPlugin as any).config(mockConfig, { command: "build" });

      // Global rollupOptions should NOT have treeshake (would leak into RSC/SSR)
      expect(result.build.rollupOptions.treeshake).toBeUndefined();

      // Client environment should have treeshake
      expect(result.environments.client.build.rollupOptions.treeshake).toEqual({
        preset: "recommended",
        moduleSideEffects: "no-external",
      });

      // RSC and SSR environments should NOT have treeshake
      expect(result.environments.rsc.build?.rollupOptions?.treeshake).toBeUndefined();
      expect(result.environments.ssr.build?.rollupOptions?.treeshake).toBeUndefined();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("client output config includes experimentalMinChunkSize", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();

    const mainPlugin = plugins.find(
      (p: any) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-ts-test-mcs-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fsp.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default {};`,
    );

    try {
      const mockConfig = {
        root: tmpDir,
        build: {},
        plugins: [],
      };
      const result = await (mainPlugin as any).config(mockConfig, { command: "build" });

      // For standalone client builds (non-SSR, non-multi-env),
      // output config should include experimentalMinChunkSize
      const output = result.build.rollupOptions.output;
      expect(output).toBeDefined();
      expect(output.experimentalMinChunkSize).toBe(10_000);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);
});
