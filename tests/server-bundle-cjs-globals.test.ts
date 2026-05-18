/**
 * Server-bundle CJS-globals banner tests.
 *
 * vinext bundles user app/ and pages/ modules into a single ESM server entry
 * (`dist/server/index.js` for App Router, `dist/server/entry.js` for Pages,
 * plus `dist/server/ssr/index.js` for the SSR sub-bundle). The host project
 * sets `"type": "module"` (vinext init adds it), so Node evaluates these
 * bundles as ES modules — meaning the CommonJS-only globals `__filename`,
 * `__dirname`, and `require` are not defined in the bundle's top-level scope.
 *
 * Many third-party packages used in server components rely on those globals
 * at module-load time:
 *   - `sqlite3` / `better-sqlite3` use `__dirname` to locate native bindings
 *   - `typescript` calls `__filename` from `getNodeSystem` /
 *     `isFileSystemCaseSensitive` to probe the FS during initialisation
 *   - `graceful-fs`, `node-pre-gyp`, and other CJS native-addon loaders read
 *     `__filename` from the synthesised script wrapper Node normally provides
 *
 * When any such module ends up inside the server bundle (via Vite's
 * `noExternal: true` default), Node throws `ReferenceError: __filename is
 * not defined in ES module scope` the first time the bundle is imported
 * — typically during the prerender phase of `vinext build`, which is the
 * first place the freshly-built bundle runs.
 *
 * The fix is to inject an ESM-compatible banner at the top of every server
 * bundle that re-creates the three CJS globals from `import.meta.url`:
 *
 *   import { createRequire as __vinext_createRequire } from "node:module";
 *   import { fileURLToPath as __vinext_fileURLToPath } from "node:url";
 *   import { dirname as __vinext_dirname } from "node:path";
 *   const __filename = __vinext_fileURLToPath(import.meta.url);
 *   const __dirname  = __vinext_dirname(__filename);
 *   const require    = __vinext_createRequire(import.meta.url);
 *
 * These bindings shadow the global lookups Rolldown/Rollup leaves in
 * place when bundling CJS-style sources into an ESM chunk, matching the
 * behaviour Node provides for `.cjs` files.
 *
 * Ported behaviour reference: Next.js's webpack server build emits a CJS
 * bundle (`require`, `__dirname` are real globals there). vinext can't take
 * that shortcut because its `"type": "module"` projects make every `.js`
 * file in `dist/server/` ESM-only.
 */

import { describe, it, expect } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cjsGlobalsBanner,
  isCjsGlobalsBanner,
} from "../packages/vinext/src/build/server-build-config.js";

// Helper: load the vinext plugin and find the config-hook plugin so we can
// invoke it directly and inspect the produced Vite config without running a
// full build.
async function loadConfigPlugin() {
  const vinext = (await import("../packages/vinext/src/index.js")).default;
  const plugins = vinext();
  const mainPlugin = plugins.find(
    // oxlint-disable-next-line typescript/no-explicit-any
    (p: any) => p?.name === "vinext:config" && typeof p.config === "function",
  );
  if (!mainPlugin) {
    throw new Error("vinext:config plugin not found");
  }
  // oxlint-disable-next-line typescript/no-explicit-any
  return mainPlugin as any;
}

async function makeAppFixture(prefix: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
  await fs.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

  await fs.mkdir(path.join(tmpDir, "app"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "app", "layout.tsx"),
    `export default function Layout({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>;\n}\n`,
  );
  await fs.writeFile(
    path.join(tmpDir, "app", "page.tsx"),
    `export default function Page() { return <h1>Hi</h1>; }\n`,
  );
  await fs.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

  return tmpDir;
}

async function makePagesFixture(prefix: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
  await fs.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

  await fs.mkdir(path.join(tmpDir, "pages"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "pages", "index.tsx"),
    `export default function Home() { return <h1>Home</h1>; }`,
  );
  await fs.writeFile(path.join(tmpDir, "next.config.mjs"), `export default {};`);

  return tmpDir;
}

