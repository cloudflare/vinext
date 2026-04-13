/**
 * Build optimization tests — verifies tree-shaking and chunking configuration
 * is correctly applied to client builds.
 *
 * Tests the treeshake config, manualChunks function, and minimum chunk sizing
 * to ensure large barrel-exporting libraries (e.g. mermaid) produce smaller bundles.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import {
  _augmentSsrManifestFromBundle,
  _stripServerExports,
} from "../packages/vinext/src/index.js";
import {
  createClientManualChunks,
  clientTreeshakeConfig,
  getClientTreeshakeConfigForVite,
} from "../packages/vinext/src/build/client-build-config.js";
import { computeLazyChunks } from "../packages/vinext/src/utils/lazy-chunks.js";
import { asyncHooksStubPlugin as _asyncHooksStubPlugin } from "../packages/vinext/src/plugins/async-hooks-stub.js";

// Create a clientManualChunks instance with a test shims directory.
// The exact path doesn't matter for the node_modules-focused tests;
// shims-chunk tests would need a real path.
const clientManualChunks = createClientManualChunks("/vinext/shims/");

// The vinext config hook mutates process.env.NODE_ENV as a side effect (matching
// Next.js behavior). Save/restore globally so tests that call config() don't
// pollute each other — this affects optimizeDeps, treeshake, and NODE_ENV tests.
let originalNodeEnv: string | undefined;

beforeEach(() => {
  originalNodeEnv = process.env.NODE_ENV;
});

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

function getBuildBundlerOptions(result: any) {
  return result.build?.rolldownOptions ?? result.build?.rollupOptions;
}

function getEnvBuildBundlerOptions(env: any) {
  return env?.build?.rolldownOptions ?? env?.build?.rollupOptions;
}

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

// ─── optimizeDeps.exclude — prevents esbuild scanning virtual module imports ─

describe("optimizeDeps.exclude for vinext", () => {
  it("excludes vinext at top level for Pages Router builds", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();

    const mainPlugin = plugins.find(
      (p: any) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-ts-test-optdeps-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

    try {
      const mockConfig = {
        root: tmpDir,
        build: {},
        plugins: [],
        optimizeDeps: { exclude: ["@lingui/macro"] },
      };
      const result = await (mainPlugin as any).config(mockConfig, { command: "build" });

      expect(result.optimizeDeps?.exclude).toContain("vinext");
      expect(result.optimizeDeps?.exclude).toContain("@vercel/og");
      // Incoming excludes from other plugins must survive the merge
      expect(result.optimizeDeps?.exclude).toContain("@lingui/macro");
      // No duplicates
      expect(new Set(result.optimizeDeps.exclude).size).toBe(result.optimizeDeps.exclude.length);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("merges top-level optimizeDeps.exclude from other plugins into per-environment configs", async () => {
    // Simulates plugins like @lingui/vite-plugin that add entries to
    // config.optimizeDeps.exclude before vinext's config hook runs.
    // See: https://github.com/cloudflare/vinext/issues/538
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();

    const mainPlugin = plugins.find(
      (p: any) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-ts-test-optdeps-merge-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    await fsp.mkdir(path.join(tmpDir, "app"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "app", "layout.tsx"),
      `export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }`,
    );
    await fsp.writeFile(
      path.join(tmpDir, "app", "page.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

    try {
      const mockConfig = {
        root: tmpDir,
        build: {},
        plugins: [],
        optimizeDeps: {
          // Include "vinext" to simulate overlap with vinext's own excludes
          exclude: ["@lingui/macro", "@lingui/core/macro", "vinext"],
          include: ["some-lib"],
        },
      };
      const result = await (mainPlugin as any).config(mockConfig, { command: "build" });

      // All environments should contain the incoming excludes
      for (const envName of ["rsc", "ssr", "client"]) {
        const envExclude = result.environments[envName].optimizeDeps?.exclude;
        expect(envExclude, `${envName} should contain @lingui/macro`).toContain("@lingui/macro");
        expect(envExclude, `${envName} should contain @lingui/core/macro`).toContain(
          "@lingui/core/macro",
        );
        // vinext's own excludes should still be present
        expect(envExclude, `${envName} should contain vinext`).toContain("vinext");
        expect(envExclude, `${envName} should contain @vercel/og`).toContain("@vercel/og");
        // Verify no duplicates exist (Set-based dedup works correctly even
        // when incoming config overlaps with vinext's own entries)
        expect(new Set(envExclude).size, `${envName} should have no duplicate excludes`).toBe(
          envExclude.length,
        );
      }

      // Client environment should merge incoming includes
      const clientInclude = result.environments.client.optimizeDeps?.include;
      expect(clientInclude).toContain("some-lib");
      expect(clientInclude).toContain("react");
      expect(clientInclude).toContain("react-dom");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("excludes vinext in all environments for App Router builds", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();

    const mainPlugin = plugins.find(
      (p: any) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-ts-test-optdeps-app-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    await fsp.mkdir(path.join(tmpDir, "app"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "app", "layout.tsx"),
      `export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }`,
    );
    await fsp.writeFile(
      path.join(tmpDir, "app", "page.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

    try {
      const mockConfig = { root: tmpDir, build: {}, plugins: [] };
      const result = await (mainPlugin as any).config(mockConfig, { command: "build" });

      // Top-level
      expect(result.optimizeDeps?.exclude).toContain("vinext");
      // Per-environment
      expect(result.environments.rsc.optimizeDeps?.exclude).toContain("vinext");
      expect(result.environments.ssr.optimizeDeps?.exclude).toContain("vinext");
      expect(result.environments.client.optimizeDeps?.exclude).toContain("vinext");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);
});

// ─── process.env.NODE_ENV define ─────────────────────────────────────────────

describe("process.env.NODE_ENV define", () => {
  // Ported from Next.js: test/production/pages-dir/production/test/process-env.ts
  // https://github.com/vercel/next.js/blob/canary/test/production/pages-dir/production/test/process-env.ts
  // Helper: create a temp Pages Router project and return the vinext:config plugin
  async function setupTmpProject() {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();
    const mainPlugin = plugins.find(
      (p: any) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-node-env-test-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

    return { mainPlugin: mainPlugin as any, tmpDir, fsp };
  }

  it("is injected as production for build", async () => {
    const { mainPlugin, tmpDir, fsp } = await setupTmpProject();
    try {
      const mockConfig = { root: tmpDir, build: {}, plugins: [] };
      const result = await mainPlugin.config(mockConfig, { command: "build", mode: "production" });

      expect(result.define?.["process.env.NODE_ENV"]).toBe(JSON.stringify("production"));
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("is injected as production for build without explicit mode", async () => {
    // Other tests in this file pass { command: "build" } with no mode.
    // The mode defaults to "development" via env?.mode ?? "development",
    // but command is "build" so resolvedNodeEnv should still be "production".
    const { mainPlugin, tmpDir, fsp } = await setupTmpProject();
    try {
      const mockConfig = { root: tmpDir, build: {}, plugins: [] };
      const result = await mainPlugin.config(mockConfig, { command: "build" });

      expect(result.define?.["process.env.NODE_ENV"]).toBe(JSON.stringify("production"));
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("is injected as development for serve", async () => {
    const { mainPlugin, tmpDir, fsp } = await setupTmpProject();
    try {
      const mockConfig = { root: tmpDir, build: {}, plugins: [] };
      const result = await mainPlugin.config(mockConfig, { command: "serve", mode: "development" });

      expect(result.define?.["process.env.NODE_ENV"]).toBe(JSON.stringify("development"));
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("respects user-defined process.env.NODE_ENV in config.define", async () => {
    const { mainPlugin, tmpDir, fsp } = await setupTmpProject();
    try {
      const mockConfig = {
        root: tmpDir,
        build: {},
        plugins: [],
        define: { "process.env.NODE_ENV": JSON.stringify("staging") },
      };
      const result = await mainPlugin.config(mockConfig, { command: "build", mode: "production" });

      // Should NOT override the user's explicit define
      expect(result.define?.["process.env.NODE_ENV"]).toBeUndefined();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);
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
    await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

    try {
      const mockConfig = {
        root: tmpDir,
        build: {},
        plugins: [],
      };
      const result = await (mainPlugin as any).config(mockConfig, { command: "build" });

      // treeshake should be set on bundler options for non-SSR builds
      expect(getBuildBundlerOptions(result).treeshake).toEqual({
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
    await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

    try {
      const mockConfig = {
        root: tmpDir,
        build: { ssr: "virtual:vinext-server-entry" },
        plugins: [],
      };
      const result = await (mainPlugin as any).config(mockConfig, { command: "build" });

      // treeshake should NOT be set for SSR builds
      expect(getBuildBundlerOptions(result).treeshake).toBeUndefined();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("multi-env build scopes treeshake to client environment only", async () => {
    // In App Router builds (multi-env), treeshake must NOT be set globally
    // (which would leak into RSC/SSR) — it should only appear on the client
    // environment's bundler options.
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
    await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

    try {
      const mockConfig = {
        root: tmpDir,
        build: {},
        plugins: [],
      };
      const result = await (mainPlugin as any).config(mockConfig, { command: "build" });

      // Global bundler options should NOT have treeshake (would leak into RSC/SSR)
      expect(getBuildBundlerOptions(result).treeshake).toBeUndefined();

      // Client environment should have treeshake
      expect(getEnvBuildBundlerOptions(result.environments.client).treeshake).toEqual({
        moduleSideEffects: "no-external",
      });

      // RSC and SSR environments should NOT have treeshake
      expect(getEnvBuildBundlerOptions(result.environments.rsc)?.treeshake).toBeUndefined();
      expect(getEnvBuildBundlerOptions(result.environments.ssr)?.treeshake).toBeUndefined();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("client output config includes minimum chunk sizing", async () => {
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
    await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

    try {
      const mockConfig = {
        root: tmpDir,
        build: {},
        plugins: [],
      };
      const result = await (mainPlugin as any).config(mockConfig, { command: "build" });

      // For standalone client builds (non-SSR, non-multi-env),
      // output config should include the min chunk size setting.
      const output = getBuildBundlerOptions(result).output;
      expect(output).toBeDefined();
      if (output.codeSplitting) {
        expect(output.codeSplitting.minSize).toBe(10_000);
      } else {
        expect(output.experimentalMinChunkSize).toBe(10_000);
      }
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("App Router client env gets manifest: true when Cloudflare plugin is present", async () => {
    // When deploying to Cloudflare Workers, the client environment must produce
    // a build manifest (manifest.json) so the vinext:cloudflare-build plugin can
    // read dynamicImports and compute lazy chunks. Without this, all chunks get
    // modulepreloaded on every page, defeating code-splitting for React.lazy()
    // and next/dynamic boundaries.
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();

    const mainPlugin = plugins.find(
      (p: any) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-ts-test-cf-manifest-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    // Create an app/ directory to trigger App Router multi-env mode
    await fsp.mkdir(path.join(tmpDir, "app"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "app", "layout.tsx"),
      `export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }`,
    );
    await fsp.writeFile(
      path.join(tmpDir, "app", "page.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

    try {
      // Simulate having the Cloudflare plugin in the plugin list.
      // The vinext config hook detects it by checking plugin names.
      const fakeCloudflarePlugin = { name: "vite-plugin-cloudflare" };
      const mockConfig = {
        root: tmpDir,
        build: {},
        plugins: [fakeCloudflarePlugin],
      };
      const result = await (mainPlugin as any).config(mockConfig, { command: "build" });

      // Client environment should have manifest: true for lazy chunk detection
      expect(result.environments).toBeDefined();
      expect(result.environments.client).toBeDefined();
      expect(result.environments.client.build.manifest).toBe(true);

      // Without Cloudflare plugin, manifest should NOT be set (standard App Router)
      const resultNoCf = await (mainPlugin as any).config(
        {
          root: tmpDir,
          build: {},
          plugins: [],
        },
        { command: "build" },
      );

      expect(resultNoCf.environments.client.build.manifest).toBeUndefined();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);
});

// ─── computeLazyChunks ────────────────────────────────────────────────────────

describe("computeLazyChunks", () => {
  it("returns empty array for manifest with only entry chunks", () => {
    const manifest = {
      "src/main.ts": {
        file: "assets/main-abc123.js",
        isEntry: true,
        imports: [],
      },
    };
    expect(computeLazyChunks(manifest)).toEqual([]);
  });

  it("excludes statically imported chunks from lazy set", () => {
    const manifest = {
      "src/main.ts": {
        file: "assets/main-abc123.js",
        isEntry: true,
        imports: ["src/utils.ts"],
      },
      "src/utils.ts": {
        file: "assets/utils-def456.js",
      },
    };
    expect(computeLazyChunks(manifest)).toEqual([]);
  });

  it("identifies dynamically-imported-only chunks as lazy", () => {
    const manifest = {
      "src/main.ts": {
        file: "assets/main-abc123.js",
        isEntry: true,
        imports: ["src/framework.ts"],
        dynamicImports: ["src/mermaid.ts"],
      },
      "src/framework.ts": {
        file: "assets/framework-abc.js",
      },
      "src/mermaid.ts": {
        file: "assets/mermaid-NOHMQCX5.js",
        isDynamicEntry: true,
      },
    };
    const lazy = computeLazyChunks(manifest);
    expect(lazy).toContain("assets/mermaid-NOHMQCX5.js");
    expect(lazy).not.toContain("assets/main-abc123.js");
    expect(lazy).not.toContain("assets/framework-abc.js");
  });

  it("handles transitive static imports from entry", () => {
    // entry -> A -> B (all static) — none should be lazy
    const manifest = {
      "src/main.ts": {
        file: "assets/main.js",
        isEntry: true,
        imports: ["src/a.ts"],
      },
      "src/a.ts": {
        file: "assets/a.js",
        imports: ["src/b.ts"],
      },
      "src/b.ts": {
        file: "assets/b.js",
      },
    };
    expect(computeLazyChunks(manifest)).toEqual([]);
  });

  it("handles transitive dynamic imports as lazy", () => {
    // entry -> A (static) -> B (dynamic) -> C (static from B)
    // B and C should be lazy (B is only reachable via dynamic import)
    // But C is statically imported by B, which is a dynamic entry
    // Since B is not an entry, C is only reachable through B which is lazy
    const manifest = {
      "src/main.ts": {
        file: "assets/main.js",
        isEntry: true,
        imports: ["src/a.ts"],
      },
      "src/a.ts": {
        file: "assets/a.js",
        dynamicImports: ["src/b.ts"],
      },
      "src/b.ts": {
        file: "assets/b.js",
        isDynamicEntry: true,
        imports: ["src/c.ts"],
      },
      "src/c.ts": {
        file: "assets/c.js",
      },
    };
    const lazy = computeLazyChunks(manifest);
    expect(lazy).toContain("assets/b.js");
    expect(lazy).toContain("assets/c.js");
    expect(lazy).not.toContain("assets/main.js");
    expect(lazy).not.toContain("assets/a.js");
  });

  it("does not mark CSS files as lazy", () => {
    const manifest = {
      "src/main.ts": {
        file: "assets/main.js",
        isEntry: true,
        dynamicImports: ["src/lazy.ts"],
      },
      "src/lazy.ts": {
        file: "assets/lazy.js",
        isDynamicEntry: true,
        css: ["assets/lazy-styles.css"],
      },
    };
    const lazy = computeLazyChunks(manifest);
    expect(lazy).toContain("assets/lazy.js");
    // CSS files are never in the lazy list (only .js files)
    expect(lazy).not.toContain("assets/lazy-styles.css");
  });

  it("handles chunk shared between static and dynamic paths as eager", () => {
    // If a chunk is statically imported by one module AND dynamically by another,
    // it should NOT be lazy (it's reachable statically)
    const manifest = {
      "src/main.ts": {
        file: "assets/main.js",
        isEntry: true,
        imports: ["src/shared.ts"],
        dynamicImports: ["src/lazy.ts"],
      },
      "src/shared.ts": {
        file: "assets/shared.js",
      },
      "src/lazy.ts": {
        file: "assets/lazy.js",
        isDynamicEntry: true,
        imports: ["src/shared.ts"],
      },
    };
    const lazy = computeLazyChunks(manifest);
    expect(lazy).toContain("assets/lazy.js");
    expect(lazy).not.toContain("assets/shared.js");
    expect(lazy).not.toContain("assets/main.js");
  });

  it("returns empty array for empty manifest", () => {
    expect(computeLazyChunks({})).toEqual([]);
  });

  it("handles circular static imports without infinite loop", () => {
    const manifest = {
      "src/entry.ts": {
        file: "assets/entry.js",
        isEntry: true,
        imports: ["src/a.ts"],
      },
      "src/a.ts": {
        file: "assets/a.js",
        imports: ["src/b.ts"],
      },
      "src/b.ts": {
        file: "assets/b.js",
        imports: ["src/a.ts"], // circular: b -> a -> b -> ...
      },
    };
    const lazy = computeLazyChunks(manifest);
    expect(lazy).toEqual([]);
    // All three are statically reachable from entry
  });

  it("handles multiple entry points", () => {
    const manifest = {
      "src/main.ts": {
        file: "assets/main.js",
        isEntry: true,
        imports: ["src/a.ts"],
      },
      "src/other-entry.ts": {
        file: "assets/other.js",
        isEntry: true,
        imports: ["src/b.ts"],
      },
      "src/a.ts": {
        file: "assets/a.js",
      },
      "src/b.ts": {
        file: "assets/b.js",
        dynamicImports: ["src/lazy.ts"],
      },
      "src/lazy.ts": {
        file: "assets/lazy.js",
        isDynamicEntry: true,
      },
    };
    const lazy = computeLazyChunks(manifest);
    expect(lazy).toContain("assets/lazy.js");
    expect(lazy).not.toContain("assets/main.js");
    expect(lazy).not.toContain("assets/other.js");
    expect(lazy).not.toContain("assets/a.js");
    expect(lazy).not.toContain("assets/b.js");
  });

  it("handles manifest with no entry chunks (all chunks marked lazy)", () => {
    // If no chunks have isEntry, the BFS starts with an empty queue
    // and all JS files should be classified as lazy
    const manifest = {
      "src/orphan.ts": {
        file: "assets/orphan.js",
        imports: [],
      },
      "src/other.ts": {
        file: "assets/other.js",
      },
    };
    const lazy = computeLazyChunks(manifest);
    expect(lazy).toContain("assets/orphan.js");
    expect(lazy).toContain("assets/other.js");
  });

  it("handles realistic mermaid-like scenario", () => {
    // Simulates: client entry -> page (dynamic) -> streamdown (static from page)
    //            streamdown -> mermaid (dynamic via React.lazy)
    // The page itself is dynamic from the entry (vinext pattern), but
    // mermaid is dynamic from streamdown — mermaid should be lazy
    const manifest = {
      "virtual:vinext-client-entry": {
        file: "assets/vinext-client-entry-abc.js",
        isEntry: true,
        imports: ["node_modules/react/index.js", "node_modules/react-dom/client.js"],
        dynamicImports: ["src/pages/index.tsx", "src/pages/about.tsx"],
      },
      "node_modules/react/index.js": {
        file: "assets/framework-xyz.js",
      },
      "node_modules/react-dom/client.js": {
        file: "assets/framework-xyz.js", // same chunk (manualChunks)
      },
      "src/pages/index.tsx": {
        file: "assets/index-page.js",
        isDynamicEntry: true,
        imports: ["node_modules/streamdown/index.js"],
        dynamicImports: [],
      },
      "src/pages/about.tsx": {
        file: "assets/about-page.js",
        isDynamicEntry: true,
      },
      "node_modules/streamdown/index.js": {
        file: "assets/streamdown-chunk.js",
        dynamicImports: ["node_modules/mermaid/dist/mermaid.js"],
      },
      "node_modules/mermaid/dist/mermaid.js": {
        file: "assets/mermaid-NOHMQCX5.js",
        isDynamicEntry: true,
      },
    };
    const lazy = computeLazyChunks(manifest);
    // Mermaid should be lazy — only reachable through dynamic imports
    expect(lazy).toContain("assets/mermaid-NOHMQCX5.js");
    // Pages are dynamic from entry — they should also be lazy
    expect(lazy).toContain("assets/index-page.js");
    expect(lazy).toContain("assets/about-page.js");
    // streamdown is statically imported by a page, but the page itself is
    // dynamic from entry — so streamdown is also lazy
    expect(lazy).toContain("assets/streamdown-chunk.js");
    // Framework and entry should NOT be lazy
    expect(lazy).not.toContain("assets/vinext-client-entry-abc.js");
    expect(lazy).not.toContain("assets/framework-xyz.js");
  });
});

describe("augmentSsrManifestFromBundle", () => {
  it("backfills inlined page modules with the containing entry chunk", () => {
    const bundle = {
      "assets/vinext-client-entry.js": {
        type: "chunk" as const,
        fileName: "assets/vinext-client-entry.js",
        imports: ["assets/vinext.js", "assets/framework.js"],
        modules: {
          "\0virtual:vinext-client-entry": {},
          "/app/pages/counter.tsx": {},
        },
      },
    };

    const ssrManifest = {
      "pages/counter.tsx": [],
    };

    const augmented = _augmentSsrManifestFromBundle(ssrManifest, bundle, "/app");

    expect(augmented["pages/counter.tsx"]).toEqual([
      "assets/vinext-client-entry.js",
      "assets/vinext.js",
      "assets/framework.js",
    ]);
  });

  it("adds CSS and asset metadata from the containing chunk", () => {
    const bundle = {
      "assets/about.js": {
        type: "chunk" as const,
        fileName: "assets/about.js",
        imports: [],
        modules: {
          "/app/pages/about.tsx": {},
        },
        viteMetadata: {
          importedCss: new Set(["assets/about.css"]),
          importedAssets: new Set(["assets/logo.svg"]),
        },
      },
    };

    const augmented = _augmentSsrManifestFromBundle({}, bundle, "/app");

    expect(augmented["pages/about.tsx"]).toEqual([
      "assets/about.js",
      "assets/about.css",
      "assets/logo.svg",
    ]);
  });

  it("preserves the configured base prefix and normalizes Windows paths", () => {
    const bundle = {
      "assets/counter.js": {
        type: "chunk" as const,
        fileName: "assets/counter.js",
        imports: ["assets/framework.js"],
        modules: {
          "C:\\app\\pages\\counter.tsx": {},
        },
        viteMetadata: {
          importedCss: new Set(["assets/counter.css"]),
        },
      },
    };

    const augmented = _augmentSsrManifestFromBundle({}, bundle, "C:\\app", "/docs/");

    expect(augmented["pages/counter.tsx"]).toEqual([
      "docs/assets/counter.js",
      "docs/assets/framework.js",
      "docs/assets/counter.css",
    ]);
  });

  it("preserves existing SSR manifest files while normalizing leading slashes", () => {
    const bundle = {
      "assets/about.js": {
        type: "chunk" as const,
        fileName: "assets/about.js",
        imports: [],
        modules: {
          "/app/pages/about.tsx": {},
        },
      },
    };

    const ssrManifest = {
      "pages/about.tsx": ["/assets/about.js", "/assets/about.css"],
    };

    const augmented = _augmentSsrManifestFromBundle(ssrManifest, bundle, "/app");

    expect(augmented["pages/about.tsx"]).toEqual(["assets/about.js", "assets/about.css"]);
  });

  it("normalizes existing absolute manifest keys before merging bundle metadata", () => {
    const bundle = {
      "assets/counter.js": {
        type: "chunk" as const,
        fileName: "assets/counter.js",
        imports: [],
        modules: {
          "/app/pages/counter.tsx": {},
        },
        viteMetadata: {
          importedCss: new Set(["assets/counter.css"]),
        },
      },
    };

    const ssrManifest = {
      "/app/pages/counter.tsx": ["/assets/counter.js"],
    };

    const augmented = _augmentSsrManifestFromBundle(ssrManifest, bundle, "/app");

    expect(augmented["pages/counter.tsx"]).toEqual(["assets/counter.js", "assets/counter.css"]);
    expect(augmented["/app/pages/counter.tsx"]).toBeUndefined();
  });

  it("normalizes manifest keys across symlinked project roots", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-manifest-root-"));
    const realRoot = path.join(tmpDir, "real");
    const aliasRoot = path.join(tmpDir, "alias");
    const realModulePath = path.join(realRoot, "pages", "counter.tsx");

    await fsp.mkdir(path.join(realRoot, "pages"), { recursive: true });
    await fsp.writeFile(realModulePath, "export default function Counter() { return null; }\n");
    await fsp.symlink(realRoot, aliasRoot, "junction");

    const escapedAliasKey = path.relative(aliasRoot, realModulePath).replace(/\\/g, "/");
    const bundle = {
      "assets/counter.js": {
        type: "chunk" as const,
        fileName: "assets/counter.js",
        imports: [],
        modules: {
          [realModulePath]: {},
        },
        viteMetadata: {
          importedCss: new Set(["assets/counter.css"]),
        },
      },
    };

    const ssrManifest = {
      [escapedAliasKey]: ["/assets/counter.js"],
    };

    try {
      const augmented = _augmentSsrManifestFromBundle(ssrManifest, bundle, aliasRoot);

      expect(augmented["pages/counter.tsx"]).toEqual(["assets/counter.js", "assets/counter.css"]);
      expect(augmented[escapedAliasKey]).toBeUndefined();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── collectAssetTags lazy filtering (integration) ────────────────────────────

describe("collectAssetTags lazy chunk filtering", () => {
  // collectAssetTags lives inside the generated virtual server entry and
  // can't be imported directly. These tests verify the filtering behavior
  // by simulating what collectAssetTags does: build a lazy set from
  // computeLazyChunks output, then filter asset tags accordingly.

  /**
   * Simulates the collectAssetTags filtering logic:
   * - Normalizes leading slashes from SSR manifest values
   * - CSS files always get a <link rel="stylesheet"> tag
   * - Non-lazy JS files get both modulepreload and script tags
   * - Lazy JS files are skipped entirely
   *
   * Must match the actual collectAssetTags implementation in index.ts.
   */
  function simulateAssetTagFiltering(ssrManifestFiles: string[], lazyChunks: string[]): string[] {
    const lazySet = new Set(lazyChunks);
    const tags: string[] = [];
    const seen = new Set<string>();

    for (let tf of ssrManifestFiles) {
      // Normalize: strip leading slash from SSR manifest values to avoid
      // producing protocol-relative URLs (e.g. "//assets/chunk.js") and
      // to ensure consistent matching against lazySet and seen set.
      if (tf.startsWith("/")) tf = tf.slice(1);
      if (seen.has(tf)) continue;
      seen.add(tf);
      if (tf.endsWith(".css")) {
        tags.push(`<link rel="stylesheet" href="/${tf}" />`);
      } else if (tf.endsWith(".js")) {
        if (lazySet.has(tf)) continue;
        tags.push(`<link rel="modulepreload" href="/${tf}" />`);
        tags.push(`<script type="module" src="/${tf}" crossorigin></script>`);
      }
    }
    return tags;
  }

  it("excludes lazy JS chunks from modulepreload and script tags", () => {
    const buildManifest = {
      "virtual:vinext-client-entry": {
        file: "assets/entry.js",
        isEntry: true,
        imports: ["node_modules/react/index.js"],
        dynamicImports: ["src/pages/index.tsx"],
      },
      "node_modules/react/index.js": {
        file: "assets/framework.js",
      },
      "src/pages/index.tsx": {
        file: "assets/page-index.js",
        isDynamicEntry: true,
        dynamicImports: ["node_modules/mermaid/dist/mermaid.js"],
      },
      "node_modules/mermaid/dist/mermaid.js": {
        file: "assets/mermaid-big.js",
        isDynamicEntry: true,
      },
    };

    const lazyChunks = computeLazyChunks(buildManifest);

    // SSR manifest for the index page would include these files
    const ssrFiles = [
      "assets/entry.js",
      "assets/framework.js",
      "assets/page-index.js",
      "assets/mermaid-big.js",
    ];

    const tags = simulateAssetTagFiltering(ssrFiles, lazyChunks);

    // Entry and framework should have modulepreload + script tags
    expect(tags).toContain('<link rel="modulepreload" href="/assets/entry.js" />');
    expect(tags).toContain('<script type="module" src="/assets/entry.js" crossorigin></script>');
    expect(tags).toContain('<link rel="modulepreload" href="/assets/framework.js" />');

    // Page chunk and mermaid are lazy — should have NO tags at all
    expect(tags.join("\n")).not.toContain("page-index.js");
    expect(tags.join("\n")).not.toContain("mermaid-big.js");
  });

  it("always includes CSS files even for lazy chunks", () => {
    const buildManifest = {
      "src/entry.ts": {
        file: "assets/entry.js",
        isEntry: true,
        dynamicImports: ["src/lazy.ts"],
      },
      "src/lazy.ts": {
        file: "assets/lazy.js",
        isDynamicEntry: true,
        css: ["assets/lazy.css"],
      },
    };

    const lazyChunks = computeLazyChunks(buildManifest);
    const ssrFiles = ["assets/entry.js", "assets/lazy.js", "assets/lazy.css"];
    const tags = simulateAssetTagFiltering(ssrFiles, lazyChunks);

    // CSS always included (prevents FOUC)
    expect(tags).toContain('<link rel="stylesheet" href="/assets/lazy.css" />');
    // Lazy JS excluded
    expect(tags.join("\n")).not.toContain("lazy.js");
    // Entry included
    expect(tags).toContain('<link rel="modulepreload" href="/assets/entry.js" />');
  });

  it("includes all chunks when lazy list is empty", () => {
    const buildManifest = {
      "src/entry.ts": {
        file: "assets/entry.js",
        isEntry: true,
        imports: ["src/utils.ts"],
      },
      "src/utils.ts": {
        file: "assets/utils.js",
      },
    };

    const lazyChunks = computeLazyChunks(buildManifest);
    expect(lazyChunks).toEqual([]); // nothing is lazy

    const ssrFiles = ["assets/entry.js", "assets/utils.js"];
    const tags = simulateAssetTagFiltering(ssrFiles, lazyChunks);

    // Both should be present
    expect(tags).toContain('<link rel="modulepreload" href="/assets/entry.js" />');
    expect(tags).toContain('<link rel="modulepreload" href="/assets/utils.js" />');
    expect(tags).toContain('<script type="module" src="/assets/entry.js" crossorigin></script>');
    expect(tags).toContain('<script type="module" src="/assets/utils.js" crossorigin></script>');
  });

  it("normalizes leading slashes from SSR manifest values", () => {
    // Vite's SSR manifest values include a leading "/" (from joinUrlSegments
    // with base="/"), e.g. "/assets/framework-AbCd.js". Without normalization,
    // prepending "/" produces protocol-relative URLs "//assets/..." which
    // browsers interpret as https://assets/... (wrong host).
    const buildManifest = {
      "src/entry.ts": {
        file: "assets/entry.js",
        isEntry: true,
        imports: ["node_modules/react/index.js"],
        dynamicImports: ["src/pages/index.tsx"],
      },
      "node_modules/react/index.js": {
        file: "assets/framework.js",
      },
      "src/pages/index.tsx": {
        file: "assets/page-index.js",
        isDynamicEntry: true,
      },
    };

    const lazyChunks = computeLazyChunks(buildManifest);

    // Simulate SSR manifest values WITH leading slashes (real Vite output)
    const ssrFilesWithLeadingSlash = [
      "/assets/entry.js",
      "/assets/framework.js",
      "/assets/page-index.js",
    ];

    const tags = simulateAssetTagFiltering(ssrFilesWithLeadingSlash, lazyChunks);

    // All URLs should have exactly one leading slash, not double
    for (const tag of tags) {
      expect(tag).not.toContain('href="//');
      expect(tag).not.toContain('src="//');
    }

    // Entry and framework should be present with correct single-slash paths
    expect(tags).toContain('<link rel="modulepreload" href="/assets/entry.js" />');
    expect(tags).toContain('<script type="module" src="/assets/entry.js" crossorigin></script>');
    expect(tags).toContain('<link rel="modulepreload" href="/assets/framework.js" />');

    // Page chunk is lazy — should be excluded even with leading-slash input
    expect(tags.join("\n")).not.toContain("page-index.js");
  });

  it("filters base-prefixed lazy chunks against base-prefixed SSR manifest values", () => {
    const buildManifest = {
      "src/entry.ts": {
        file: "assets/entry.js",
        isEntry: true,
        imports: ["node_modules/react/index.js"],
        dynamicImports: ["src/pages/index.tsx"],
      },
      "node_modules/react/index.js": {
        file: "assets/framework.js",
      },
      "src/pages/index.tsx": {
        file: "assets/page-index.js",
        isDynamicEntry: true,
      },
    };

    const lazyChunks = computeLazyChunks(buildManifest).map((file) => `docs/${file}`);
    const ssrFiles = [
      "docs/assets/entry.js",
      "docs/assets/framework.js",
      "docs/assets/page-index.js",
    ];
    const tags = simulateAssetTagFiltering(ssrFiles, lazyChunks);

    expect(tags).toContain('<link rel="modulepreload" href="/docs/assets/entry.js" />');
    expect(tags).toContain(
      '<script type="module" src="/docs/assets/entry.js" crossorigin></script>',
    );
    expect(tags).toContain('<link rel="modulepreload" href="/docs/assets/framework.js" />');
    expect(tags.join("\n")).not.toContain("page-index.js");
  });

  it("deduplicates entries when SSR manifest has leading slashes and client entry does not", () => {
    // The client entry (from __VINEXT_CLIENT_ENTRY__) uses values without
    // leading slashes ("assets/entry.js"), while SSR manifest values have
    // them ("/assets/entry.js"). After normalization, both should resolve
    // to the same key and the entry should appear only once.
    const ssrFiles = [
      "assets/entry.js", // added first (e.g. from client entry)
      "/assets/entry.js", // same file from SSR manifest with leading slash
      "/assets/framework.js",
    ];

    const tags = simulateAssetTagFiltering(ssrFiles, []);

    // entry.js should appear exactly once in modulepreload tags
    const entryPreloads = tags.filter((t) => t.includes("entry.js") && t.includes("modulepreload"));
    expect(entryPreloads).toHaveLength(1);

    // framework.js should also appear with correct path
    expect(tags).toContain('<link rel="modulepreload" href="/assets/framework.js" />');
  });
});

