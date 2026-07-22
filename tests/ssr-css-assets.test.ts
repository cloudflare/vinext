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
import { resolveConfig, createBuilder, build as viteBuild, type ResolvedConfig } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { _transformVeryDynamicRequests } from "../packages/vinext/src/plugins/ignore-dynamic-requests.js";
import { createServerAssetImportMetaUrlPlugin } from "../packages/vinext/src/plugins/server-asset-import-meta-url.js";

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
  it("uses a workerd-safe data URL for Cloudflare server builds", async () => {
    const plugin = createServerAssetImportMetaUrlPlugin(() => true);
    const transform = plugin.transform as unknown as {
      handler: (
        this: { emitFile(): never },
        code: string,
        id: string,
      ) => Promise<{
        code: string;
      } | null>;
    };
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-worker-url-dep-"));
    try {
      const assetPath = path.join(tmpDir, "style.css");
      await fs.writeFile(assetPath, ".foo { color: red; }\n");
      const transformed = await transform.handler.call(
        {
          emitFile: () => {
            throw new Error("Cloudflare assets must be inlined");
          },
        },
        `import(new URL("./style.css", import.meta.url).href);`,
        path.join(tmpDir, "route.js"),
      );
      expect(transformed?.code).toContain('new URL("data:text/css;base64,');
      expect(transformed?.code).not.toContain("import.meta.url");

      const withComment = await transform.handler.call(
        {
          emitFile: () => {
            throw new Error("Cloudflare assets must be inlined");
          },
        },
        `import(new URL(/* asset */ "./style.css", import.meta.url).href);`,
        path.join(tmpDir, "route.js"),
      );
      expect(withComment?.code).toContain('new URL("data:text/css;base64,');
      expect(withComment?.code).not.toContain("import.meta.url");

      const withSuffix = await transform.handler.call(
        {
          emitFile: () => {
            throw new Error("Cloudflare assets must be inlined");
          },
        },
        `const asset = new URL("./style.css?v=1#theme", import.meta.url);`,
        path.join(tmpDir, "route.js"),
      );
      expect(withSuffix?.code).toContain('new URL("data:text/css;base64,');
      expect(withSuffix?.code).not.toContain("?v=1#theme");
      const dataUrl = withSuffix?.code.match(/new URL\("([^"]+)"\)/)?.[1];
      expect(dataUrl).toBeDefined();
      expect(Buffer.from(dataUrl!.split(",", 2)[1]!, "base64").toString()).toBe(
        ".foo { color: red; }\n",
      );

      const withTemplate = await transform.handler.call(
        {
          emitFile: () => {
            throw new Error("Cloudflare assets must be inlined");
          },
        },
        "const asset = new URL(`./style.css`, import.meta.url);",
        path.join(tmpDir, "route.js"),
      );
      expect(withTemplate?.code).toContain('new URL("data:text/css;base64,');
      expect(withTemplate?.code).not.toContain("import.meta.url");

      const originalImport = `import(new URL("./style.css", import.meta.url).href);`;
      expect(
        _transformVeryDynamicRequests(originalImport, path.join(tmpDir, "route.js")),
      ).toBeNull();
      const composed = await transform.handler.call(
        {
          emitFile: () => {
            throw new Error("Cloudflare assets must be inlined");
          },
        },
        originalImport,
        path.join(tmpDir, "route.js"),
      );
      expect(composed?.code).toContain('import(new URL("data:text/css;base64,');

      const nonCode = `
        // new URL("./style.css", import.meta.url)
        const example = 'new URL("./style.css", import.meta.url)'
      `;
      expect(
        await transform.handler.call(
          {
            emitFile: () => {
              throw new Error("non-code text must not emit assets");
            },
          },
          nonCode,
          path.join(tmpDir, "route.js"),
        ),
      ).toBeNull();

      const shadowedUrl = `
        function buildUrl(URL) {
          return new URL("./style.css", import.meta.url)
        }
      `;
      expect(
        await transform.handler.call(
          {
            emitFile: () => {
              throw new Error("shadowed URL constructors must not emit assets");
            },
          },
          shadowedUrl,
          path.join(tmpDir, "route.js"),
        ),
      ).toBeNull();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves query strings and fragments on emitted Node asset URLs", async () => {
    const plugin = createServerAssetImportMetaUrlPlugin();
    const transform = plugin.transform as unknown as {
      handler: (
        this: { emitFile(): string },
        code: string,
        id: string,
      ) => Promise<{ code: string } | null>;
    };
    const renderChunk = plugin.renderChunk as unknown as (
      this: { getFileName(): string },
      code: string,
      chunk: { fileName: string },
    ) => Promise<{ code: string } | null> | { code: string } | null;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-node-url-dep-"));
    try {
      await fs.writeFile(path.join(tmpDir, "style.css"), ".foo { color: red; }\n");
      const transformed = await transform.handler.call(
        { emitFile: () => "asset-ref" },
        "const asset = new URL(`./style.css?v=1#theme`, import.meta.url);",
        path.join(tmpDir, "route.js"),
      );
      expect(transformed?.code).toContain("__VINEXT_SERVER_ASSET__asset-ref__?v=1#theme");

      const rendered = await renderChunk.call(
        { getFileName: () => "_next/static/style-hash.css" },
        transformed!.code,
        { fileName: "entry.js" },
      );
      expect(rendered?.code).toContain("./_next/static/style-hash.css?v=1#theme");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

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

  // Regression test for cloudflare/vinext#1346.
  //
  // Mirrors the Next.js deploy-suite fixture
  // test/e2e/react-version/pages/api/pages-api-edge-url-dep.js which adds a
  // URL dependency to an edge API route to ensure it does not break the
  // build:
  //
  //   import(new URL('./style.css', import.meta.url).href)
  //
  // Vite's built-in `vite:asset-import-meta-url` plugin only runs in the
  // `client` environment, so prior to the fix the SSR/server bundle was
  // left with an untransformed `new URL("./style.css", import.meta.url)`
  // and no emitted CSS file, producing ERR_MODULE_NOT_FOUND at runtime.
  it("emits assets referenced via `new URL('./X', import.meta.url)` in Pages Router API routes", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-ssr-url-dep-"));
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-ssr-url-dep-out-"));
    try {
      await fs.symlink(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");
      const apiDir = path.join(tmpDir, "pages", "api");
      await fs.mkdir(apiDir, { recursive: true });

      // The CSS file the API route references — this is the artefact we
      // want emitted to the server bundle output.
      await fs.writeFile(path.join(apiDir, "style.css"), ".foo { color: red; }\n");

      // Mirror the Next.js fixture verbatim — a URL dependency added to an
      // edge API route purely to validate that it does not break the build.
      await fs.writeFile(
        path.join(apiDir, "with-url-dep.js"),
        `console.log('TEST_URL', import(new URL('./style.css', import.meta.url).href))\n` +
          `export default async function handler() { return Response.json({ ok: true }) }\n`,
      );
      await fs.writeFile(
        path.join(tmpDir, "pages", "index.tsx"),
        "export default function Home() {\n  return <div>Hello</div>;\n}\n",
      );

      // Run the Pages Router SSR build directly. This mirrors the CLI's
      // hybrid-app branch (cli.ts) which calls `vite.build(...)` with
      // `build.ssr` set to the virtual server entry.
      await viteBuild({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ disableAppRouter: true })],
        logLevel: "silent",
        build: {
          outDir,
          emptyOutDir: false,
          ssr: "virtual:vinext-server-entry",
          rollupOptions: { output: { entryFileNames: "entry.js" } },
        },
      });

      // The server entry must reference the emitted file via a relative
      // URL (not the untransformed `./style.css` and not the root-absolute
      // `/_next/static/...` that Vite's default SSR asset URL resolver
      // would produce, which would resolve to `file:///_next/...` and
      // crash at Node runtime).
      const entryPath = path.join(outDir, "entry.js");
      const entryCode = await fs.readFile(entryPath, "utf8");

      // The original `./style.css` specifier must have been rewritten to
      // the emitted asset path under `_next/static/`. Match either the
      // relative or implicit-current-directory form.
      const urlMatch = entryCode.match(
        /new URL\(["'`](\.\/[^"'`]*_next\/static\/[^"'`]*\.css)["'`]\s*,\s*import\.meta\.url/,
      );
      const testUrlIndex = entryCode.indexOf("TEST_URL");
      expect(
        urlMatch,
        `expected rewritten relative URL to an emitted CSS asset; URL dependency chunk:\n` +
          entryCode.slice(Math.max(0, testUrlIndex - 300), testUrlIndex + 700),
      ).not.toBeNull();

      const emittedRelPath = urlMatch![1]!;
      const emittedAbsPath = path.resolve(path.dirname(entryPath), emittedRelPath);
      const exists = await fs
        .stat(emittedAbsPath)
        .then(() => true)
        .catch(() => false);
      expect(exists, `expected emitted CSS file at ${emittedAbsPath}; new URL points there`).toBe(
        true,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 180_000);
});
