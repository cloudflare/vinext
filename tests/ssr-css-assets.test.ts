/**
 * Tests that vinext's SSR environment emits CSS (and other) assets, not
 * just JS chunks. With Vite's default config, the SSR environment has
 * `emitAssets: false` (because `consumer === "server"`), so when the CSS
 * code-split plugin rewrites a server-component CSS import into an
 * `import "<hash>.css"` statement, the referenced asset file is deleted
 * from the SSR bundle by Vite's asset-cleanup hook. At runtime the prod
 * server then fails to start with:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'dist/server/ssr/style.css'
 *     imported from 'dist/server/ssr/index.js'
 *
 * vinext sets `environments.ssr.build.emitAssets = true` for both the
 * Pages Router SSR environment and the App Router SSR environment so
 * any CSS imports that survive in SSR JS resolve to a real file on disk.
 *
 * Mirrors the upstream `@vitejs/plugin-rsc` config which already sets
 * `emitAssets: true` on the `rsc` environment for the same reason.
 *
 * Relates to Next.js deploy-suite fixtures that import CSS from server
 * components or layouts:
 *   test/e2e/app-dir/next-dynamic-css/
 *   test/e2e/app-dir/scss/*
 *   test/e2e/app-dir/css-data-url-global-pages/
 *
 * Category A4 in the deploy-suite e2e review.
 */

import { describe, it, expect } from "vite-plus/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveConfig, createBuilder, type ResolvedConfig } from "vite";
import vinext from "../packages/vinext/src/index.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

/**
 * Materialize a minimal App Router fixture in a fresh tmpdir, with global
 * CSS imported from both a root layout (server component) and a regular
 * server-component page. Symlinks the workspace node_modules so the
 * fixture can resolve React, vinext, and @vitejs/plugin-rsc.
 */
async function makeAppRouterCssFixture(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-ssr-css-asset-"));
  await fs.symlink(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");

  const appDir = path.join(tmpDir, "app");
  await fs.mkdir(appDir, { recursive: true });

  await fs.writeFile(path.join(appDir, "layout-global.css"), ".layout-global { color: green; }\n");
  await fs.writeFile(
    path.join(appDir, "layout.tsx"),
    `import "./layout-global.css";\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (<html><body>{children}</body></html>);\n}\n`,
  );

  const pageDir = path.join(appDir, "page-css");
  await fs.mkdir(pageDir, { recursive: true });
  await fs.writeFile(path.join(pageDir, "page-global.css"), ".page-global { color: blue; }\n");
  await fs.writeFile(
    path.join(pageDir, "page.tsx"),
    `import "./page-global.css";\nexport default function Page() {\n  return <p id="global">Hello Global</p>;\n}\n`,
  );

  return tmpDir;
}

describe("SSR build emits CSS assets referenced by SSR chunks", () => {
  it("App Router SSR environment is configured with emitAssets: true", async () => {
    const tmpDir = await makeAppRouterCssFixture();
    try {
      const config: ResolvedConfig = await resolveConfig(
        {
          root: tmpDir,
          configFile: false,
          plugins: [vinext({ appDir: tmpDir })],
          logLevel: "silent",
        },
        "build",
      );

      const ssrEnv = config.environments?.ssr;
      expect(
        ssrEnv,
        "App Router SSR environment must be present when app/ is detected",
      ).toBeDefined();
      // Without emitAssets: true the SSR build silently strips CSS asset
      // files, leaving dangling `import "<hash>.css"` statements that
      // crash `vinext start` with ERR_MODULE_NOT_FOUND.
      expect(
        ssrEnv!.build.emitAssets,
        "SSR environment must enable emitAssets so CSS imports in SSR chunks resolve at runtime",
      ).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  it("Pages Router SSR environment is configured with emitAssets: true", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-ssr-css-pages-"));
    try {
      await fs.symlink(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");
      const pagesDir = path.join(tmpDir, "pages");
      await fs.mkdir(pagesDir, { recursive: true });
      await fs.writeFile(
        path.join(pagesDir, "index.tsx"),
        "export default function Home() {\n  return <div>Hello</div>;\n}\n",
      );

      const config: ResolvedConfig = await resolveConfig(
        {
          root: tmpDir,
          configFile: false,
          plugins: [vinext({ disableAppRouter: true })],
          logLevel: "silent",
        },
        "build",
      );

      const ssrEnv = config.environments?.ssr;
      expect(ssrEnv, "Pages Router SSR environment must be present").toBeDefined();
      expect(ssrEnv!.build.emitAssets, "Pages Router SSR environment must enable emitAssets").toBe(
        true,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  it("every CSS import in dist/server/ssr/*.js resolves to a real file on disk", async () => {
    const tmpDir = await makeAppRouterCssFixture();
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-ssr-css-out-"));
    try {
      const rscOutDir = path.join(outDir, "server");
      const ssrOutDir = path.join(outDir, "server", "ssr");
      const clientOutDir = path.join(outDir, "client");

      const builder = await createBuilder({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir, rscOutDir, ssrOutDir, clientOutDir })],
        logLevel: "silent",
      });
      await builder.buildApp();

      const allFiles: string[] = [];
      async function walk(dir: string): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else allFiles.push(full);
        }
      }
      await walk(ssrOutDir);

      const jsFiles = allFiles.filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
      expect(jsFiles.length, `expected SSR chunks under ${ssrOutDir}`).toBeGreaterThan(0);

      // Any `import "X.css"` or `from "X.css"` statement must point at a
      // file that exists on disk. URL-scheme specifiers (http:, file:,
      // data:) are not file-system paths, so skip them.
      const importRe = /(?:import|from)\s+["']([^"']+\.css)["']/g;

      const missing: { from: string; spec: string; resolved: string }[] = [];
      for (const file of jsFiles) {
        const code = await fs.readFile(file, "utf8");
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(code))) {
          const spec = m[1]!;
          if (/^[a-z]+:/i.test(spec)) continue;
          const resolved = path.resolve(path.dirname(file), spec);
          const exists = await fs
            .stat(resolved)
            .then(() => true)
            .catch(() => false);
          if (!exists) missing.push({ from: path.relative(ssrOutDir, file), spec, resolved });
        }
      }

      expect(
        missing,
        `SSR chunks import CSS files that were not emitted:\n${JSON.stringify(missing, null, 2)}`,
      ).toEqual([]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 180_000);
});
