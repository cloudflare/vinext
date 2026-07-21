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
import { createBuilder, parseAst } from "vite";
import { augmentSsrManifestFromBundle as _augmentSsrManifestFromBundle } from "../packages/vinext/src/build/ssr-manifest.js";
import {
  hasExportAllCandidate as _hasExportAllCandidate,
  hasServerExportCandidate as _hasServerExportCandidate,
  stripServerExports as _stripServerExportsImpl,
  validatePageExports as _validatePageExports,
} from "../packages/vinext/src/plugins/strip-server-exports.js";
import {
  createClientManualChunks,
  getClientTreeshakeConfig,
  createRscFrameworkChunkOutputConfig,
  RSC_FRAMEWORK_CHUNK_TEST,
  isRscFrameworkModule,
} from "../packages/vinext/src/build/client-build-config.js";
import {
  computeDynamicImportPreloads,
  computeLazyChunks,
} from "../packages/vinext/src/utils/lazy-chunks.js";
import { transformNextDynamicPreloadMetadata as _transformNextDynamicPreloadMetadata } from "../packages/vinext/src/plugins/dynamic-preload-metadata.js";
import { collectAssetTags } from "../packages/vinext/src/server/pages-asset-tags.js";
import { setPagesClientAssets } from "../packages/vinext/src/server/pages-client-assets.js";
import { computeClientRuntimeMetadata } from "../packages/vinext/src/utils/client-runtime-metadata.js";
import { manifestFileWithBase } from "../packages/vinext/src/utils/manifest-paths.js";
import { asyncHooksStubPlugin as _asyncHooksStubPlugin } from "../packages/vinext/src/plugins/async-hooks-stub.js";
import { aliasEntriesToRecord } from "./helpers.js";

// `stripServerExports` returns `{ code, map }`; these tests assert on the
// transformed source, so unwrap to the code string (null is preserved).
const _stripServerExports = (code: string): string | null =>
  _stripServerExportsImpl(code)?.code ?? null;

// Create a clientManualChunks instance with a test shims directory.
// The exact path doesn't matter for the node_modules-focused tests;
// shims-chunk tests would need a real path.
const clientManualChunks = createClientManualChunks("/vinext/shims/");
const appClientManualChunks = createClientManualChunks("/vinext/shims/", true);

// The vinext config hook mutates process.env.NODE_ENV as a side effect (matching
// Next.js behavior). Save/restore globally so tests that call config() don't
// pollute each other — this affects optimizeDeps, treeshake, and NODE_ENV tests.
//
// We write through Reflect rather than direct assignment because Next.js's
// global.d.ts augments NodeJS.ProcessEnv to make NODE_ENV readonly at the type
// level. Node itself has no such restriction at runtime — the production code
// under test relies on being able to set NODE_ENV directly.
let originalNodeEnv: string | undefined;

beforeEach(() => {
  originalNodeEnv = process.env.NODE_ENV;
});

afterEach(() => {
  if (originalNodeEnv === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV");
  } else {
    Reflect.set(process.env, "NODE_ENV", originalNodeEnv);
  }
});

function getBuildBundlerOptions(result: any) {
  return result.build?.rolldownOptions;
}

function getEnvBuildBundlerOptions(env: any) {
  return env?.build?.rolldownOptions;
}

// ─── clientManualChunks ───────────────────────────────────────────────────────