// ─── vinext:async-hooks-stub ───────────────────────────────────────────────────

describe("vinext:async-hooks-stub", () => {
  const VIRTUAL_ID = "\0vinext:async-hooks-stub";

  // The resolveId handler uses `this.environment?.name`, so we call it with a
  // mock context to control which environment is being simulated.
  function resolveId(id: string, environmentName: string | undefined): string | undefined {
    const handler = (
      _asyncHooksStubPlugin.resolveId as { handler: (id: string) => string | undefined }
    ).handler;
    return handler.call(
      { environment: environmentName ? { name: environmentName } : undefined },
      id,
    );
  }

  function load(id: string): string | undefined {
    const handler = (_asyncHooksStubPlugin.load as { handler: (id: string) => string | undefined })
      .handler;
    return handler.call({}, id);
  }

  describe("resolveId", () => {
    it("resolves node:async_hooks to virtual module in client env", () => {
      expect(resolveId("node:async_hooks", "client")).toBe(VIRTUAL_ID);
    });

    it("resolves bare async_hooks to virtual module in client env", () => {
      expect(resolveId("async_hooks", "client")).toBe(VIRTUAL_ID);
    });

    it("returns undefined in ssr environment", () => {
      expect(resolveId("node:async_hooks", "ssr")).toBeUndefined();
    });

    it("returns undefined in rsc environment", () => {
      expect(resolveId("node:async_hooks", "rsc")).toBeUndefined();
    });

    it("returns undefined when environment is undefined", () => {
      expect(resolveId("node:async_hooks", undefined)).toBeUndefined();
    });
  });

  describe("load", () => {
    it("returns stub source with AsyncLocalStorage class", () => {
      const source = load(VIRTUAL_ID);
      expect(source).toBeDefined();
      expect(source).toContain("export class AsyncLocalStorage");
      expect(source).toContain("getStore()");
      expect(source).toContain("run(_store, fn, ...args)");
    });

    it("returns undefined for other module ids", () => {
      expect(load("some-other-module")).toBeUndefined();
    });

    it("stub getStore() returns undefined and run() passes through callback return value", () => {
      const source = load(VIRTUAL_ID)!;
      // Evaluate the generated source to test actual runtime behavior, not just
      // string shape. This catches subtle syntax errors that string matching misses.
      // Strip the ES module `export` keyword so we can evaluate with new Function.
      const cjsSource = source.replace(/^export\s+/m, "") + "\nreturn AsyncLocalStorage;";
      // oxlint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- evaluating generated source is the behavior under test
      const ALS = new Function(cjsSource)() as new () => {
        getStore(): unknown;
        run(store: unknown, fn: Function, ...args: unknown[]): unknown;
        exit(fn: () => unknown): unknown;
      };
      const als = new ALS();
      expect(als.getStore()).toBeUndefined();
      expect(als.run(42, () => "result")).toBe("result");
      expect(als.run(42, (a: number, b: number) => a + b, 3, 4)).toBe(7);
      expect(als.exit(() => "exit-result")).toBe("exit-result");
    });
  });
});

