/**
 * CSS-module `composes: <class> from '<file>'` dependencies — SCSS and CSS.
 *
 * postcss-modules' built-in `FileSystemLoader` reads `composes` dependencies
 * as raw text and pipes them straight into the CSS-module scoping plugins —
 * without Sass preprocessing. For `.scss`/`.sass` dependencies this leaves
 * SCSS syntax (`$var: red;`, bare `@import 'file.scss'`) verbatim in the
 * output CSS, and LightningCSS then crashes during production minification
 * with "Invalid empty selector".
 *
 * vinext replaces the loader with `SassAwareFileSystemLoader`
 * (packages/vinext/src/plugins/sass.ts), which preprocesses every `composes`
 * dependency through Vite's `preprocessCSS` (Sass compilation + CSS-module
 * scoping in one shot, using the build's resolved config).
 *
 * Ported from the Next.js fixtures whose production builds crashed without
 * the fix:
 *   test/e2e/app-dir/scss/composes-external/composes-external.test.ts
 *   test/e2e/app-dir/scss/nm-module/nm-module.test.ts
 *   test/e2e/app-dir/scss/nm-module-nested/nm-module-nested.test.ts
 * https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/scss
 *
 * Also covers plain `.module.css` → `.module.css` composes (no Sass) and
 * composing from a non-`*.module.*` file, since the custom loader now runs
 * for every CSS module — those paths must keep parity with the previous
 * behaviour.
 *
 * Relates to: https://github.com/cloudflare/vinext/issues/1825
 */

import { describe, it, expect } from "vite-plus/test";
import { build, createBuilder } from "vite-plus";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

/**
 * Materialize a Pages Router fixture in a fresh tmpdir.
 *
 * Unlike tests that symlink the workspace `node_modules` directory wholesale,
 * this creates a real `node_modules` dir with per-entry symlinks so fixtures
 * can add fake packages (e.g. `example`, mirroring the Next.js `nm-module`
 * fixtures) alongside the real ones — entries under `node_modules/<pkg>/...`
 * in the `files` map are written as real files.
 */
async function makeFixture(files: Record<string, string>): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-scss-composes-"));

  const nmDir = path.join(tmpDir, "node_modules");
  await fs.mkdir(nmDir);
  for (const entry of await fs.readdir(ROOT_NODE_MODULES)) {
    // Skip pnpm-internal entries (.pnpm, .bin, .modules.yaml, ...). Package
    // symlinks resolve through their realpath into the workspace `.pnpm`
    // store, so only the top-level package entries are needed.
    if (entry.startsWith(".")) continue;
    await fs.symlink(path.join(ROOT_NODE_MODULES, entry), path.join(nmDir, entry), "junction");
  }

  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tmpDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  return tmpDir;
}

/**
 * Production client build (the LightningCSS minification step that crashed
 * with "Invalid empty selector" runs here). Returns the emitted CSS and JS
 * concatenated for assertions.
 */
