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
  computeLazyChunks,
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
    await fsp.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default {};`,
    );

    try {
      const mockConfig = { root: tmpDir, build: {}, plugins: [] };
      const result = await (mainPlugin as any).config(mockConfig, { command: "build" });

      expect(result.optimizeDeps?.exclude).toContain("vinext");
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
    await fsp.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default {};`,
    );

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
    await fsp.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default {};`,
    );

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
      const resultNoCf = await (mainPlugin as any).config({
        root: tmpDir,
        build: {},
        plugins: [],
      }, { command: "build" });

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
  function simulateAssetTagFiltering(
    ssrManifestFiles: string[],
    lazyChunks: string[],
  ): string[] {
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

  it("deduplicates entries when SSR manifest has leading slashes and client entry does not", () => {
    // The client entry (from __VINEXT_CLIENT_ENTRY__) uses values without
    // leading slashes ("assets/entry.js"), while SSR manifest values have
    // them ("/assets/entry.js"). After normalization, both should resolve
    // to the same key and the entry should appear only once.
    const ssrFiles = [
      "assets/entry.js",      // added first (e.g. from client entry)
      "/assets/entry.js",     // same file from SSR manifest with leading slash
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
