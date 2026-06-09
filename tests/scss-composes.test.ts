/**
 * Regression test for #1343 — SCSS variables leaking through to
 * LightningCSS via the CSS-modules `composes` pipeline.
 *
 * The Next.js test suite covers two flavours of this bug:
 *
 *  - `test/e2e/app-dir/scss/composes-external/` — `composes: foo from
 *    './other.module.scss'` (a sibling .module.scss with `$var` variables).
 *  - `test/e2e/app-dir/scss/nm-module-nested/` — same shape but with
 *    `@import` inside the composed file pulling in another partial.
 *
 * Both fail on `main` because Vite's `vite:css-post` plugin reads the
 * raw `.scss` content for `composes ... from` via postcss-modules'
 * built-in FileSystemLoader (which does not know about Sass), passes
 * it through to PostCSS modules, then hands the resulting CSS — which
 * STILL contains `$var: red;` because Sass never ran — to
 * LightningCSS. The minifier rejects it with:
 *
 *   SyntaxError: [lightningcss minify] Invalid empty selector
 *   1  |  $var: red;._className_10j3d_2 {
 *
 * The fix installs a custom `css.modules.Loader` that preprocesses
 * `.scss` / `.sass` / `.less` / `.styl` files via Vite's
 * `preprocessCSS()` before PostCSS modules sees them. After the fix
 * the production build succeeds and the resolved `background` /
 * `color` declarations end up in the bundled CSS.
 *
 * Ported from:
 *   test/e2e/app-dir/scss/composes-external/composes-external.test.ts
 *   https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/scss/composes-external/composes-external.test.ts
 *   test/e2e/app-dir/scss/nm-module-nested/nm-module-nested.test.ts
 *   https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/scss/nm-module-nested/nm-module-nested.test.ts
 *
 * The fixtures live in tmpdir rather than under `tests/fixtures/` so
 * the test is silently skipped on machines that don't have `sass`
 * installed (matching tests/scss.test.ts).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vite-plus/test";
import { build } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

// Skip the suite when `sass` is not installed. SCSS preprocessing is a
// peer-dependency contract: vinext relies on Vite's built-in handling
// which requires the user to install `sass` (or `sass-embedded`).
let sassAvailable = false;
try {
  // @ts-ignore Optional peer dependency, not declared in this repo.
  await import("sass");
  sassAvailable = true;
} catch {
  sassAvailable = false;
}

const describeIfSass = sassAvailable ? describe : describe.skip;

/**
 * Materialize a fixture mirroring Next.js's `composes-external` test:
 *
 *   pages/
 *     index.module.scss  // composes from ./other.module.scss
 *     other.module.scss  // declares the actual className with $var
 *     index.tsx          // imports index.module.scss
 *
 * Both .scss files use SCSS variables. Without preprocessing those
 * variables leak through to LightningCSS and break the build.
 */
