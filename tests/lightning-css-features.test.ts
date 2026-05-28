/**
 * `experimental.lightningCssFeatures` plumbed through to Vite's lightningcss
 * bridge (`css.lightningcss.include` / `css.lightningcss.exclude`).
 *
 * Ported from Next.js: test/e2e/app-dir/experimental-lightningcss-features/experimental-lightningcss-features.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/experimental-lightningcss-features/experimental-lightningcss-features.test.ts
 *
 * Regression test for https://github.com/cloudflare/vinext/issues/1498 —
 * vinext used to silently ignore `experimental.lightningCssFeatures`, so
 * `light-dark()` was always lowered to the `var(--lightningcss-light, ...)`
 * polyfill regardless of `exclude: ['light-dark']`.
 */
import { describe, it, expect } from "vite-plus/test";
import { build } from "vite-plus";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

async function makeFixture(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-lightning-css-"));
  await fs.symlink(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");

  const stylesPath = path.join(tmpDir, "styles.css");
  await fs.writeFile(
    stylesPath,
    ".themed {\n" +
      "  color: light-dark(black, white);\n" +
      "  background-color: light-dark(white, black);\n" +
      "}\n",
  );

  const pagesDir = path.join(tmpDir, "pages");
  await fs.mkdir(pagesDir, { recursive: true });
  await fs.writeFile(
    path.join(pagesDir, "_app.tsx"),
    'import "../styles.css";\n' +
      "export default function App({ Component, pageProps }: any) {\n" +
      "  return <Component {...pageProps} />;\n" +
      "}\n",
  );
  await fs.writeFile(
    path.join(pagesDir, "index.tsx"),
    'export default function Home() {\n  return <div className="themed">Hello</div>;\n}\n',
  );

  return tmpDir;
}

async function findBuiltCss(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  let combined = "";
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".css")) {
      const parent =
        (entry as { parentPath?: string; path?: string }).parentPath ??
        (entry as { path?: string }).path ??
        dir;
      combined += await fs.readFile(path.join(parent, entry.name), "utf8");
    }
  }
  if (!combined) throw new Error(`No .css asset found under ${dir}`);
  return combined;
}

describe("experimental.lightningCssFeatures", () => {
  it("preserves light-dark() when listed in `exclude`", async () => {
    const tmpDir = await makeFixture();
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-lightning-build-"));
    try {
      await build({
        root: tmpDir,
        configFile: false,
        plugins: [
          vinext({
            disableAppRouter: true,
            nextConfig: {
              experimental: {
                useLightningcss: true,
                lightningCssFeatures: {
                  exclude: ["light-dark"],
                },
              },
            },
          }),
        ],
        logLevel: "silent",
        build: {
          outDir: path.join(outDir, "client"),
          manifest: true,
          ssrManifest: true,
          rollupOptions: { input: "virtual:vinext-client-entry" },
        },
      });

      const css = await findBuiltCss(path.join(outDir, "client"));

      // With `exclude: ['light-dark']`, lightningcss should NOT lower
      // `light-dark()` — the raw function should remain in the output.
      expect(css).toContain("light-dark(");
      expect(css).not.toContain("--lightningcss-light");
      expect(css).not.toContain("--lightningcss-dark");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("transpiles light-dark() when listed in `include`", async () => {
    const tmpDir = await makeFixture();
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-lightning-build-"));
    try {
      await build({
        root: tmpDir,
        configFile: false,
        plugins: [
          vinext({
            disableAppRouter: true,
            nextConfig: {
              experimental: {
                useLightningcss: true,
                lightningCssFeatures: {
                  include: ["light-dark"],
                },
              },
            },
          }),
        ],
        logLevel: "silent",
        build: {
          outDir: path.join(outDir, "client"),
          manifest: true,
          ssrManifest: true,
          rollupOptions: { input: "virtual:vinext-client-entry" },
        },
      });

      const css = await findBuiltCss(path.join(outDir, "client"));

      // With `include: ['light-dark']`, lightningcss should always transpile
      // `light-dark()` into the var(--lightningcss-light/dark) polyfill —
      // even when the resolved browser targets already support the function.
      expect(css).not.toContain("light-dark(");
      expect(css).toContain("--lightningcss-light");
      expect(css).toContain("--lightningcss-dark");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);
});
