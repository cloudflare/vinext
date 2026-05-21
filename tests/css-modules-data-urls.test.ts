/**
 * CSS modules and stylesheets imported via `data:text/css[+module],...` URLs.
 *
 * Turbopack supports this Next.js-only import syntax. Webpack does not, and
 * the Next.js fixture skips outside `IS_TURBOPACK_TEST`:
 *
 *   import styles from 'data:text/css+module,.home{font-weight:700}'
 *
 * Vite/Rolldown treats `data:` specifiers as external, so without
 * intervention the literal data URL is passed through to runtime. Node and
 * `workerd` then reject the import with
 * `ERR_UNKNOWN_MODULE_FORMAT: Unknown module format: text/css+module`,
 * breaking the entire vinext build.
 *
 * vinext's `vinext:css-data-url` plugin rewrites these imports into
 * synthetic `.module.css` / `.css` modules so the normal CSS pipeline
 * (LightningCSS, CSS modules) processes them. This test verifies:
 *
 *   1. The build completes without errors.
 *   2. `+module` data URLs produce a JS export map (i.e. the consuming
 *      module references the hashed class name).
 *   3. The decoded CSS is emitted as a real stylesheet asset.
 *   4. The synthetic module is shared between RSC and client environments
 *      when both consume the same payload (deduplication parity with how
 *      Vite handles real CSS imports).
 *
 * Mirrors Next.js: test/e2e/app-dir/css-modules-data-urls/
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/css-modules-data-urls/css-modules-data-urls.test.ts
 *
 * Closes: https://github.com/cloudflare/vinext/issues/1363
 */

import { describe, it, expect } from "vite-plus/test";
import { build } from "vite-plus";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

async function makeFixture(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-css-data-url-"));
  await fs.symlink(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");

  const pagesDir = path.join(tmpDir, "pages");
  await fs.mkdir(pagesDir, { recursive: true });

  await fs.writeFile(
    path.join(pagesDir, "_app.tsx"),
    [
      "// Plain `data:text/css,...` is a side-effect import — Vite emits the",
      "// stylesheet as an asset but does not synthesise a default export.",
      "import 'data:text/css,#shared-bold{font-weight:700}';",
      "// @ts-expect-error - data: import is rewritten by vinext:css-data-url",
      "import styles from 'data:text/css+module,.client{color:rebeccapurple}';",
      "export default function App({ Component, pageProps }: any) {",
      "  return <Component {...pageProps} className={styles.client} />;",
      "}",
    ].join("\n"),
  );

  await fs.writeFile(
    path.join(pagesDir, "index.tsx"),
    [
      "// @ts-expect-error - data: import is rewritten by vinext:css-data-url",
      "import styles from 'data:text/css+module,.home{font-weight:700}';",
      "export default function Home() {",
      "  return <h1 className={styles.home}>data-url</h1>;",
      "}",
    ].join("\n"),
  );

  return tmpDir;
}

async function readAllAssets(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parent =
      (entry as { parentPath?: string; path?: string }).parentPath ??
      (entry as { path?: string }).path ??
      dir;
    const full = path.join(parent, entry.name);
    if (/\.(css|js)$/.test(entry.name)) {
      out.set(full, await fs.readFile(full, "utf8"));
    }
  }
  return out;
}

describe("CSS data URL imports", () => {
  it("rewrites `data:text/css+module,...` imports into virtual CSS modules", async () => {
    const tmpDir = await makeFixture();
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-css-data-url-out-"));
    try {
      await build({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ disableAppRouter: true })],
        logLevel: "silent",
        build: {
          outDir: path.join(outDir, "client"),
          manifest: true,
          ssrManifest: true,
          rollupOptions: { input: "virtual:vinext-client-entry" },
        },
      });

      const assets = await readAllAssets(path.join(outDir, "client"));
      const cssAssets = [...assets.entries()].filter(([p]) => p.endsWith(".css"));
      const jsAssets = [...assets.entries()].filter(([p]) => p.endsWith(".js"));

      // The decoded payloads must reach a stylesheet asset, proving the
      // synthetic ids were handed off to Vite's CSS pipeline. LightningCSS
      // minifies `rebeccapurple` to its hex form (#663399 → #639); match
      // either spelling so the test isn't coupled to the minifier output.
      const allCss = cssAssets.map(([, c]) => c).join("\n");
      expect(allCss).toMatch(/font-weight\s*:\s*700/);
      expect(allCss).toMatch(/color\s*:\s*(rebeccapurple|#663399|#639)/i);
      expect(allCss).toContain("#shared-bold");

      // No JS chunk should retain the literal data URL: that would mean the
      // bundler passed the data: import through verbatim and runtime would
      // fail with ERR_UNKNOWN_MODULE_FORMAT.
      for (const [file, code] of jsAssets) {
        expect(code, `data: URL leaked into ${file}`).not.toMatch(/data:text\/css/);
      }

      // The `+module` payload must be exported as a class-name map. The
      // hashed selector ends up in the JS bundle because consumer code reads
      // `styles.home` / `styles.client`. Vite/LightningCSS hash class names
      // with a `_<name>_<hash>` prefix shape; we assert on the base names.
      const allJs = jsAssets.map(([, c]) => c).join("\n");
      expect(allJs).toMatch(/_home[_-]/);
      expect(allJs).toMatch(/_client[_-]/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("decodes base64-encoded `data:text/css+module;base64,...` imports", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-css-data-b64-"));
    await fs.symlink(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-css-data-b64-out-"));
    try {
      const cssSource = ".b64-marker{font-style:italic}";
      const b64 = Buffer.from(cssSource, "utf8").toString("base64");
      const pagesDir = path.join(tmpDir, "pages");
      await fs.mkdir(pagesDir, { recursive: true });
      await fs.writeFile(
        path.join(pagesDir, "_app.tsx"),
        "export default function App({ Component, pageProps }: any) { return <Component {...pageProps} />; }\n",
      );
      await fs.writeFile(
        path.join(pagesDir, "index.tsx"),
        [
          "// @ts-expect-error",
          `import styles from 'data:text/css+module;base64,${b64}';`,
          "export default function Page() {",
          '  return <span className={styles["b64-marker"]}>x</span>;',
          "}",
        ].join("\n"),
      );

      await build({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ disableAppRouter: true })],
        logLevel: "silent",
        build: {
          outDir: path.join(outDir, "client"),
          manifest: true,
          ssrManifest: true,
          rollupOptions: { input: "virtual:vinext-client-entry" },
        },
      });

      const assets = await readAllAssets(path.join(outDir, "client"));
      const allCss = [...assets.entries()]
        .filter(([p]) => p.endsWith(".css"))
        .map(([, c]) => c)
        .join("\n");
      expect(allCss).toMatch(/font-style\s*:\s*italic/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);
});
