/**
 * CSS media-query syntax preservation in production builds.
 *
 * Verifies that vinext's `build.cssTarget` is pinned old enough to stop
 * esbuild's CSS minifier from rewriting `@media (max-width: ...)` queries
 * to the Media Queries Level 4 range syntax `@media (width <= ...)`.
 *
 * Ported from Next.js: test/e2e/app-dir/css-media-query/css-media-query.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/css-media-query/css-media-query.test.ts
 *
 * The two forms are semantically equivalent, but the rewrite is observable
 * to user code that inspects `cssText` of `CSSMediaRule`s and breaks tools
 * that pattern-match the raw query string. Next.js does not perform this
 * rewrite by default; matching that behavior is required for parity.
 */
import { describe, it, expect } from "vite-plus/test";
import { build } from "vite-plus";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

async function makeFixture(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-css-mq-"));
  await fs.symlink(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");

  const stylesPath = path.join(tmpDir, "styles.css");
  await fs.writeFile(
    stylesPath,
    "h1 { color: red; }\n" +
      "@media screen and (max-width: 768px) {\n" +
      "  h1 { color: blue; }\n" +
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
    "export default function Home() {\n" + "  return <h1>CSS Media Query Test</h1>;\n" + "}\n",
  );

  return tmpDir;
}

async function findBuiltCss(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".css")) {
      // `entry.parentPath` is the directory; older Node uses `entry.path`.
      const parent =
        (entry as { parentPath?: string; path?: string }).parentPath ??
        (entry as { path?: string }).path ??
        dir;
      return fs.readFile(path.join(parent, entry.name), "utf8");
    }
  }
  throw new Error(`No .css asset found under ${dir}`);
}

describe("CSS media-query syntax preservation in production build", () => {
  it("preserves `max-width: ...` instead of rewriting to range syntax", async () => {
    const tmpDir = await makeFixture();
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-css-mq-build-"));
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

      const css = await findBuiltCss(path.join(outDir, "client"));

      // Should preserve `max-width: 768px` (with any whitespace).
      expect(css).toMatch(/max-width\s*:\s*768px/);
      // Should NOT rewrite to MQ Level 4 range syntax.
      expect(css).not.toMatch(/width\s*<=\s*768px/);
      expect(css).not.toMatch(/width<=768px/);

      // Original color values may be minified, but the media block must
      // still gate them (sanity check: the build did emit the rule).
      expect(css).toMatch(/@media[^{]*max-width[^{]*768px/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);
});