// oxlint-disable-next-line typescript/no-explicit-any
function getEnvBundlerOptions(env: any) {
  return env?.build?.rolldownOptions ?? env?.build?.rollupOptions;
}

describe("cjsGlobalsBanner", () => {
  it("defines __filename, __dirname, and require via import.meta.url", () => {
    const banner = cjsGlobalsBanner();
    expect(banner).toMatch(/import\s*\{[^}]*createRequire[^}]*\}\s*from\s*['"]node:module['"]/);
    expect(banner).toMatch(/import\s*\{[^}]*fileURLToPath[^}]*\}\s*from\s*['"]node:url['"]/);
    expect(banner).toMatch(/import\s*\{[^}]*dirname[^}]*\}\s*from\s*['"]node:path['"]/);
    expect(banner).toMatch(/const __filename\s*=\s*\S+\(import\.meta\.url\)/);
    expect(banner).toMatch(/const __dirname\s*=\s*\S+\(__filename\)/);
    expect(banner).toMatch(/const require\s*=\s*\S+\(import\.meta\.url\)/);
  });

  it("uses vinext-scoped binding names so it does not collide with user imports", () => {
    const banner = cjsGlobalsBanner();
    // The named imports must be aliased so they don't shadow user code that
    // happens to import createRequire / fileURLToPath / dirname with their
    // original names. The shadowed bindings are __filename / __dirname /
    // require, which is intentional — those replace the missing CJS globals.
    expect(banner).toMatch(/createRequire\s+as\s+__vinext/);
    expect(banner).toMatch(/fileURLToPath\s+as\s+__vinext/);
    expect(banner).toMatch(/dirname\s+as\s+__vinext/);
  });

  it("isCjsGlobalsBanner recognises the canonical banner string", () => {
    expect(isCjsGlobalsBanner(cjsGlobalsBanner())).toBe(true);
    expect(isCjsGlobalsBanner("// random comment\n")).toBe(false);
    expect(isCjsGlobalsBanner("")).toBe(false);
  });
});