describe("clientManualChunks", () => {
  it("groups react into 'framework' chunk", () => {
    expect(clientManualChunks("/node_modules/react/index.js")).toBe("framework");
  });

  it("groups react-dom into 'framework' chunk", () => {
    expect(clientManualChunks("/node_modules/react-dom/client.js")).toBe("framework");
  });

  it("splits the react-dom server renderer into its own 'react-dom-server' chunk", () => {
    // Next.js supports these APIs in client components:
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rsc-basic/rsc-basic.test.ts
    // Their Fizz implementation must not ride in the always-loaded framework
    // chunk when only some client routes import it.
    expect(clientManualChunks("/node_modules/react-dom/server.js")).toBe("react-dom-server");
    expect(clientManualChunks("/node_modules/react-dom/server.browser.js")).toBe(
      "react-dom-server",
    );
    expect(clientManualChunks("/node_modules/react-dom/server.edge.js")).toBe("react-dom-server");
    expect(clientManualChunks("/node_modules/react-dom/static.browser.js")).toBe(
      "react-dom-server",
    );
    expect(clientManualChunks("/node_modules/react-dom/static.edge.js")).toBe("react-dom-server");
    expect(
      clientManualChunks("/node_modules/react-dom/cjs/react-dom-server.browser.production.js"),
    ).toBe("react-dom-server");
    expect(
      clientManualChunks(
        "/node_modules/react-dom/cjs/react-dom-server-legacy.browser.production.js",
      ),
    ).toBe("react-dom-server");
    expect(clientManualChunks("/node_modules/react-dom/server.browser.js?commonjs-entry")).toBe(
      "react-dom-server",
    );
  });

  it("keeps react-dom client + shared internals + server stub in 'framework'", () => {
    expect(clientManualChunks("/node_modules/react-dom/index.js")).toBe("framework");
    expect(clientManualChunks("/node_modules/react-dom/cjs/react-dom-client.production.js")).toBe(
      "framework",
    );
    expect(clientManualChunks("/node_modules/react-dom/cjs/react-dom.production.js")).toBe(
      "framework",
    );
    // The client-side stub that throws if server APIs are called — stays with the client.
    expect(clientManualChunks("/node_modules/react-dom/server-rendering-stub.js")).toBe(
      "framework",
    );
  });

  // Bundler ids carry backslashes only on Windows, where `toSlash` is active.
  it.runIf(process.platform === "win32")(
    "classifies Windows-style backslash ids for the react-dom server split",
    () => {
      expect(clientManualChunks("C:\\proj\\node_modules\\react-dom\\server.browser.js")).toBe(
        "react-dom-server",
      );
      expect(
        clientManualChunks(
          "C:\\proj\\node_modules\\react-dom\\cjs\\react-dom-server.browser.production.js",
        ),
      ).toBe("react-dom-server");
      expect(clientManualChunks("C:\\proj\\node_modules\\react-dom\\client.js")).toBe("framework");
      expect(
        clientManualChunks("C:\\proj\\node_modules\\react-dom\\server-rendering-stub.js"),
      ).toBe("framework");
    },
  );

  it("groups scheduler into 'framework' chunk", () => {
    expect(clientManualChunks("/node_modules/scheduler/index.js")).toBe("framework");
  });

  it("returns undefined for other node_modules (default graph splitting)", () => {
    expect(clientManualChunks("/node_modules/mermaid/dist/mermaid.js")).toBeUndefined();
    expect(clientManualChunks("/node_modules/lodash-es/lodash.js")).toBeUndefined();
    expect(clientManualChunks("/node_modules/@mui/material/index.js")).toBeUndefined();
    expect(clientManualChunks("/node_modules/d3-selection/src/index.js")).toBeUndefined();
  });

  it("returns undefined for user source files", () => {
    expect(clientManualChunks("/src/components/App.tsx")).toBeUndefined();
    expect(clientManualChunks("/src/pages/index.tsx")).toBeUndefined();
  });

  it("keeps shared vinext shims in the runtime chunk", () => {
    expect(clientManualChunks("/vinext/shims/link.js")).toBe("vinext");
    expect(clientManualChunks("/vinext/shims/navigation.js")).toBe("vinext");
    expect(appClientManualChunks("/vinext/shims/navigation.js")).toBe("vinext");
  });

  it("leaves App Router route-owned client shims behind their dynamic boundaries", () => {
    expect(appClientManualChunks("/vinext/shims/compat-router.js")).toBeUndefined();
    expect(appClientManualChunks("/vinext/shims/dynamic.js")).toBeUndefined();
    expect(appClientManualChunks("/vinext/shims/link.js")).toBeUndefined();
    expect(appClientManualChunks("/vinext/shims/router.ts")).toBeUndefined();
    expect(appClientManualChunks("/vinext/shims/image.tsx?client")).toBeUndefined();
    expect(
      appClientManualChunks("/vinext/shims/internal/hybrid-client-route-owner.js"),
    ).toBeUndefined();
    expect(appClientManualChunks("/vinext/shims/legacy-image.tsx")).toBeUndefined();
    expect(appClientManualChunks("/vinext/shims/layout-segment-context.js")).toBeUndefined();
    expect(appClientManualChunks("/vinext/shims/web-vitals.ts")).toBeUndefined();
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
  const rscClientShimExcludes = [
    "vinext/shims/error-boundary",
    "vinext/shims/form",
    "vinext/shims/layout-segment-context",
    "vinext/shims/link",
    "vinext/shims/script",
    "vinext/shims/slot",
    "vinext/shims/offline",
  ];

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
      const result = await (mainPlugin as any).config(mockConfig, {
        command: "build",
      });

      expect(result.optimizeDeps?.exclude).toContain("vinext");
      expect(result.optimizeDeps?.exclude).toContain("@vercel/og");
      // Incoming excludes from other plugins must survive the merge
      expect(result.optimizeDeps?.exclude).toContain("@lingui/macro");
      // No duplicates
      expect(new Set(result.optimizeDeps.exclude).size).toBe(result.optimizeDeps.exclude.length);
      expect(result.environments.ssr.resolve.external).toContain("typescript");
      expect(result.define?.["process.env.__VINEXT_HAS_PAGES_ROUTER"]).toBe('"true"');
      expect(
        aliasEntriesToRecord(result.resolve.alias)["vinext/server/pages-client-assets"],
      ).toMatch(/server\/pages-client-assets\.ts$/);
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
      const result = await (mainPlugin as any).config(mockConfig, {
        command: "build",
      });

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
      const result = await (mainPlugin as any).config(mockConfig, {
        command: "build",
      });

      // Top-level
      expect(result.optimizeDeps?.exclude).toContain("vinext");
      // Per-environment
      expect(result.environments.rsc.optimizeDeps?.exclude).toContain("vinext");
      expect(result.environments.ssr.optimizeDeps?.exclude).toContain("vinext");
      expect(result.environments.client.optimizeDeps?.exclude).toContain("vinext");
      expect(result.define?.["process.env.__VINEXT_HAS_PAGES_ROUTER"]).toBe('"false"');
      for (const shimExclude of rscClientShimExcludes) {
        expect(result.optimizeDeps?.exclude).toContain(shimExclude);
        expect(result.environments.rsc.optimizeDeps?.exclude).toContain(shimExclude);
        expect(result.environments.ssr.optimizeDeps?.exclude).toContain(shimExclude);
        expect(result.environments.client.optimizeDeps?.exclude).toContain(shimExclude);
      }
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("does not externalize the built App Router request handler from a source checkout", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const mainPlugin = vinext().find(
      (plugin: any) => plugin.name === "vinext:config" && typeof plugin.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-rsc-handler-source-"));
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

    try {
      const devConfig = await (mainPlugin as any).config(
        { root: tmpDir, build: {}, plugins: [] },
        { command: "serve" },
      );
      expect(devConfig.environments.rsc.resolve.external).not.toContain(
        "vinext/server/app-rsc-handler",
      );
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  // Regression for #1103: when the user sets `ssr.external: true`, plugin-rsc's
  // crawlFrameworkPkgs adds React to environments.ssr.optimizeDeps.include and
  // Vite pre-bundles a second React copy into deps_ssr/. Externalized callers
  // (vinext's runtime) and SSR-transformed 'use client' modules then end up
  // with two distinct React module records, leaving React.H null and crashing
  // every useContext / useSyncExternalStore call. The fix excludes React from
  // the SSR optimizer so deps_ssr/ stays React-free.
  const ssrExternalReactEntries = [
    "react",
    "react-dom",
    "react-dom/server.edge",
    "react-dom/static.edge",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "react-server-dom-webpack/client.edge",
  ];

  async function setupAppRouterConfigTest(prefix: string) {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const mainPlugin = vinext().find(
      (plugin: any) => plugin.name === "vinext:config" && typeof plugin.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    await fsp.symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    await fsp.mkdir(path.join(root, "app"), { recursive: true });
    await fsp.writeFile(
      path.join(root, "app", "layout.tsx"),
      `export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }`,
    );
    await fsp.writeFile(
      path.join(root, "app", "page.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fsp.writeFile(path.join(root, "next.config.mjs"), `export default {};`);

    return {
      config(userConfig: Record<string, unknown> = {}, command: "serve" | "build" = "serve") {
        return (mainPlugin as any).config(
          { root, build: {}, plugins: [], ...userConfig },
          { command },
        );
      },
      cleanup: () => fsp.rm(root, { recursive: true, force: true }),
    };
  }

  it("excludes React from ssr optimizeDeps when ssr.external: true (App Router)", async () => {
    const fixture = await setupAppRouterConfigTest("vinext-optdeps-react-true-");

    try {
      const result = await fixture.config({ ssr: { external: true } });

      const ssrExclude = result.environments.ssr.optimizeDeps?.exclude ?? [];
      for (const entry of ssrExternalReactEntries) {
        expect(ssrExclude, `ssr exclude should contain ${entry}`).toContain(entry);
      }
      // RSC env still needs the react-server condition pre-bundled, so React
      // must NOT be excluded there.
      const rscExclude = result.environments.rsc.optimizeDeps?.exclude ?? [];
      expect(rscExclude).not.toContain("react");
      expect(rscExclude).not.toContain("react-dom");
      // Top-level ssr.noExternal: true also needs to be skipped — Vite
      // applies top-level ssr.* as defaults for environments.ssr.*, so
      // setting noExternal: true here would force-bundle React despite
      // external: true and recreate the duplicate-React bug.
      expect(result.ssr?.noExternal).toBeUndefined();
      expect(result.ssr?.external).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, 15000);

  it("externalizes React from the SSR transform graph only in default Node dev", async () => {
    const fixture = await setupAppRouterConfigTest("vinext-optdeps-react-default-");

    try {
      const devResult = await fixture.config();

      const devExternal = devResult.environments.ssr.resolve.external ?? [];
      const devExclude = devResult.environments.ssr.optimizeDeps?.exclude ?? [];
      for (const entry of ssrExternalReactEntries) {
        expect(devExternal, `dev SSR external should contain ${entry}`).toContain(entry);
        expect(devExclude, `dev SSR exclude should contain ${entry}`).toContain(entry);
      }

      const buildResult = await fixture.config({}, "build");
      const buildExternal = buildResult.environments.ssr.resolve.external ?? [];
      const buildExclude = buildResult.environments.ssr.optimizeDeps?.exclude ?? [];
      for (const entry of ssrExternalReactEntries) {
        expect(buildExternal, `build SSR external should NOT contain ${entry}`).not.toContain(
          entry,
        );
        expect(buildExclude, `build SSR exclude should NOT contain ${entry}`).not.toContain(entry);
      }
    } finally {
      await fixture.cleanup();
    }
  }, 15000);

  it("does not externalize React from adapter-managed SSR environments", async () => {
    const fixture = await setupAppRouterConfigTest("vinext-ssr-react-adapter-");

    try {
      const result = await fixture.config({
        plugins: [{ name: "vite-plugin-cloudflare" }],
      });

      const ssrExclude = result.environments.ssr.optimizeDeps?.exclude ?? [];
      for (const entry of ssrExternalReactEntries) {
        expect(ssrExclude, `adapter SSR exclude should NOT contain ${entry}`).not.toContain(entry);
      }
      expect(result.environments.ssr.resolve).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  }, 15000);

  it("preserves user SSR externals while externalizing React in Node dev", async () => {
    const fixture = await setupAppRouterConfigTest("vinext-optdeps-react-array-");

    try {
      const result = await fixture.config({ ssr: { external: ["pg"] } });

      const ssrExternal = result.environments.ssr.resolve.external ?? [];
      const ssrExclude = result.environments.ssr.optimizeDeps?.exclude ?? [];
      expect(ssrExternal).toContain("pg");
      for (const entry of ssrExternalReactEntries) {
        expect(ssrExternal, `ssr external should contain ${entry}`).toContain(entry);
        expect(ssrExclude, `ssr exclude should contain ${entry}`).toContain(entry);
      }
    } finally {
      await fixture.cleanup();
    }
  }, 15000);

  // Regression: `ipaddr.js` is imported by the next/image client shim for
  // server-side private-IP validation. It's already in ssr.resolve.external,
  // but the SSR dep optimizer would still pre-bundle it on first request,
  // producing a `(ssr) ✨ new dependencies optimized: ipaddr.js` log and the
  // accompanying full reload. Excluding it from the SSR optimizer avoids the
  // reload; runtime resolution still works via resolve.external (Node) or the
  // worker bundle (Cloudflare/Nitro).
  it("excludes ipaddr.js from the SSR optimizer (App Router)", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();
    const mainPlugin = plugins.find(
      (p: any) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-ts-test-optdeps-ipaddr-app-"));
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
      const result = await (mainPlugin as any).config(mockConfig, {
        command: "serve",
      });

      const ssrExclude = result.environments.ssr.optimizeDeps?.exclude ?? [];
      expect(ssrExclude).toContain("ipaddr.js");

      // The client environment must NOT exclude ipaddr.js — next/image is a
      // 'use client' component and the browser optimizer still needs to
      // pre-bundle the CJS module into ESM for client-side validation.
      const clientExclude = result.environments.client.optimizeDeps?.exclude ?? [];
      expect(clientExclude).not.toContain("ipaddr.js");

      // RSC env doesn't render the client image shim, so we leave its
      // optimizer alone — ipaddr.js shouldn't appear in either direction.
      const rscExclude = result.environments.rsc.optimizeDeps?.exclude ?? [];
      expect(rscExclude).not.toContain("ipaddr.js");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("excludes ipaddr.js from the SSR optimizer (Pages Router on Node)", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();
    const mainPlugin = plugins.find(
      (p: any) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");

    const tmpDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), "vinext-ts-test-optdeps-ipaddr-pages-"),
    );
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

    try {
      const mockConfig = { root: tmpDir, build: {}, plugins: [] };
      const result = await (mainPlugin as any).config(mockConfig, {
        command: "serve",
      });

      const ssrExclude = result.environments?.ssr?.optimizeDeps?.exclude ?? [];
      expect(ssrExclude).toContain("ipaddr.js");
      expect(
        result.environments?.ssr?.optimizeDeps?.rolldownOptions?.transform?.define?.[
          "process.env.NODE_ENV"
        ],
      ).toBe(JSON.stringify("development"));
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("seeds Cloudflare Pages Router worker optimizer entries during dev", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();
    const mainPlugin = plugins.find(
      (p: any) =>
        p.name === "vinext:config" &&
        typeof p.config === "function" &&
        typeof p.configEnvironment === "function",
    );
    expect(mainPlugin).toBeDefined();

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-cf-pages-dev-optdeps-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fsp.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

    try {
      await (mainPlugin as any).config(
        {
          root: tmpDir,
          build: {},
          plugins: [{ name: "vite-plugin-cloudflare" }],
        },
        { command: "serve" },
      );

      const workerEnvConfig = {
        optimizeDeps: {
          entries: ["already-present.ts"],
          include: ["already-included"],
          exclude: ["already-excluded"],
        },
      };
      (mainPlugin as any).configEnvironment("worker", workerEnvConfig);

      expect(workerEnvConfig.optimizeDeps.entries).toContain("already-present.ts");
      expect(workerEnvConfig.optimizeDeps.entries).toContain("pages/**/*.{tsx,ts,jsx,js}");
      expect(workerEnvConfig.optimizeDeps.include).toContain("already-included");
      expect(workerEnvConfig.optimizeDeps.include).toContain("react");
      expect(workerEnvConfig.optimizeDeps.include).toContain("react-dom");
      expect(workerEnvConfig.optimizeDeps.include).toContain("react-dom/server.edge");
      expect(workerEnvConfig.optimizeDeps.include).toContain(
        "use-sync-external-store/with-selector",
      );
      expect(workerEnvConfig.optimizeDeps.exclude).toContain("already-excluded");
      expect(workerEnvConfig.optimizeDeps.exclude).toContain("vinext");
      expect(workerEnvConfig.optimizeDeps.exclude).toContain("vinext/server/fetch-handler");
      expect(workerEnvConfig.optimizeDeps.exclude).toContain("vinext/server/pages-router-entry");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("suppresses missing optional Cloudflare Pages Router worker optimizer warnings", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();
    const mainPlugin = plugins.find(
      (p: any) =>
        p.name === "vinext:config" &&
        typeof p.config === "function" &&
        typeof p.configResolved === "function",
    );
    expect(mainPlugin).toBeDefined();

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-cf-pages-dev-optwarn-"));
    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

    try {
      await (mainPlugin as any).config(
        {
          root: tmpDir,
          build: {},
          plugins: [{ name: "vite-plugin-cloudflare" }],
        },
        { command: "serve" },
      );

      const warned: string[] = [];
      const logger = {
        hasWarned: false,
        info() {},
        warn(msg: string) {
          warned.push(msg);
        },
        warnOnce(msg: string) {
          warned.push(msg);
        },
        error() {},
        clearScreen() {},
        hasErrorLogged() {
          return false;
        },
      };

      await (mainPlugin as any).configResolved({
        cacheDir: path.join(tmpDir, "node_modules", ".vite"),
        command: "serve",
        configFile: false,
        environments: {},
        logger,
        plugins: [],
      });

      logger.warn(
        "Failed to resolve dependency: use-sync-external-store/with-selector, present in worker 'optimizeDeps.include'",
      );
      logger.warn(
        "Failed to resolve dependency: \x1b[36muse-sync-external-store/with-selector\x1b[39m, present in worker 'optimizeDeps.include'",
      );
      logger.warn(
        "Failed to resolve dependency: other-package, present in worker 'optimizeDeps.include'",
      );

      expect(warned).toEqual([
        "Failed to resolve dependency: other-package, present in worker 'optimizeDeps.include'",
      ]);
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
      const result = await mainPlugin.config(mockConfig, {
        command: "build",
        mode: "production",
      });

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
      const result = await mainPlugin.config(mockConfig, {
        command: "serve",
        mode: "development",
      });

      expect(result.define?.["process.env.NODE_ENV"]).toBe(JSON.stringify("development"));
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("is injected as production for preview", async () => {
    const { mainPlugin, tmpDir, fsp } = await setupTmpProject();
    try {
      const mockConfig = { root: tmpDir, build: {}, plugins: [] };
      const result = await mainPlugin.config(mockConfig, {
        command: "serve",
        mode: "production",
        isPreview: true,
      });

      expect(result.define?.["process.env.NODE_ENV"]).toBe(JSON.stringify("production"));
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
      const result = await mainPlugin.config(mockConfig, {
        command: "build",
        mode: "production",
      });

      // Should NOT override the user's explicit define
      expect(result.define?.["process.env.NODE_ENV"]).toBeUndefined();
      expect(
        result.optimizeDeps?.rolldownOptions?.transform?.define?.["process.env.NODE_ENV"],
      ).toBe(JSON.stringify("staging"));
      expect(
        result.environments?.ssr?.optimizeDeps?.rolldownOptions?.transform?.define?.[
          "process.env.NODE_ENV"
        ],
      ).toBe(JSON.stringify("staging"));
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
      const result = await (mainPlugin as any).config(mockConfig, {
        command: "build",
      });

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
      const result = await (mainPlugin as any).config(mockConfig, {
        command: "build",
      });

      // treeshake should NOT be set for SSR builds
      expect(getBuildBundlerOptions(result).treeshake).toBeUndefined();
      expect(result.ssr.external).toContain("typescript");
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
    const clientAssetsDefaultsPlugin = plugins.find(
      (p: any) =>
        p.name === "vinext:css-url-assets-defaults" && typeof p.configEnvironment === "function",
    );
    expect(mainPlugin).toBeDefined();
    expect(clientAssetsDefaultsPlugin).toBeDefined();

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
      const result = await (mainPlugin as any).config(mockConfig, {
        command: "build",
      });

      // Global bundler options should NOT have treeshake (would leak into RSC/SSR)
      expect(getBuildBundlerOptions(result).treeshake).toBeUndefined();
      expect(result.build.assetsInlineLimit).toBeUndefined();

      // Client environment should have treeshake
      expect(getEnvBuildBundlerOptions(result.environments.client).treeshake).toEqual({
        moduleSideEffects: "no-external",
      });
      expect(result.environments.client.build.assetsInlineLimit).toBe(0);

      // RSC and SSR environments should NOT have treeshake
      expect(getEnvBuildBundlerOptions(result.environments.rsc)?.treeshake).toBeUndefined();
      expect(getEnvBuildBundlerOptions(result.environments.ssr)?.treeshake).toBeUndefined();
      expect(result.environments.rsc.build.assetsInlineLimit).toBeUndefined();
      expect(result.environments.ssr.build.assetsInlineLimit).toBeUndefined();

      expect(
        (clientAssetsDefaultsPlugin as any).configEnvironment("client", {}, { command: "build" }),
      ).toEqual({
        build: { assetsInlineLimit: 0 },
      });
      expect(
        (clientAssetsDefaultsPlugin as any).configEnvironment("ssr", {}, { command: "build" }),
      ).toEqual({
        build: {
          rolldownOptions: {
            output: {
              assetFileNames: expect.any(Function),
            },
          },
        },
      });
      const customAssetFileNames = "custom/[name][extname]";
      expect(
        (clientAssetsDefaultsPlugin as any).configEnvironment(
          "ssr",
          {
            build: {
              rolldownOptions: { output: { assetFileNames: customAssetFileNames } },
            },
          },
          { command: "build" },
        ),
      ).toBeNull();
      expect(
        (clientAssetsDefaultsPlugin as any).configEnvironment(
          "ssr",
          {
            build: {
              rolldownOptions: {
                output: [{ entryFileNames: "first.js" }, { chunkFileNames: "second.js" }],
              },
            },
          },
          { command: "build" },
        ),
      ).toBeNull();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("resolves CSS URL asset inline defaults through Vite's builder lifecycle", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-css-assets-env-"));
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

    try {
      const defaultBuilder = await createBuilder({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir })],
        logLevel: "silent",
      });

      expect(defaultBuilder.environments.client.config.build.assetsInlineLimit).toBe(0);
      expect(defaultBuilder.environments.rsc.config.build.assetsInlineLimit).not.toBe(0);
      expect(defaultBuilder.environments.ssr.config.build.assetsInlineLimit).not.toBe(0);

      const userAssetsInlineLimit = 1234;
      const userBuilder = await createBuilder({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir })],
        logLevel: "silent",
        build: {
          assetsInlineLimit: userAssetsInlineLimit,
        },
      });

      expect(userBuilder.environments.client.config.build.assetsInlineLimit).toBe(
        userAssetsInlineLimit,
      );
      expect(userBuilder.environments.rsc.config.build.assetsInlineLimit).toBe(
        userAssetsInlineLimit,
      );
      expect(userBuilder.environments.ssr.config.build.assetsInlineLimit).toBe(
        userAssetsInlineLimit,
      );
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

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
      const result = await (mainPlugin as any).config(mockConfig, {
        command: "build",
      });

      // For standalone client builds (non-SSR, non-multi-env),
      // output config should include the min chunk size setting.
      const output = getBuildBundlerOptions(result).output;
      expect(output).toBeDefined();
      expect(output.entryFileNames).toBe("_next/static/chunks/[name]-[hash].js");
      expect(output.chunkFileNames).toBe("_next/static/chunks/[name]-[hash].js");
      if (output.codeSplitting) {
        expect(output.codeSplitting.minSize).toBe(10_000);
      } else {
        expect(output.experimentalMinChunkSize).toBe(10_000);
      }
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("App Router client env gets manifest: true for dynamic preload metadata", async () => {
    // App Router production rendering uses Vite's client manifest to map
    // next/dynamic module IDs to the chunk files that need rendered preload
    // hints. Cloudflare builds also read it during closeBundle to inject those
    // globals into the Worker entry.
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
      const result = await (mainPlugin as any).config(mockConfig, {
        command: "build",
      });

      // Client environment should have manifest: true for lazy chunk detection
      // and rendered next/dynamic preload metadata.
      expect(result.environments).toBeDefined();
      expect(result.environments.client).toBeDefined();
      expect(result.environments.client.build.manifest).toBe(true);

      // Node production App Router needs the same manifest at startProdServer()
      // time, so this is no longer Cloudflare-only.
      const resultNoCf = await (mainPlugin as any).config(
        {
          root: tmpDir,
          build: {},
          plugins: [],
        },
        { command: "build" },
      );

      expect(resultNoCf.environments.client.build.manifest).toBe(true);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("App Router client env also emits the Pages client entry when pages/ exists", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();

    const mainPlugin = plugins.find(
      (p: any) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-ts-test-hybrid-entry-"));
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
    await fsp.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "pages", "legacy.tsx"),
      `export default function Legacy() { return <h1>Legacy</h1>; }`,
    );
    await fsp.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

    try {
      const result = await (mainPlugin as any).config(
        {
          root: tmpDir,
          build: {},
          plugins: [],
        },
        { command: "build" },
      );

      expect(result.environments.client.build.manifest).toBe(true);
      expect(result.environments.client.build.ssrManifest).toBe(true);
      expect(getEnvBuildBundlerOptions(result.environments.client).input).toEqual({
        index: "virtual:vinext-app-browser-entry",
        "vinext-client-entry": "virtual:vinext-client-entry",
      });
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

describe("computeDynamicImportPreloads", () => {
  it("maps each dynamic import to its own JS and static dependency files", () => {
    const manifest = {
      "virtual:vinext-app-browser-entry": {
        file: "_next/static/app-entry.js",
        isEntry: true,
        imports: ["node_modules/react/index.js"],
        dynamicImports: ["app/dynamic/widget.tsx"],
      },
      "node_modules/react/index.js": {
        file: "_next/static/framework.js",
      },
      "app/dynamic/widget.tsx": {
        file: "_next/static/widget.js",
        isDynamicEntry: true,
        imports: ["app/dynamic/widget-helper.ts"],
        css: ["_next/static/widget.css"],
      },
      "app/dynamic/widget-helper.ts": {
        file: "_next/static/widget-helper.js",
      },
      "app/dynamic/unrelated.tsx": {
        file: "_next/static/unrelated.js",
        isDynamicEntry: true,
      },
    };

    expect(computeDynamicImportPreloads(manifest)).toEqual({
      "app/dynamic/widget.tsx": [
        "_next/static/widget.js",
        "_next/static/widget.css",
        "_next/static/widget-helper.js",
      ],
    });
  });

  it("does not pull nested dynamic imports into the parent boundary", () => {
    const manifest = {
      "app/page.tsx": {
        file: "_next/static/page.js",
        isEntry: true,
        dynamicImports: ["app/dynamic/chart.tsx"],
      },
      "app/dynamic/chart.tsx": {
        file: "_next/static/chart.js",
        isDynamicEntry: true,
        dynamicImports: ["app/dynamic/heavy-vendor.ts"],
      },
      "app/dynamic/heavy-vendor.ts": {
        file: "_next/static/heavy-vendor.js",
        isDynamicEntry: true,
      },
    };

    expect(computeDynamicImportPreloads(manifest)).toEqual({
      "app/dynamic/chart.tsx": ["_next/static/chart.js"],
      "app/dynamic/heavy-vendor.ts": ["_next/static/heavy-vendor.js"],
    });
  });
});

// Returns the AST node-type of each argument of the FIRST `dynamic(...)` call in
// `code`. Used to prove the loader is preserved as argument 0 (not collapsed
// into a SequenceExpression) after the options object is injected.
function firstDynamicCallArgTypes(code: string): (string | undefined)[] {
  let call: { arguments?: { type?: string }[] } | undefined;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    const callee = n.callee as Record<string, unknown> | undefined;
    if (n.type === "CallExpression" && callee?.type === "Identifier" && callee.name === "dynamic") {
      call ??= n as { arguments?: { type?: string }[] };
    }
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(parseAst(code));
  return (call?.arguments ?? []).map((a) => a?.type);
}

describe("next/dynamic preload metadata transform", () => {
  const root = path.resolve("/repo");
  const importer = path.join(root, "app/page.tsx");
  const resolveDynamicImport = async (specifier: string) =>
    specifier === "./dynamic-widget"
      ? path.join(root, "app/dynamic-widget.tsx")
      : specifier === "./named"
        ? path.join(root, "app/named.tsx")
        : specifier === "./ignored"
          ? path.join(root, "app/ignored.tsx")
          : null;

  it("adds loadableGenerated modules to dynamic loader calls", async () => {
    const result = await _transformNextDynamicPreloadMetadata(
      [
        `import dynamic from "next/dynamic";`,
        `const Widget = dynamic(() => import("./dynamic-widget"), { loading: Loading });`,
      ].join("\n"),
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result?.code).toContain(`loadableGenerated: { modules: ["app/dynamic-widget.tsx"] }`);
  });

  it("preserves existing explicit loadableGenerated metadata", async () => {
    const code = [
      `import dynamic from "next/dynamic";`,
      `const Widget = dynamic(() => import("./dynamic-widget"), { loadableGenerated: { modules: ["custom"] } });`,
    ].join("\n");
    const result = await _transformNextDynamicPreloadMetadata(
      code,
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result).toBeNull();
  });

  it("supports the object loader form", async () => {
    const result = await _transformNextDynamicPreloadMetadata(
      [
        `import dynamic from "next/dynamic";`,
        `const Widget = dynamic({ loader: () => import("./named"), ssr: true });`,
      ].join("\n"),
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result?.code).toContain(`loadableGenerated: { modules: ["app/named.tsx"] }`);
  });

  it("does not transform a function parameter that shadows the next/dynamic import", async () => {
    const code = [
      `import dynamic from "next/dynamic";`,
      `function makeThing(dynamic) {`,
      `  return dynamic(() => import("./dynamic-widget"));`,
      `}`,
    ].join("\n");
    const result = await _transformNextDynamicPreloadMetadata(
      code,
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result).toBeNull();
  });

  it("does not transform an arrow parameter that shadows the next/dynamic import", async () => {
    const code = [
      `import dynamic from "next/dynamic";`,
      `const makeThing = (dynamic) => dynamic(() => import("./dynamic-widget"));`,
    ].join("\n");
    const result = await _transformNextDynamicPreloadMetadata(
      code,
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result).toBeNull();
  });

  it("does not transform a block binding that shadows the next/dynamic import", async () => {
    const code = [
      `import dynamic from "next/dynamic";`,
      `{`,
      `  const dynamic = customFactory;`,
      `  dynamic(() => import("./dynamic-widget"));`,
      `}`,
    ].join("\n");
    const result = await _transformNextDynamicPreloadMetadata(
      code,
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result).toBeNull();
  });

  it("does not transform a switch case binding that shadows the next/dynamic import", async () => {
    const code = [
      `import dynamic from "next/dynamic";`,
      `switch (kind) {`,
      `  case "x":`,
      `    const dynamic = customFactory;`,
      `    dynamic(() => import("./dynamic-widget"));`,
      `}`,
    ].join("\n");
    const result = await _transformNextDynamicPreloadMetadata(
      code,
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result).toBeNull();
  });

  it("does not transform inside a named class expression that shadows the next/dynamic import", async () => {
    const code = [
      `import dynamic from "next/dynamic";`,
      `const Component = class dynamic {`,
      `  static Widget = dynamic(() => import("./dynamic-widget"));`,
      `};`,
    ].join("\n");
    const result = await _transformNextDynamicPreloadMetadata(
      code,
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result).toBeNull();
  });

  it("transforms renamed next/dynamic imports", async () => {
    const result = await _transformNextDynamicPreloadMetadata(
      [
        `import loadDynamic from "next/dynamic";`,
        `const Widget = loadDynamic(() => import("./dynamic-widget"));`,
      ].join("\n"),
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result?.code).toContain(`loadableGenerated: { modules: ["app/dynamic-widget.tsx"] }`);
  });

  it("only records the object-form loader import", async () => {
    const result = await _transformNextDynamicPreloadMetadata(
      [
        `import dynamic from "next/dynamic";`,
        `const Widget = dynamic({`,
        `  loader: () => import("./dynamic-widget"),`,
        `  debugOnly: () => import("./ignored"),`,
        `});`,
      ].join("\n"),
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result?.code).toContain(`loadableGenerated: { modules: ["app/dynamic-widget.tsx"] }`);
    expect(result?.code).not.toContain("app/ignored.tsx");
  });

  it("transforms dynamic imports with whitespace between import and paren", async () => {
    const result = await _transformNextDynamicPreloadMetadata(
      [
        `import dynamic from "next/dynamic";`,
        `const Widget = dynamic(() => import ("./dynamic_widget"), { loading: Loading });`,
      ].join("\n"),
      importer,
      root,
      async (specifier) =>
        specifier === "./dynamic_widget" ? path.join(root, "app/dynamic_widget.tsx") : null,
    );

    expect(result?.code).toContain(`loadableGenerated: { modules: ["app/dynamic_widget.tsx"] }`);
  });

  it("transforms generic next/dynamic calls in TSX-shaped source after type stripping", async () => {
    // Vite's built-in TS transform strips type annotations and JSX before
    // the transform hook runs, so dynamic<Props>(args) becomes dynamic(args)
    // and { loading: () => <div /> } becomes { loading: () => ... }.
    // This test verifies the post-strip JS passes through parseAst correctly.
    const result = await _transformNextDynamicPreloadMetadata(
      [
        `import dynamic from "next/dynamic";`,
        `const Widget = dynamic(`,
        `  () => import("./dynamic-widget"),`,
        `  { loading: () => null },`,
        `);`,
      ].join("\n"),
      importer,
      root,
      async (specifier) =>
        specifier === "./dynamic-widget" ? path.join(root, "app/dynamic-widget.tsx") : null,
    );

    expect(result?.code).toContain(`loadableGenerated: { modules: ["app/dynamic-widget.tsx"] }`);
  });

  it("preserves existing loadableGenerated metadata in object-form dynamic options", async () => {
    const code = [
      `import dynamic from "next/dynamic";`,
      `const Widget = dynamic({`,
      `  loader: () => import("./dynamic-widget"),`,
      `  loadableGenerated: { modules: ["custom"] },`,
      `});`,
    ].join("\n");

    const result = await _transformNextDynamicPreloadMetadata(
      code,
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result).toBeNull();
  });

  it("injects metadata into nested dynamic() calls without clobbering each other", async () => {
    // Guards the MagicString disjoint-region invariant: the inner call edits a
    // region inside the outer call's options object; both must land intact.
    const code = [
      `import dynamic from "next/dynamic";`,
      `const Outer = dynamic(() => import("./dynamic-widget"), {`,
      `  loading: dynamic(() => import("./named")),`,
      `});`,
    ].join("\n");

    const result = await _transformNextDynamicPreloadMetadata(
      code,
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result?.code).toContain(`loadableGenerated: { modules: ["app/dynamic-widget.tsx"] }`);
    expect(result?.code).toContain(`loadableGenerated: { modules: ["app/named.tsx"] }`);
    // The output must still parse (disjoint edits produced valid JS).
    expect(() => parseAst(result!.code)).not.toThrow();
  });

  it("throws when a dynamic() call has more than 2 arguments (Next.js parity)", async () => {
    const code = [
      `import dynamic from "next/dynamic";`,
      `const W = dynamic(() => import("./dynamic-widget"), {}, "extra");`,
    ].join("\n");

    await expect(
      _transformNextDynamicPreloadMetadata(code, importer, root, resolveDynamicImport),
    ).rejects.toThrow(/only accepts 2 arguments/);
  });

  it("preserves a comment containing a comma between the loader and close paren", async () => {
    // Regression: the previous substring-`,` scan overwrote this region and ate
    // the comment. The comment-aware trailing-comma check now leaves it intact.
    const code = [
      `import dynamic from "next/dynamic";`,
      `const W = dynamic(() => import("./dynamic-widget") /* trailing , comment */);`,
    ].join("\n");

    const result = await _transformNextDynamicPreloadMetadata(
      code,
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result?.code).toContain(`loadableGenerated: { modules: ["app/dynamic-widget.tsx"] }`);
    expect(result?.code).toContain(`/* trailing , comment */`);
    expect(() => parseAst(result!.code)).not.toThrow();
  });

  it("does not corrupt a parenthesized loader into a sequence expression", async () => {
    // Regression guard: oxc reports an arrow's `end` BEFORE a wrapping paren, so
    // inserting the options at firstArg.end lands inside the parens and collapses
    // the loader into a sequence expression (dropping it). Insertion must happen
    // at the call's closing paren instead.
    const code = [
      `import dynamic from "next/dynamic";`,
      `const W = dynamic((() => import("./dynamic-widget")));`,
    ].join("\n");

    const result = await _transformNextDynamicPreloadMetadata(
      code,
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result?.code).toContain(`loadableGenerated: { modules: ["app/dynamic-widget.tsx"] }`);

    // The dynamic() call must still receive TWO arguments and the first must be
    // the loader (an arrow), not a SequenceExpression.
    expect(firstDynamicCallArgTypes(result!.code)).toEqual([
      "ArrowFunctionExpression",
      "ObjectExpression",
    ]);
  });

  it("supports the bare-promise loader form dynamic(import(...))", async () => {
    // The only shape that drives an ImportExpression (not an arrow/object) into
    // the close-paren insertion path. The loader must stay arg 0.
    const result = await _transformNextDynamicPreloadMetadata(
      [
        `import dynamic from "next/dynamic";`,
        `const W = dynamic(import("./dynamic-widget"));`,
      ].join("\n"),
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result?.code).toContain(`loadableGenerated: { modules: ["app/dynamic-widget.tsx"] }`);
    expect(firstDynamicCallArgTypes(result!.code)).toEqual([
      "ImportExpression",
      "ObjectExpression",
    ]);
  });

  it("supports a parenthesized bare-promise loader dynamic((import(...)))", async () => {
    const result = await _transformNextDynamicPreloadMetadata(
      [
        `import dynamic from "next/dynamic";`,
        `const W = dynamic((import("./dynamic-widget")));`,
      ].join("\n"),
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result?.code).toContain(`loadableGenerated: { modules: ["app/dynamic-widget.tsx"] }`);
    expect(firstDynamicCallArgTypes(result!.code)).toEqual([
      "ImportExpression",
      "ObjectExpression",
    ]);
  });

  it("does not emit a double comma when the loader already has a trailing comma", async () => {
    const code = [
      `import dynamic from "next/dynamic";`,
      `const W = dynamic(() => import("./dynamic-widget"),);`,
    ].join("\n");

    const result = await _transformNextDynamicPreloadMetadata(
      code,
      importer,
      root,
      resolveDynamicImport,
    );

    // Exact output isolates the comment-aware separator choice: a naive
    // always-`", "` separator would emit `…,)`->`…, { … },)` (double comma); the
    // pre-existing trailing comma must instead be consumed as the separator.
    expect(result?.code).toBe(
      [
        `import dynamic from "next/dynamic";`,
        `const W = dynamic(() => import("./dynamic-widget"), { loadableGenerated: { modules: ["app/dynamic-widget.tsx"] } });`,
      ].join("\n"),
    );
    expect(firstDynamicCallArgTypes(result!.code)).toEqual([
      "ArrowFunctionExpression",
      "ObjectExpression",
    ]);
  });

  it("does not throw on >2 args when the dynamic binding is shadowed", async () => {
    // The >2-argument throw must apply ONLY to the real next/dynamic import, not
    // a shadowed local binding of the same name.
    const code = [
      `import dynamic from "next/dynamic";`,
      `function make(dynamic) { return dynamic(a, b, c); }`,
    ].join("\n");

    const result = await _transformNextDynamicPreloadMetadata(
      code,
      importer,
      root,
      resolveDynamicImport,
    );

    expect(result).toBeNull();
  });

  it("normalises a symlinked resolved path to the real root-relative manifest key", async () => {
    // pnpm/Cloudflare resolve modules through symlinks; the resolved id may not
    // share the (possibly symlinked) root prefix. Without realpath normalisation
    // the module is dropped and the preload silently disappears.
    const realRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-dpm-real-"));
    const linkParent = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-dpm-link-"));
    const linkRoot = path.join(linkParent, "root");
    try {
      await fsp.mkdir(path.join(realRoot, "app"), { recursive: true });
      await fsp.writeFile(path.join(realRoot, "app", "widget.tsx"), "export default () => null;");
      await fsp.symlink(realRoot, linkRoot, "dir");

      const code = [
        `import dynamic from "next/dynamic";`,
        `const W = dynamic(() => import("./app/widget"));`,
      ].join("\n");

      // root = SYMLINK path; resolver returns the REAL path (the mismatch case).
      const result = await _transformNextDynamicPreloadMetadata(
        code,
        path.join(linkRoot, "page.tsx"),
        linkRoot,
        async () => path.join(realRoot, "app", "widget.tsx"),
      );

      expect(result?.code).toContain(`loadableGenerated: { modules: ["app/widget.tsx"] }`);
    } finally {
      await fsp.rm(realRoot, { recursive: true, force: true });
      await fsp.rm(linkParent, { recursive: true, force: true });
    }
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

  it("collapses a basePath that Vite duplicated in the SSR manifest", () => {
    // basePath baked into fileNames + reapplied by Vite yields a doubled URL
    // that 404s; both sources must dedupe to one single-base path here.
    const bundle = {
      "docs/_next/static/_slug_.js": {
        type: "chunk" as const,
        fileName: "docs/_next/static/_slug_.js",
        imports: [],
        modules: {
          "/proj/pages/[slug].tsx": {},
        },
      },
    };

    const ssrManifest = {
      "pages/[slug].tsx": ["docs/docs/_next/static/_slug_.js"],
    };

    const augmented = _augmentSsrManifestFromBundle(ssrManifest, bundle, "/proj", "/docs/");

    expect(augmented["pages/[slug].tsx"]).toEqual(["docs/_next/static/_slug_.js"]);
  });

  it("leaves a single basePath prefix untouched (no over-collapse)", () => {
    // Guards the collapse logic against rewriting a correctly single-prefixed
    // entry (e.g. when the bundler does not bake base into fileNames).
    const ssrManifest = {
      "pages/index.tsx": ["docs/_next/static/index.js"],
    };

    const augmented = _augmentSsrManifestFromBundle(ssrManifest, {}, "/proj", "/docs/");

    expect(augmented["pages/index.tsx"]).toEqual(["docs/_next/static/index.js"]);
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
  // Drive the REAL exported `collectAssetTags` (server/pages-asset-tags.ts) so
  // these tests can't drift from production. The thin adapter keeps the original
  // `(ssrManifestFiles, lazyChunks) -> string[]` shape: it wires the lazy set
  // through the runtime asset registry the function actually reads, feeds the
  // files as a single page module, and disables optimized
  // loading (no `defer`) to match the legacy assertions.
  function simulateAssetTagFiltering(ssrManifestFiles: string[], lazyChunks: string[]): string[] {
    setPagesClientAssets({ lazyChunks });
    try {
      const html = collectAssetTags({
        manifest: { "page.js": ssrManifestFiles },
        moduleIds: ["page.js"],
        disableOptimizedLoading: true,
      });
      return html ? html.split("\n  ") : [];
    } finally {
      setPagesClientAssets(undefined);
    }
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
    // The client entry from the Pages client asset descriptor uses values without
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

  it("excludes lazy chunks from modulepreload end-to-end under basePath + assetPrefix", async () => {
    // Round-trip regression guard for the lazy-chunk key-space fix. It wires the
    // real PRODUCER (computeClientRuntimeMetadata, reading a manifest from disk)
    // to the real CONSUMER (collectAssetTags). If lazy chunks were ever
    // asset-prefixed again, their key-space would diverge from the base-relative
    // SSR-manifest values and the lazy chunk would leak into <link rel=modulepreload>.
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-roundtrip-"));
    const clientDir = path.join(tmpDir, "client");
    await fsp.mkdir(path.join(clientDir, ".vite"), { recursive: true });
    // A real assetPrefix build bakes the prefix into the manifest `file` fields
    // (build.assetsDir = "<prefix>/_next/static").
    const manifest = {
      "virtual:vinext-client-entry": {
        file: "cdn/_next/static/chunks/entry-abc.js",
        isEntry: true,
        dynamicImports: ["src/widget.tsx"],
      },
      "src/widget.tsx": {
        file: "cdn/_next/static/chunks/widget-def.js",
        isDynamicEntry: true,
      },
    };
    await fsp.writeFile(path.join(clientDir, ".vite", "manifest.json"), JSON.stringify(manifest));
    try {
      const metadata = computeClientRuntimeMetadata({
        clientDir,
        assetBase: "/docs/",
        assetPrefix: "/cdn",
      });
      // Producer: lazy chunks are base-only (NOT asset-prefixed) — the on-disk
      // file already carries the cdn prefix and base "/docs/" is prepended.
      expect(metadata.lazyChunks).toEqual(["docs/cdn/_next/static/chunks/widget-def.js"]);

      // The SSR manifest stores the SAME base-normalized values (the backfill
      // uses manifestFileWithBase(file, base)); derive them identically.
      const ssrFiles = [
        manifestFileWithBase(manifest["virtual:vinext-client-entry"].file, "/docs/"),
        manifestFileWithBase(manifest["src/widget.tsx"].file, "/docs/"),
      ];

      // Consumer: the real collectAssetTags must exclude the lazy widget chunk
      // while keeping the eager entry chunk. Assert by basename (presence /
      // absence), NOT the exact href: the precise URL collectAssetTags renders
      // for the basePath+path-assetPrefix combo is subject to a separate,
      // pre-existing asset-URL bug (it emits the base+prefix form rather than the
      // assetPrefix-only form), which is out of scope for this lazy-exclusion
      // guard.
      const tags = simulateAssetTagFiltering(ssrFiles, metadata.lazyChunks!);
      expect(tags.some((t) => t.includes("modulepreload") && t.includes("entry-abc.js"))).toBe(
        true,
      );
      expect(tags.some((t) => t.includes("widget-def.js"))).toBe(false);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── vinext:async-hooks-stub ───────────────────────────────────────────────────

describe("vinext:async-hooks-stub", () => {
  const VIRTUAL_ID = "\0vinext:async-hooks-stub";

  // The resolveId handler uses `this.environment?.name`, so we call it with a
  // mock context to control which environment is being simulated.
  function resolveId(id: string, environmentName: string | undefined): string | undefined {
    const handler = (
      _asyncHooksStubPlugin.resolveId as {
        handler: (id: string) => string | undefined;
      }
    ).handler;
    return handler.call(
      { environment: environmentName ? { name: environmentName } : undefined },
      id,
    );
  }

  function load(id: string): string | undefined {
    const handler = (
      _asyncHooksStubPlugin.load as {
        handler: (id: string) => string | undefined;
      }
    ).handler;
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
  it("cheaply identifies modules that can contain server data exports", () => {
    expect(
      _hasServerExportCandidate("export const getServerSideProps = () => ({ props: {} })"),
    ).toBe(true);
    expect(_hasServerExportCandidate("export default function Page() {}")).toBe(false);
  });

  it("cheaply identifies export-all syntax without matching multiplication", () => {
    expect(_hasExportAllCandidate(`export * from './other-page';`)).toBe(true);
    expect(_hasExportAllCandidate(`export\n*\nfrom './other-page';`)).toBe(true);
    expect(_hasExportAllCandidate(`export /* comment */ * from './other-page';`)).toBe(true);
    expect(_hasExportAllCandidate(`export // comment\n* from './other-page';`)).toBe(true);
    expect(_hasExportAllCandidate(`export const area = width * height;`)).toBe(false);
  });

  it("rejects export-all declarations in page modules", () => {
    // Ported from Next.js: test/production/re-export-all-exports-from-page-disallowed/
    // re-export-all-exports-from-page-disallowed.test.ts
    expect(() => _stripServerExports(`export * from './other-page';`)).toThrow(
      "Using `export * from '...'` in a page is disallowed.",
    );
    expect(() => _validatePageExports(`export\n*\nfrom './other-page';`)).toThrow(
      "Using `export * from '...'` in a page is disallowed.",
    );
    expect(() => _validatePageExports(`export /* comment */ * from './other-page';`)).toThrow(
      "Using `export * from '...'` in a page is disallowed.",
    );
  });

  it("allows export-star text that is not an export-all declaration", () => {
    expect(() =>
      _validatePageExports(`const message = "export * from './not-code'";`),
    ).not.toThrow();
  });

  it("rejects mixed getServerSideProps and static data exports", () => {
    // Ported from Next.js: test/unit/babel-plugin-next-ssg-transform.test.ts
    const message =
      "You can not use getStaticProps or getStaticPaths with getServerSideProps. To use SSG, please remove getServerSideProps";
    expect(() =>
      _stripServerExports(`
export function getStaticProps() {}
export function getServerSideProps() {}
`),
    ).toThrow(message);
    expect(() =>
      _stripServerExports(`
export { getServerSideProps } from './ssr';
export { getStaticPaths } from './ssg';
`),
    ).toThrow(message);
  });

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
    expect(result).not.toContain("getServerSideProps");
  });

  it("preserves sibling declarators in exported variable declarations", () => {
    // Ported from Next.js:
    // crates/next-custom-transforms/tests/fixture/strip-page-exports/getStaticProps/support-multiple-export-var-decl
    const result = _stripServerExports(`
export const other = 0,
  getStaticProps = async () => {};
`);
    expect(result).toContain("export const other = 0;");
    expect(result).not.toContain("getStaticProps");
    expect(() => parseAst(result!)).not.toThrow();
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
    expect(result).not.toContain("getStaticProps");
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
    expect(result).not.toContain("getStaticPaths");
    expect(result).not.toContain("getStaticProps");
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
    expect(result).not.toContain("getServerSideProps");
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
    expect(result).not.toContain("getServerSideProps");
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
    expect(result).not.toContain("getServerSideProps");
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
    expect(result).not.toContain("getServerSideProps");
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
    expect(result).not.toContain("getStaticProps");
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
    expect(result).not.toContain("getServerSideProps");
    expect(result).not.toContain("db.query");
  });

  it("handles export { name } re-export syntax", () => {
    // This pattern was completely unhandled by the old regex approach.
    //
    // Regression test for #1354: emitting `export const getServerSideProps =
    // undefined;` here collides with the existing local `const
    // getServerSideProps` binding and triggers a parse error under
    // OXC/Rolldown. We must drop the specifier without adding a stub.
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
    // The `export { getServerSideProps }` statement must be removed entirely
    // — no stub declaration is added.
    expect(result).not.toContain("export { getServerSideProps }");
    expect(result).not.toContain("export const getServerSideProps");
    // Next.js removes the now-unreferenced local declaration in the same
    // transform pass rather than relying on bundler tree-shaking.
    const constMatches = result!.match(/const getServerSideProps\b/g) ?? [];
    expect(constMatches).toHaveLength(0);
    // The transformed code must be valid JS (no redeclaration).
    expect(() => parseAst(result!)).not.toThrow();
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
    // config should be preserved, getServerSideProps specifier dropped.
    expect(result).toContain("export { config }");
    expect(result).not.toContain("export { getServerSideProps");
    expect(result).not.toContain("export const getServerSideProps");
    expect(() => parseAst(result!)).not.toThrow();
  });

  // Regression test for #1354: every supported declaration form must
  // produce parseable output when combined with `export { name }`.
  it("does not redeclare identifiers for function-declaration + named export", () => {
    const code = `
async function getServerSideProps() {
  return { props: {} };
}

export default function Page() {
  return null;
}

export { getServerSideProps };
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).not.toContain("export const getServerSideProps");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("rejects mixed named getServerSideProps and getStaticProps exports", () => {
    const code = `
const getServerSideProps = async () => ({ props: {} });
const getStaticProps = async () => ({ props: {} });

export default function Page() {
  return null;
}

export { getServerSideProps, getStaticProps };
`;
    expect(() => _stripServerExports(code)).toThrow(
      "You can not use getStaticProps or getStaticPaths with getServerSideProps. To use SSG, please remove getServerSideProps",
    );
  });

  it("does not redeclare identifiers when local `let` binding is re-exported", () => {
    const code = `
let getStaticPaths = async () => ({ paths: [], fallback: false });

export default function Page() {
  return null;
}

export { getStaticPaths };
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).not.toContain("export const getStaticPaths");
    // Must not introduce a `const getStaticPaths` next to the `let`.
    expect(result).not.toMatch(/const\s+getStaticPaths/);
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("handles aliased named export (export { local as getServerSideProps })", () => {
    const code = `
const fetchData = async () => ({ props: {} });

export default function Page() {
  return null;
}

export { fetchData as getServerSideProps };
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).not.toContain("getServerSideProps");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("preserves aliased data-export bindings still used by client code", () => {
    // Matches Next.js next-ssg-transform: the export edge is removed, but the
    // local binding remains when the default export still references it.
    const code = `
const loader = () => 'visible';
export { loader as getServerSideProps };
export default function Page() { return loader(); }
`;
    const result = _stripServerExports(code);
    expect(result).toContain("const loader");
    expect(result).toContain("return loader()");
    expect(result).not.toContain("getServerSideProps");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("preserves aliased data-export bindings with another named export", () => {
    const code = `
function loader() { return 'visible'; }
export { loader as getStaticProps, loader as helper };
export default function Page() { return null; }
`;
    const result = _stripServerExports(code);
    expect(result).toContain("function loader()");
    expect(result).toContain("export { loader as helper }");
    expect(result).not.toContain("getStaticProps");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("strips server data exports re-exported from another module", () => {
    // Ported from Next.js: test/unit/babel-plugin-next-ssg-transform.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/unit/babel-plugin-next-ssg-transform.test.ts
    const code = `
export { getStaticPaths, loadPage as getStaticProps, default } from './server-page';
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).toContain("export { default }");
    expect(result).not.toContain("getStaticPaths");
    expect(result).not.toContain("getStaticProps");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("removes a re-export statement containing only server data exports", () => {
    const code = `
export { getServerSideProps } from './server-props';
export default function Page() { return null; }
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).not.toContain("./server-props");
    expect(result).toContain("export default function Page");
  });

  it("strips legacy server data export names", () => {
    const code = `
export { unstable_getServerProps, unstable_getStaticProps } from './legacy-data';
export default function Page() { return null; }
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).not.toContain("legacy-data");
  });

  it("sweeps imports and helpers used only by a direct server export", () => {
    // Ported from Next.js: test/unit/babel-plugin-next-ssg-transform.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/unit/babel-plugin-next-ssg-transform.test.ts
    const code = `
import secretDb, { shared as keepShared, serverOnly as dropServerOnly } from './db';

function loadSecret() {
  return secretDb.query(dropServerOnly);
}

export default function Page() {
  return keepShared;
}

export async function getServerSideProps() {
  return { props: { secret: await loadSecret() } };
}
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).toContain("shared as keepShared");
    expect(result).not.toContain("secretDb");
    expect(result).not.toContain("dropServerOnly");
    expect(result).not.toContain("loadSecret");
    expect(result).not.toContain(".query");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("sweeps recursive arrow helpers used only by a server export", () => {
    const result = _stripServerExports(`
const recurse = () => recurse();

export function getStaticProps() {
  recurse();
  return { props: {} };
}

export default function Page() { return null; }
`);
    expect(result).not.toContain("recurse");
    expect(result).toContain("export default function Page");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("sweeps mutually recursive arrow helpers used only by a server export", () => {
    const result = _stripServerExports(`
const first = () => second();
const second = () => first();

export function getStaticProps() {
  first();
  return { props: {} };
}

export default function Page() { return null; }
`);
    expect(result).not.toContain("first");
    expect(result).not.toContain("second");
    expect(result).toContain("export default function Page");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("sweeps dependencies of locally declared re-exported data functions", () => {
    const code = `
import { PRIVATE_TOKEN } from './secrets';

const buildProps = () => ({ props: { token: PRIVATE_TOKEN } });
const getServerSideProps = () => buildProps();

export default function Page() { return null; }
export { getServerSideProps };
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).not.toContain("PRIVATE_TOKEN");
    expect(result).not.toContain("./secrets");
    expect(result).not.toContain("buildProps");
    expect(result).not.toContain("export { getServerSideProps }");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("does not treat shadowed client identifiers as live server references", () => {
    const code = `
import { PRIVATE_TOKEN } from './secrets';

export default function Page(PRIVATE_TOKEN) {
  return PRIVATE_TOKEN;
}

export function getServerSideProps() {
  return { props: { token: PRIVATE_TOKEN } };
}
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).not.toContain("./secrets");
    expect(result).toContain("function Page(PRIVATE_TOKEN)");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("resolves nested class and named-function-expression shadowing", () => {
    const code = `
import { PRIVATE_TOKEN } from './secrets';

export default function Page() {
  class PRIVATE_TOKEN {}
  const factory = function PRIVATE_TOKEN() { return PRIVATE_TOKEN; };
  return [PRIVATE_TOKEN, factory];
}

export function getServerSideProps() {
  return { props: { token: PRIVATE_TOKEN } };
}
`;
    const result = _stripServerExports(code);
    expect(result).not.toContain("./secrets");
    expect(result).toContain("class PRIVATE_TOKEN");
    expect(result).toContain("function PRIVATE_TOKEN()");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("does not over-remove bindings shadowed in loop scope", () => {
    const code = `
import { PRIVATE_TOKEN } from './secrets';

export default function Page() {
  for (const PRIVATE_TOKEN of ['visible']) {
    console.log(PRIVATE_TOKEN);
  }
  return null;
}

export function getServerSideProps() {
  return { props: { token: PRIVATE_TOKEN } };
}
`;
    const result = _stripServerExports(code);
    expect(result).not.toContain("./secrets");
    expect(result).toContain("const PRIVATE_TOKEN of");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("retains computed assignment-key dependencies in preserved code", () => {
    const code = `
import { sharedKey, serverOnly } from './data';
const target = {};
target[sharedKey] = 'visible';
export default function Page() { return target; }
export function getStaticProps() { return { props: { serverOnly } }; }
`;
    const result = _stripServerExports(code);
    expect(result).toContain("sharedKey");
    expect(result).not.toContain("serverOnly");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("removes classes used only by server data functions", () => {
    const code = `
import secretBase from './secret-base';

class SecretLoader extends secretBase {
  load() { return 'secret'; }
}

export function getServerSideProps() {
  return { props: { value: new SecretLoader().load() } };
}

export default function Page() { return null; }
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).not.toContain("SecretLoader");
    expect(result).not.toContain("secret-base");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("partially prunes object destructuring dependencies", () => {
    // Ported from Next.js: test/unit/babel-plugin-next-ssg-transform.test.ts
    const code = `
import fs from 'fs';
import other from 'other';

const { readFile, readdir, access: secretAccess } = fs.promises;
const { a, b, cat: bar, ...secretRest } = other;

export async function getStaticProps() {
  readFile;
  readdir;
  secretAccess;
  b;
  secretRest;
  return { props: {} };
}

export default function Page() { return a + bar; }
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).not.toContain("from 'fs'");
    expect(result).toContain("{ a, cat: bar }");
    expect(result).not.toContain("secretRest");
    expect(result).not.toMatch(/\bb\b/);
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("preserves computed object destructuring keys", () => {
    const code = `
import source from 'source';
const key = 'visible';
const { [key]: visible, secret } = source;
export function getStaticProps() { return { props: { secret } }; }
export default function Page() { return visible; }
`;
    const result = _stripServerExports(code);
    expect(result).toContain("{ [key]: visible } = source");
    expect(result).not.toMatch(/\bsecret\b/);
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("partially prunes array destructuring dependencies", () => {
    // Ported from Next.js: test/unit/babel-plugin-next-ssg-transform.test.ts
    const code = `
import fs from 'fs';
import other from 'other';

const [secretA, secretB, ...secretRest] = fs.promises;
const [visible, secretTail] = other;

export async function getStaticProps() {
  secretA;
  secretB;
  secretRest;
  secretTail;
  return { props: {} };
}

export default function Page() { return visible; }
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).not.toContain("from 'fs'");
    expect(result).toContain("const [visible] = other");
    expect(result).not.toContain("secretTail");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("preserves array positions when pruning a leading binding", () => {
    const code = `
import source from 'source';
const [secret, visible] = source;
export function getStaticProps() { return { props: { secret } }; }
export default function Page() { return visible; }
`;
    const result = _stripServerExports(code);
    expect(result).toContain("const [, visible] = source");
    expect(result).not.toMatch(/\bsecret\b/);
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("removes assignments rooted in eliminated server bindings", () => {
    const code = `
import secret from './secret';

let getServerSideProps = () => ({ props: {} });
getServerSideProps.config = secret;
getServerSideProps = () => ({ props: { secret } });

export { getServerSideProps };
export default function Page() { return null; }
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).not.toContain("./secret");
    expect(result).not.toContain(".config");
    expect(result).not.toContain("props: { secret }");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("removes Babel-style memoized helpers used only by data exports", () => {
    // Ported from Next.js:
    // crates/next-custom-transforms/tests/fixture/strip-page-exports/getStaticProps/support-babel-style-memoized-function
    const code = `
function loadSecret() {
  loadSecret = function () {};
  return loadSecret.apply(this, arguments);
}
export function getStaticProps() {
  loadSecret;
  return { props: {} };
}
export default function Page() { return null; }
`;
    const result = _stripServerExports(code);
    expect(result).not.toContain("loadSecret");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("retains dependencies shared with preserved exports", () => {
    // Ported from Next.js:
    // crates/next-custom-transforms/tests/fixture/strip-page-exports/getStaticProps/not-remove-import-used-in-other-export
    const code = `
import { shared, serverOnly } from 'thing';
export function otherExport() { return shared + serverOnly; }
export function getStaticProps() { return { props: { serverOnly } }; }
export default function Page() { return shared; }
`;
    const result = _stripServerExports(code);
    expect(result).toContain("shared");
    expect(result).toContain("serverOnly");
    expect(result).toContain("otherExport");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("partially prunes array destructuring assignments", () => {
    // Ported from Next.js:
    // crates/next-custom-transforms/tests/fixture/strip-page-exports/getStaticProps/destructuring-assignment-array
    const code = `
import fs from 'fs';
import other from 'other';
let secretA, secretB, secretRest;
[secretA, secretB, ...secretRest] = fs.promises;
let visible, secretTail;
[visible, secretTail] = other;

export async function getStaticProps() {
  secretA; secretB; secretRest; secretTail;
  return { props: {} };
}
export default function Page() { return visible; }
`;
    const result = _stripServerExports(code);
    expect(result).not.toBeNull();
    expect(result).not.toContain("from 'fs'");
    expect(result).toContain("[visible] = other");
    expect(result).not.toContain("secretTail");
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("preserves array positions in destructuring assignments", () => {
    const code = `
import source from 'source';
let secret, visible;
[secret, visible] = source;
export function getStaticProps() { return { props: { secret } }; }
export default function Page() { return visible; }
`;
    const result = _stripServerExports(code);
    expect(result).toContain("[, visible] = source");
    expect(result).not.toMatch(/\bsecret\b/);
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("keeps pruned object destructuring assignments parenthesized", () => {
    const code = `
import source from 'source';
const key = 'visible';
let visible, secret;
({ [key]: visible, secret } = source);
export function getStaticProps() { return { props: { secret } }; }
export default function Page() { return visible; }
`;
    const result = _stripServerExports(code);
    expect(result).toContain("({ [key]: visible } = source);");
    expect(result).not.toMatch(/\bsecret\b/);
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("preserves import attributes when pruning import specifiers", () => {
    const code = `
import { visible, secret } from './data.json' with { type: 'json' };
export function getStaticProps() { return { props: { secret } }; }
export default function Page() { return visible; }
`;
    const result = _stripServerExports(code);
    expect(result).toContain("import { visible } from './data.json' with { type: 'json' };");
    expect(result).not.toMatch(/\bsecret\b/);
    expect(() => parseAst(result!)).not.toThrow();
  });

  it("preserves export attributes when pruning re-export specifiers", () => {
    const code = `
export { visible, getStaticProps } from './data.json' with { type: 'json' };
`;
    const result = _stripServerExports(code);
    expect(result).toContain("export { visible } from './data.json' with { type: 'json' };");
    expect(result).not.toContain("getStaticProps");
    expect(() => parseAst(result!)).not.toThrow();
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
    expect(result).not.toContain("getServerSideProps");
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
    expect(result).not.toContain("getServerSideProps");
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
    expect(result).not.toContain("getStaticPaths");
    expect(result).not.toContain("a;b");
  });
});

// ─── getClientTreeshakeConfig ─────────────────────────────────────────────────

describe("getClientTreeshakeConfig", () => {
  it("returns Rolldown treeshake config without a Rollup preset", () => {
    const config = getClientTreeshakeConfig();
    expect(config).toEqual({
      moduleSideEffects: "no-external",
    });
  });
});

// ─── createRscFrameworkChunkOutputConfig ──────────────────────────────────────

describe("createRscFrameworkChunkOutputConfig", () => {
  it("returns Rolldown codeSplitting, not the deprecated advancedChunks", () => {
    const config = createRscFrameworkChunkOutputConfig();
    expect(config).not.toHaveProperty("advancedChunks");
    expect(config).not.toHaveProperty("manualChunks");
    expect(config).toEqual({
      codeSplitting: {
        groups: [
          {
            name: "framework",
            test: RSC_FRAMEWORK_CHUNK_TEST,
            entriesAware: true,
          },
        ],
      },
    });
  });
});

// ─── RSC framework package matching (single source of truth) ──────────────────

describe("RSC framework package matching", () => {
  const matching = [
    "/app/node_modules/react/index.js",
    "/app/node_modules/react-dom/server.js",
    "/app/node_modules/scheduler/index.js",
    "/app/node_modules/react-server-dom-webpack/client.js",
    // pnpm-style nested path.
    "/app/node_modules/.pnpm/react@19.0.0/node_modules/react/index.js",
  ];
  const notMatching = [
    "/app/node_modules/react-icons/lib/index.js",
    "/app/node_modules/@react-aria/utils/dist/index.js",
    "/app/node_modules/@react-aria/focus/dist/index.js",
    "/app/src/components/react-thing.tsx",
  ];

  it("RSC_FRAMEWORK_CHUNK_TEST matches framework packages only", () => {
    for (const id of matching) {
      expect(RSC_FRAMEWORK_CHUNK_TEST.test(id)).toBe(true);
    }
    for (const id of notMatching) {
      expect(RSC_FRAMEWORK_CHUNK_TEST.test(id)).toBe(false);
    }
  });

  it("isRscFrameworkModule matches framework packages only", () => {
    for (const id of matching) {
      expect(isRscFrameworkModule(id)).toBe(true);
    }
    for (const id of notMatching) {
      expect(isRscFrameworkModule(id)).toBe(false);
    }
  });

  // Bundler ids carry backslashes only on Windows, where `toSlash` is active.
  it.runIf(process.platform === "win32")("recognizes Windows-style ids", () => {
    expect(RSC_FRAMEWORK_CHUNK_TEST.test("C:\\app\\node_modules\\react-dom\\server.js")).toBe(true);
    expect(isRscFrameworkModule("C:\\app\\node_modules\\react-dom\\server.js")).toBe(true);
  });
});