async function buildAndCollect(tmpDir: string): Promise<{ css: string; js: string }> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-scss-composes-out-"));
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

    let css = "";
    let js = "";
    const entries = await fs.readdir(path.join(outDir, "client"), {
      withFileTypes: true,
      recursive: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parent =
        (entry as { parentPath?: string; path?: string }).parentPath ??
        (entry as { path?: string }).path ??
        outDir;
      const full = path.join(parent, entry.name);
      if (entry.name.endsWith(".css")) css += (await fs.readFile(full, "utf8")) + "\n";
      if (entry.name.endsWith(".js")) js += (await fs.readFile(full, "utf8")) + "\n";
    }
    return { css, js };
  } finally {
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function buildHybridAndCollect(tmpDir: string): Promise<{ css: string; js: string }> {
  const builder = await createBuilder({
    root: tmpDir,
    configFile: false,
    plugins: [vinext({ appDir: tmpDir })],
    logLevel: "silent",
  });
  await builder.buildApp();
  const clientDir = path.join(tmpDir, "dist", "client");
  const files = await fs.readdir(clientDir, { withFileTypes: true, recursive: true });
  const cssFiles = files.filter((entry) => entry.isFile() && entry.name.endsWith(".css"));
  const jsFiles = files.filter((entry) => entry.isFile() && entry.name.endsWith(".js"));
  const readOutput = async (entries: typeof files) =>
    (
      await Promise.all(
        entries.map((entry) => {
          const parent =
            (entry as { parentPath?: string; path?: string }).parentPath ??
            (entry as { path?: string }).path ??
            clientDir;
          return fs.readFile(path.join(parent, entry.name), "utf8");
        }),
      )
    ).join("\n");
  return { css: await readOutput(cssFiles), js: await readOutput(jsFiles) };
}

const PAGE = [
  'import styles from "../styles/index.module.scss";',
  "export default function Home() {",
  "  return <div className={styles.subClass}>composes</div>;",
  "}",
  "",
].join("\n");

describe("SCSS CSS-module composes (production build)", () => {
  // Ported from Next.js: test/e2e/app-dir/scss/nm-module/nm-module.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/scss/nm-module/nm-module.test.ts
  it("emits a directly imported .module.scss from node_modules in hybrid builds (nm-module)", async () => {
    const tmpDir = await makeFixture({
      "app/layout.tsx":
        "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n",
      "pages/index.js": [
        'import * as classes from "example/index.module.scss";',
        "export default function Home() {",
        '  return <div className={classes["red-text"]}>node module</div>;',
        "}",
        "",
      ].join("\n"),
      "node_modules/example/package.json": JSON.stringify({ name: "example", version: "1.0.0" }),
      "node_modules/example/index.module.scss": "$var: red;\n.red-text {\n  color: $var;\n}\n",
    });
    try {
      const { css, js } = await buildHybridAndCollect(tmpDir);
      expect(css).not.toContain("$var");
      expect(css).toContain("color:red");
      expect(js).toMatch(/_red-text_[\w-]+/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("composes from an external .module.scss containing SCSS syntax (composes-external)", async () => {
    const tmpDir = await makeFixture({
      "pages/index.tsx": PAGE,
      "styles/index.module.scss":
        ".subClass {\n  composes: className from './other.module.scss';\n}\n",
      "styles/other.module.scss": "$var: red;\n.className {\n  background: $var;\n}\n",
    });
    try {
      // Without SassAwareFileSystemLoader this build rejects with
      // "[lightningcss minify] Invalid empty selector" because `$var: red;`
      // reaches the minifier verbatim.
      const { css, js } = await buildAndCollect(tmpDir);

      // The SCSS variable must be resolved, and the composed class scoped.
      expect(css).not.toContain("$var");
      expect(css).toMatch(/_className_[\w-]+/);
      expect(css).toContain("background:red");

      // Class composition: `styles.subClass` resolves to both scoped names.
      expect(js).toMatch(/_subClass_[\w-]+ _className_[\w-]+/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("composes from a .module.scss inside node_modules (nm-module)", async () => {
    const tmpDir = await makeFixture({
      "pages/index.tsx": PAGE,
      "styles/index.module.scss":
        ".subClass {\n  composes: className from 'example/index.module.scss';\n}\n",
      "node_modules/example/package.json": JSON.stringify({ name: "example", version: "1.0.0" }),
      "node_modules/example/index.module.scss":
        "$var: red;\n.className {\n  background: $var;\n}\n",
    });
    try {
      const { css, js } = await buildAndCollect(tmpDir);

      expect(css).not.toContain("$var");
      expect(css).toMatch(/_className_[\w-]+/);
      expect(css).toContain("background:red");
      expect(js).toMatch(/_subClass_[\w-]+ _className_[\w-]+/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("compiles nested Sass @import inside a composed node_modules .module.scss (nm-module-nested)", async () => {
    const tmpDir = await makeFixture({
      "pages/index.tsx": PAGE,
      "styles/index.module.scss":
        ".subClass {\n  composes: other2 from 'example/other.module.scss';\n  color: blue;\n}\n",
      "node_modules/example/package.json": JSON.stringify({ name: "example", version: "1.0.0" }),
      "node_modules/example/other.module.scss":
        "@import 'other3.scss';\n\n$var: red;\n\n.other2 {\n  color: $var;\n}\n",
      "node_modules/example/other3.scss": ".other3 {\n  background: orange;\n}\n",
    });
    try {
      const { css, js } = await buildAndCollect(tmpDir);

      // Sass must have resolved both the variable and the nested @import —
      // neither may survive into the emitted CSS.
      expect(css).not.toContain("$var");
      expect(css).not.toContain("@import");
      expect(css).toMatch(/_other2_[\w-]+/);
      expect(css).toContain("color:red");
      // The @import-ed file's class is compiled (and scoped) into the output.
      expect(css).toMatch(/_other3_[\w-]+/);
      expect(css).toContain("background:orange");

      expect(js).toMatch(/_subClass_[\w-]+ _other2_[\w-]+/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("fails the build when a composed dependency has a Sass error", async () => {
    const tmpDir = await makeFixture({
      "pages/index.tsx": PAGE,
      "styles/index.module.scss":
        ".subClass {\n  composes: className from './broken.module.scss';\n}\n",
      // `$undefined` is never declared — Sass compilation of the composed
      // dependency must throw, and the loader must propagate it (only a
      // missing Sass implementation is downgraded to a warning). A green
      // build with silently-missing classes would be worse than the error.
      "styles/broken.module.scss": ".className {\n  background: $undefined;\n}\n",
    });
    try {
      await expect(buildAndCollect(tmpDir)).rejects.toThrow(/broken\.module\.scss|Undefined/i);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);
});

describe("plain CSS-module composes parity (production build)", () => {
  it("keeps `composes` working for .module.css, non-module .css, and extensionless dependencies", async () => {
    const tmpDir = await makeFixture({
      "pages/index.tsx": [
        'import styles from "../styles/index.module.css";',
        "export default function Home() {",
        "  return (",
        "    <div className={styles.subClass}>",
        "      <span className={styles.fromPlain}>composes</span>",
        "      <span className={styles.fromExtless}>extensionless</span>",
        "    </div>",
        "  );",
        "}",
        "",
      ].join("\n"),
      "styles/index.module.css": [
        ".subClass {",
        "  composes: className from './other.module.css';",
        "  padding: 5px;",
        "}",
        ".fromPlain {",
        // postcss-modules treats every `composes` dependency as a CSS module
        // regardless of filename; plain `.css` deps must keep working too.
        "  composes: plainClass from './plain.css';",
        "}",
        ".fromExtless {",
        // Extensionless deps resolve to a literal file on disk and were
        // scoped (as CSS) by postcss-modules' built-in FileSystemLoader —
        // the virtual `*.module.css` rename must cover them too, or their
        // composed tokens are silently dropped.
        "  composes: extlessClass from './extless';",
        "}",
        "",
      ].join("\n"),
      // url() inside a composed dependency: the custom loader runs Vite's
      // `preprocessCSS` (where the built-in FileSystemLoader ran only the
      // scoping plugins). `preprocessCSS` has no plugin context to resolve or
      // emit assets, so — exactly like the built-in loader (verified against
      // a vanilla Vite build) — the url() must pass through verbatim, never
      // mangled into a `__VITE_ASSET__` placeholder or dropped. Pin that
      // parity here so a pipeline change surfaces as a test failure.
      "styles/other.module.css":
        ".className {\n  color: green;\n  background-image: url('./dot.svg');\n}\n",
      "styles/dot.svg":
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="green"/></svg>\n',
      "styles/plain.css": ".plainClass {\n  margin: 7px;\n}\n",
      "styles/extless": ".extlessClass {\n  letter-spacing: 7px;\n}\n",
    });
    try {
      const { css, js } = await buildAndCollect(tmpDir);

      expect(css).toMatch(/_className_[\w-]+/);
      expect(css).toContain("color:green");
      expect(css).toMatch(/_plainClass_[\w-]+/);
      expect(css).toContain("margin:7px");
      expect(css).toMatch(/_extlessClass_[\w-]+/);
      expect(css).toContain("letter-spacing:7px");

      // Parity: the url() reference survives verbatim (the built-in loader
      // behaves identically — composed-dep CSS bypasses Vite's url rewriter,
      // which only runs with a plugin context). It must not be rewritten,
      // mangled into an unresolved placeholder, or dropped.
      expect(css).toMatch(/url\((['"]?)\.\/dot\.svg\1\)/);
      expect(css).not.toContain("__VITE_ASSET__");

      expect(js).toMatch(/_subClass_[\w-]+ _className_[\w-]+/);
      expect(js).toMatch(/_fromPlain_[\w-]+ _plainClass_[\w-]+/);
      expect(js).toMatch(/_fromExtless_[\w-]+ _extlessClass_[\w-]+/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);
});