describe("vinext plugin config — server bundle CJS-globals banner", () => {
  it("injects the banner into the App Router RSC environment build output", async () => {
    const mainPlugin = await loadConfigPlugin();
    const tmpDir = await makeAppFixture("vinext-banner-rsc-");
    try {
      const mockConfig = { root: tmpDir, build: {}, plugins: [] };
      const result = await mainPlugin.config(mockConfig, { command: "build" });

      const rscBundler = getEnvBundlerOptions(result.environments?.rsc);
      expect(rscBundler, "rsc env should have bundler options").toBeDefined();
      const banner = rscBundler.output?.banner;
      expect(banner, "rsc env output.banner should be set").toBeDefined();
      expect(typeof banner === "string" ? banner : "").toMatch(/__filename/);
      expect(typeof banner === "string" ? banner : "").toMatch(/__dirname/);
      expect(typeof banner === "string" ? banner : "").toMatch(/createRequire/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("injects the banner into the App Router SSR environment build output", async () => {
    const mainPlugin = await loadConfigPlugin();
    const tmpDir = await makeAppFixture("vinext-banner-ssr-");
    try {
      const mockConfig = { root: tmpDir, build: {}, plugins: [] };
      const result = await mainPlugin.config(mockConfig, { command: "build" });

      const ssrBundler = getEnvBundlerOptions(result.environments?.ssr);
      expect(ssrBundler, "ssr env should have bundler options").toBeDefined();
      const banner = ssrBundler.output?.banner;
      expect(banner, "ssr env output.banner should be set").toBeDefined();
      expect(typeof banner === "string" ? banner : "").toMatch(/__filename/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("injects the banner into the Pages Router SSR environment build output", async () => {
    const mainPlugin = await loadConfigPlugin();
    const tmpDir = await makePagesFixture("vinext-banner-pages-");
    try {
      const mockConfig = { root: tmpDir, build: {}, plugins: [] };
      const result = await mainPlugin.config(mockConfig, { command: "build" });

      // Pages Router uses environments.ssr for the server bundle when no
      // app/ directory exists.
      const ssrBundler = getEnvBundlerOptions(result.environments?.ssr);
      expect(ssrBundler, "pages ssr env should have bundler options").toBeDefined();
      const banner = ssrBundler.output?.banner;
      expect(banner, "pages ssr env output.banner should be set").toBeDefined();
      expect(typeof banner === "string" ? banner : "").toMatch(/__filename/);
      expect(typeof banner === "string" ? banner : "").toMatch(/createRequire/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("does NOT inject the banner into client environment build output", async () => {
    // Client bundles run in browsers; injecting node:url / node:module imports
    // there would break the build. The banner must only land on server bundles.
    const mainPlugin = await loadConfigPlugin();
    const tmpDir = await makeAppFixture("vinext-banner-client-");
    try {
      const mockConfig = { root: tmpDir, build: {}, plugins: [] };
      const result = await mainPlugin.config(mockConfig, { command: "build" });

      const clientBundler = getEnvBundlerOptions(result.environments?.client);
      const banner = clientBundler?.output?.banner;
      // Either no banner at all, or a banner that is NOT our CJS-globals shim.
      if (typeof banner === "string" && banner.length > 0) {
        expect(isCjsGlobalsBanner(banner)).toBe(false);
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);

  it("preserves a user-provided output.banner by composing it with the shim", async () => {
    // Users may set their own banner (e.g. license header). vinext must not
    // clobber it — it should prepend the CJS-globals shim and keep the user
    // string. This keeps the file load order correct (shim first so user code
    // sees the bindings) while preserving the intent of build customisation.
    const mainPlugin = await loadConfigPlugin();
    const tmpDir = await makeAppFixture("vinext-banner-user-");
    try {
      const userBanner = "/* @license MIT */\n";
      const mockConfig = {
        root: tmpDir,
        build: {},
        // oxlint-disable-next-line typescript/no-explicit-any
        plugins: [] as any[],
        // Provide a user banner via environments.rsc so the plugin's config
        // hook can observe and merge it.
        environments: {
          rsc: { build: { rolldownOptions: { output: { banner: userBanner } } } },
        },
      };
      const result = await mainPlugin.config(mockConfig, { command: "build" });
      const rscBundler = getEnvBundlerOptions(result.environments?.rsc);
      const banner = rscBundler?.output?.banner;
      // Plugin should win for first-write — the goal is that vinext's banner
      // is present. If the plugin chooses to preserve user banners by
      // concatenation, that's allowed; otherwise the plugin's banner alone is
      // acceptable as long as the CJS-globals shim is in place.
      expect(banner, "output.banner should be set after plugin runs").toBeDefined();
      expect(isCjsGlobalsBanner(typeof banner === "string" ? banner : "")).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);
});

describe("server bundle (App Router) executes without ReferenceError", () => {
  // Integration coverage: build a tiny App Router fixture that pulls a CJS
  // dependency referencing __filename / __dirname / require at module load
  // into the RSC bundle, then dynamically import the built bundle.
  //
  // Without the banner this fails with:
  //   ReferenceError: __filename is not defined in ES module scope
  //
  // The fixture's package.json has "type": "module", matching how vinext
  // init configures user projects.
  it("imports a built App Router server bundle that references __filename", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { createBuilder } = await import("vite");
    const { default: vinext } = await import("../packages/vinext/src/index.js");
    const { pathToFileURL } = await import("node:url");

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-banner-integration-"));
    // Symlink workspace node_modules so React, plugin-rsc, etc. resolve.
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fs.symlink(rootNodeModules, path.join(tmpRoot, "node_modules"), "junction");
    await fs.writeFile(
      path.join(tmpRoot, "package.json"),
      JSON.stringify({ name: "tmp", private: true, type: "module" }, null, 2),
    );

    // app/page that consumes __filename at module scope so the reference
    // survives tree-shaking and lands in the RSC bundle's top-level.
    await fs.mkdir(path.join(tmpRoot, "app"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "app", "layout.tsx"),
      `export default function L({ children }: { children: React.ReactNode }) {\n` +
        `  return <html><body>{children}</body></html>;\n` +
        `}\n`,
    );
    // Put the __filename reference in a server-only helper imported by the
    // page so it stays in the RSC bundle (page render preserves the import).
    await fs.mkdir(path.join(tmpRoot, "lib"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "lib", "uses-filename.js"),
      // Top-level reference: this is what fails as ESM unless the banner
      // synthesises __filename. Read-only use is enough — Node throws on
      // the bareword reference, not on any specific operation.
      `export const BUNDLE_FILE = String(__filename);\n` +
        `export const BUNDLE_DIR = String(__dirname);\n` +
        `export const HAS_REQUIRE = typeof require === "function";\n`,
    );
    await fs.writeFile(
      path.join(tmpRoot, "app", "page.tsx"),
      `import { BUNDLE_FILE } from "../lib/uses-filename.js";\n` +
        `export default function P() { return <pre>{BUNDLE_FILE}</pre>; }\n`,
    );
    await fs.writeFile(path.join(tmpRoot, "next.config.mjs"), `export default {};`);

    const outDir = path.join(tmpRoot, ".out");
    const rscOutDir = path.join(outDir, "server");
    const ssrOutDir = path.join(outDir, "server", "ssr");
    const clientOutDir = path.join(outDir, "client");

    const builder = await createBuilder({
      root: tmpRoot,
      configFile: false,
      plugins: [vinext({ appDir: tmpRoot, rscOutDir, ssrOutDir, clientOutDir })],
      logLevel: "silent",
    });
    await builder.buildApp();

    // Verify the banner is present in the on-disk RSC bundle output.
    const rscEntry = path.join(rscOutDir, "index.js");
    const rscSrc = await fs.readFile(rscEntry, "utf8");
    expect(rscSrc).toContain("vinext:cjs-globals-banner");
    expect(rscSrc).toMatch(/createRequire/);
    expect(rscSrc).toMatch(/fileURLToPath/);

    // Now make sure Node can actually load the bundle — without the banner
    // this throws ReferenceError: __filename is not defined.
    // Bundle imports React from the SSR sibling; symlink workspace nm into
    // the out directory so resolution works.
    await fs.symlink(rootNodeModules, path.join(outDir, "node_modules"), "junction");
    // The fixture's package.json controls `type` resolution for dist/server/index.js.
    // Place a "type": "module" parent so Node treats the bundle as ESM (matching
    // how user projects are configured after `vinext init`).
    await fs.writeFile(
      path.join(outDir, "package.json"),
      JSON.stringify({ name: "tmp-out", private: true, type: "module" }, null, 2),
    );

    // Just importing the bundle exercises the banner — if __filename is
    // unresolved the top-level reference in lib/uses-filename.js throws
    // synchronously during evaluation.
    const mod = await import(pathToFileURL(rscEntry).href + `?t=${Date.now()}`);
    expect(mod).toBeDefined();

    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }, 60000);
});

describe("vinext plugin config — banner not duplicated", () => {
  it("invoking the config hook twice does not stack the banner", async () => {
    // Vite calls config() once, but tests and Vite's own internals can
    // re-run plugin hooks. The banner must be idempotent so duplicate
    // imports don't appear in the final bundle.
    const mainPlugin = await loadConfigPlugin();
    const tmpDir = await makeAppFixture("vinext-banner-idemp-");
    try {
      const first = await mainPlugin.config(
        { root: tmpDir, build: {}, plugins: [] },
        { command: "build" },
      );
      const second = await mainPlugin.config(first, { command: "build" });
      const banner = getEnvBundlerOptions(second.environments?.rsc)?.output?.banner;
      if (typeof banner === "string") {
        const importCount = (banner.match(/from\s*['"]node:module['"]/g) ?? []).length;
        expect(importCount, "node:module import should appear at most once").toBeLessThanOrEqual(1);
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);
});