async function makeComposesExternalFixture(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-scss-composes-"));
  await fs.symlink(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");

  const pagesDir = path.join(tmpDir, "pages");
  await fs.mkdir(pagesDir, { recursive: true });

  await fs.writeFile(
    path.join(pagesDir, "other.module.scss"),
    "$var: red;\n.className {\n  background: $var;\n  color: yellow;\n}\n",
  );
  await fs.writeFile(
    path.join(pagesDir, "index.module.scss"),
    "$var: blue;\n.subClass {\n  composes: className from './other.module.scss';\n  background: $var;\n}\n",
  );
  await fs.writeFile(
    path.join(pagesDir, "index.tsx"),
    'import { subClass } from "./index.module.scss";\n' +
      "export default function Home() {\n" +
      '  return <div id="verify-yellow" className={subClass}>Hello</div>;\n' +
      "}\n",
  );
  return tmpDir;
}

/**
 * Mirrors Next.js's `nm-module-nested` test: an `@import` of a plain
 * `.scss` partial inside a `.module.scss` that is then composed from.
 * Exercises the same code path but adds an extra layer of Sass
 * processing before the variables are resolved.
 */
async function makeNestedImportFixture(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-scss-nested-"));
  await fs.symlink(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");

  const pagesDir = path.join(tmpDir, "pages");
  await fs.mkdir(pagesDir, { recursive: true });

  // Partial SCSS imported by the .module.scss. Sass must resolve the
  // @import before PostCSS modules sees the file.
  await fs.writeFile(path.join(pagesDir, "other3.scss"), "$var: red;\n");
  await fs.writeFile(
    path.join(pagesDir, "other.module.scss"),
    "@import 'other3.scss';\n.className {\n  background: $var;\n  color: yellow;\n}\n",
  );
  await fs.writeFile(
    path.join(pagesDir, "index.module.scss"),
    "$bg: blue;\n.subClass {\n  composes: className from './other.module.scss';\n  background: $bg;\n}\n",
  );
  await fs.writeFile(
    path.join(pagesDir, "index.tsx"),
    'import { subClass } from "./index.module.scss";\n' +
      "export default function Home() {\n" +
      '  return <div id="verify-yellow" className={subClass}>Hello</div>;\n' +
      "}\n",
  );
  return tmpDir;
}

/**
 * Drive a production-style SSR build of the fixture. We run only the
 * SSR build (skipping the client bundle) because the bug reproduces in
 * EVERY environment whose `cssMinify` defaults to LightningCSS — and
 * for server environments that is the Vite 8 default. Keeping the test
 * to one `build()` call keeps the run time tight.
 */
async function buildFixture(root: string): Promise<string> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-scss-build-"));
  await build({
    root,
    configFile: false,
    plugins: [vinext({ disableAppRouter: true })],
    logLevel: "silent",
    build: {
      outDir,
      ssr: "virtual:vinext-server-entry",
      rollupOptions: { output: { entryFileNames: "entry.js" } },
      // Force lightningcss minify so the test exercises the exact code
      // path that fails on `main` (Vite defaults to it on server
      // environments anyway, but pinning makes the regression explicit
      // even if Vite changes its default later).
      cssMinify: "lightningcss",
    },
  });
  return outDir;
}

/**
 * Recursively collect every `.css` file under `outDir` and return their
 * concatenated content. Vite's filename hash + future code-splitting
 * changes can produce multiple CSS files per build, so we concatenate
 * to make the assertions robust to either layout.
 */
async function readAllBundledCss(outDir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".css")) {
        out.push(await fs.readFile(full, "utf-8"));
      }
    }
  };
  await walk(outDir);
  return out.join("\n");
}

describeIfSass("SCSS composes through CSS modules (#1343)", () => {
  it("builds when composes points at a .module.scss with SCSS variables", async () => {
    const root = await makeComposesExternalFixture();
    let outDir = "";
    try {
      outDir = await buildFixture(root);
      const css = await readAllBundledCss(outDir);
      expect(css, "expected bundled CSS file in build output").not.toBe("");

      // Sass must have resolved before LightningCSS saw the source —
      // no `$var` may remain.
      expect(css).not.toContain("$var");

      // The composed class must contribute its `background: red` and
      // `color: yellow` declarations to the final bundle, which means
      // PostCSS-modules saw the *preprocessed* `.className { ... }`.
      expect(css.toLowerCase()).toMatch(/background\s*:\s*(red|#f00\b)/);
      // LightningCSS may minify `yellow` to `#ff0`. Either is fine —
      // what matters is the colour value made it into the bundle.
      expect(css.toLowerCase()).toMatch(/color\s*:\s*(yellow|#ff0\b|#ffff00\b)/);
      // The composing class contributes `background: blue` AFTER the
      // composed declaration, so blue wins per CSS cascade.
      expect(css.toLowerCase()).toMatch(/background\s*:\s*(blue|#00f\b|#0000ff\b)/);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      if (outDir) await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("builds when the composed .module.scss @imports a partial with variables", async () => {
    const root = await makeNestedImportFixture();
    let outDir = "";
    try {
      outDir = await buildFixture(root);
      const css = await readAllBundledCss(outDir);
      expect(css).not.toBe("");

      // No leakage of either the partial's `$var` or the composing
      // module's `$bg`. The `@import` of `other3.scss` must also have
      // been resolved by Sass — its statement should not survive.
      expect(css).not.toContain("$var");
      expect(css).not.toContain("$bg");
      expect(css).not.toContain("@import");

      expect(css.toLowerCase()).toMatch(/background\s*:\s*(red|#f00\b)/);
      expect(css.toLowerCase()).toMatch(/color\s*:\s*(yellow|#ff0\b|#ffff00\b)/);
      expect(css.toLowerCase()).toMatch(/background\s*:\s*(blue|#00f\b|#0000ff\b)/);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      if (outDir) await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);
});