// ─── stripServerExports ───────────────────────────────────────────────────────

// Note: stripServerExports runs in Vite's transform pipeline AFTER JSX and
// TypeScript have been compiled to plain JavaScript by esbuild/SWC. All test
// inputs use post-compiled JS (no JSX, no TS type annotations).
// Ported from Next.js: test/unit/babel-plugin-next-ssg-transform.test.ts
// https://github.com/vercel/next.js/blob/canary/test/unit/babel-plugin-next-ssg-transform.test.ts
describe("stripServerExports", () => {
  it("returns null when code has no server exports", () => {
    const code = `
export default function Page({ data }) {
  return data;
}
`;
    expect(_stripServerExports(code)).toBeNull();
  });

  it("strips export async function getServerSideProps", () => {
    const code = `
import db from './db';

export default function Page({ data }) {
  return data;
}

export async function getServerSideProps(ctx) {
  const data = await db.query('SELECT * FROM posts');
  return { props: { data } };
}
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).toContain("export default function Page");
    expect(result).not.toContain("db.query");
    expect(result).toContain("export function getServerSideProps()");
  });

  it("strips export function getStaticProps", () => {
    const code = `
export default function Page({ items }) {
  return items;
}

export function getStaticProps() {
  return { props: { items: ['a', 'b'] }, revalidate: 60 };
}
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).toContain("export function getStaticProps()");
    expect(result).not.toContain("revalidate: 60");
  });

  it("strips export async function getStaticPaths", () => {
    const code = `
export default function Post({ id }) {
  return id;
}

export async function getStaticPaths() {
  const paths = [{ params: { id: '1' } }, { params: { id: '2' } }];
  return { paths, fallback: false };
}

export async function getStaticProps({ params }) {
  return { props: { id: params.id } };
}
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).not.toContain("fallback: false");
    expect(result).toContain("export function getStaticPaths()");
    expect(result).toContain("export function getStaticProps()");
  });

  it("strips export const getServerSideProps = arrow function", () => {
    const code = `
export default function Page({ data }) {
  return data;
}

export const getServerSideProps = async (ctx) => {
  const res = await fetch('https://api.example.com/data');
  const data = await res.json();
  return { props: { data } };
};
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).toContain("export const getServerSideProps = undefined;");
    expect(result).not.toContain("api.example.com");
  });

  it("strips export const getServerSideProps = simple reference", () => {
    const code = `
import { fetchPageData } from '../lib/data';

export default function Page({ data }) {
  return data;
}

export const getServerSideProps = fetchPageData;
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).toContain("export const getServerSideProps = undefined;");
  });

  it("preserves the default export and non-server exports", () => {
    const code = `
import React from 'react';

export const config = { runtime: 'edge' };

export default function Page({ data }) {
  return data;
}

export async function getServerSideProps() {
  return { props: { data: 'hello' } };
}
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).toContain("export const config");
    expect(result).toContain("export default function Page");
    expect(result).toContain("export function getServerSideProps()");
    expect(result).not.toContain("data: 'hello'");
  });

  it("handles nested braces in function body", () => {
    const code = `
export default function Page({ items }) {
  return items;
}

export async function getServerSideProps() {
  const items = [];
  for (let i = 0; i < 10; i++) {
    if (i % 2 === 0) {
      items.push({ id: i, nested: { deep: true } });
    }
  }
  return { props: { items } };
}
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).toContain("export function getServerSideProps()");
    expect(result).not.toContain("nested: { deep: true }");
  });

  it("handles function expressions (= function() {})", () => {
    // This pattern broke the old regex approach because it didn't match
    // function expressions, only arrow functions.
    const code = `
export default function Page({ data }) {
  return data;
}

export const getStaticProps = function() {
  const data = fetchData();
  return { props: { data } };
};
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).toContain("export const getStaticProps = undefined;");
    expect(result).not.toContain("fetchData");
  });

  it("handles async named function expressions", () => {
    const code = `
export default function Page({ data }) {
  return data;
}

export const getServerSideProps = async function fetchData() {
  const data = await db.query();
  return { props: { data } };
};
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).toContain("export const getServerSideProps = undefined;");
    expect(result).not.toContain("db.query");
  });

  it("handles export { name } re-export syntax", () => {
    // This pattern was completely unhandled by the old regex approach.
    const code = `
const getServerSideProps = async () => {
  return { props: { data: 'secret' } };
};

export default function Page() {
  return null;
}

export { getServerSideProps };
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).toContain("export const getServerSideProps = undefined;");
    // The original local declaration remains (dead code, tree-shaken later)
    expect(result).not.toContain("export { getServerSideProps }");
  });

  it("handles export { name } with other specifiers", () => {
    const code = `
const getServerSideProps = async () => {
  return { props: {} };
};
const config = { runtime: 'edge' };

export default function Page() {
  return null;
}

export { getServerSideProps, config };
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    // config should be preserved
    expect(result).toContain("export { config }");
    expect(result).toContain("export const getServerSideProps = undefined;");
  });

  it("handles strings containing braces", () => {
    const code = `
export default function Page({ msg }) {
  return msg;
}

export async function getServerSideProps() {
  const msg = "Hello {world}";
  return { props: { msg } };
}
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).toContain("export function getServerSideProps()");
    expect(result).not.toContain("Hello {world}");
  });

  it("handles regex literals in function body", () => {
    // The old skipBalanced function didn't handle regex literals,
    // causing premature function body termination.
    const code = `
export default function Page() {
  return null;
}

export function getServerSideProps() {
  const pattern = /\\{[^}]+\\}/;
  return { props: {} };
}
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).toContain("export function getServerSideProps()");
    expect(result).not.toContain("pattern");
  });

  it("handles expression-body arrows with semicolons in strings", () => {
    const code = `
export default function Page() {
  return null;
}

export const getStaticPaths = () => [
  { params: { id: 'a;b' } },
];
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).toContain("export const getStaticPaths = undefined;");
    expect(result).not.toContain("a;b");
  });
});

// ─── getClientTreeshakeConfigForVite ──────────────────────────────────────────

describe("getClientTreeshakeConfigForVite", () => {
  it("returns preset for Vite 7 (Rollup compatibility)", () => {
    const config = getClientTreeshakeConfigForVite(7);
    expect(config).toEqual({
      preset: "recommended",
      moduleSideEffects: "no-external",
    });
  });

  it("returns config without preset for Vite 8 (Rolldown compatibility)", () => {
    const config = getClientTreeshakeConfigForVite(8);
    expect(config).toEqual({
      moduleSideEffects: "no-external",
    });
  });

  it("returns config without preset for Vite 9+", () => {
    const config9 = getClientTreeshakeConfigForVite(9);
    expect(config9).toEqual({
      moduleSideEffects: "no-external",
    });

    const config10 = getClientTreeshakeConfigForVite(10);
    expect(config10).toEqual({
      moduleSideEffects: "no-external",
    });
  });
});
