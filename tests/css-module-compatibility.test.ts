/**
 * Reproduction for https://github.com/cloudflare/vinext/issues/2992
 *
 * CSS Modules + postcss-extend-rule: `@extend` is silently dropped because
 * Vite's compileCSS() puts the CSS-Modules plugin at the FRONT of the PostCSS
 * plugin chain:
 *
 *   if (isModule) postcssPlugins.unshift((await importPostcssModules()).default({ ... }))
 *
 * so class names are already hashed (`.shared` -> `._shared_1u9uh_1`) by the
 * time the project's PostCSS plugins run. `@extend .shared` then matches no
 * rule, and postcss-extend-rule silently removes the at-rule (its default
 * `onUnusedExtend` behavior) — no warning, no error, in dev and in the
 * production build alike.
 *
 * Next.js (webpack/css-loader) runs the project's PostCSS plugins BEFORE
 * CSS-module scoping, so the same stylesheet works under `next build`. That
 * ordering is the parity target for vinext.
 *
 * Two fixtures are compared, both App Router apps whose root layout imports
 * app/styles.module.css:
 *
 *   .shared { position: absolute; }
 *   .wrap   { @extend .shared; color: red; }
 *
 * with postcss.config.mjs = { plugins: { "postcss-extend-rule": {} } }
 * (object form, loaded by Vite's own postcss-load-config):
 *
 *   - tests/fixtures/css-module-compatibility        — the plain repro. The
 *     default Vite pipeline drops the @extend inheritance.
 *   - tests/fixtures/css-module-compatibility-fixed  — the same app plus a
 *     vite.config.ts that adds vite-css-modules' patchCssModules() next to
 *     vinext() — the workaround proposed in the issue. vite-css-modules
 *     compiles CSS modules through Vite's module graph (css-loader-style)
 *     instead of the compileCSS black box, so the project's PostCSS plugins
 *     run on the original selectors and @extend resolves.
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { createBuilder } from "vite";
import { buildAppFixture } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/css-module-compatibility");
const FIXED_FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/css-module-compatibility-fixed",
);

async function readAllCss(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  const texts: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".css")) continue;
    const parent =
      (entry as { parentPath?: string; path?: string }).parentPath ??
      (entry as { path?: string }).path ??
      dir;
    texts.push(await fs.readFile(path.join(parent, entry.name), "utf8"));
  }
  return texts.join("\n");
}

/**
 * Bodies of every style rule whose selector mentions `classToken` — for
 * source CSS use ".wrap"; for built CSS use the hashed "_wrap_" infix.
 */
function ruleBodiesForClass(css: string, classToken: string): string[] {
  const bodies: string[] = [];
  const re = new RegExp(`[^{}]*${classToken}[^{}]*\\{([^}]*)\\}`, "g");
  for (const match of css.matchAll(re)) {
    if (match[1]) bodies.push(match[1]);
  }
  return bodies;
}

describe("CSS Module PostCSS plugin ordering (issue #2992)", () => {
  // Fixture sanity, straight from the issue report: "Running the same
  // PostCSS config standalone over the same file resolves the extend
  // correctly, so the configuration is fine — only the ordering inside
  // Vite's pipeline is wrong." postcss runs the plugin against the ORIGINAL
  // selectors here, which is the css-loader/Next.js order.
  it("resolves @extend when the fixture PostCSS config runs standalone", async () => {
    const fixtureRequire = createRequire(path.join(FIXTURE_DIR, "package.json"));
    const postcss = fixtureRequire("postcss");
    const extendRule = fixtureRequire("postcss-extend-rule");
    const cssPath = path.join(FIXTURE_DIR, "app", "styles.module.css");
    const source = await fs.readFile(cssPath, "utf8");

    const result = await postcss([extendRule()]).process(source, { from: cssPath });

    // postcss-extend-rule copies the extended rule's declarations into the
    // extending rule: .wrap gains its own rule with `position: absolute`.
    expect(result.css).not.toContain("@extend");
    const wrapBodies = ruleBodiesForClass(result.css, ".wrap");
    expect(wrapBodies.some((body) => /position:\s*absolute/.test(body))).toBe(true);
  });

  // The plain repro: the fixture has no vite.config.ts, so this builds with
  // the default Vite CSS pipeline (CSS-Modules unshifted ahead of the
  // project's PostCSS plugins).
  describe("default Vite pipeline (fixture: css-module-compatibility)", () => {
    let css = "";

    beforeAll(async () => {
      const rscBundlePath = await buildAppFixture(FIXTURE_DIR);
      const outDir = path.dirname(path.dirname(rscBundlePath));
      css = await readAllCss(outDir);
    }, 180_000);

    it("runs both PostCSS stages on the CSS module (classes hashed, @extend consumed)", () => {
      // CSS-module scoping ran: class names are hashed.
      expect(css).toMatch(/_shared_/);
      expect(css).toMatch(/_wrap_/);
      // postcss-extend-rule ran too — it removed the at-rule even though it
      // could not match anything (default onUnusedExtend drops it silently).
      expect(css).not.toContain("@extend");
      // The extending rule kept its own declarations.
      expect(ruleBodiesForClass(css, "_wrap_").some((body) => /color:\s*red/.test(body))).toBe(
        true,
      );
    });

    // Characterizes the bug. The "with patchCssModules()" describe below
    // proves the same stylesheet resolves correctly once the project's
    // PostCSS plugins run before scoping. If vinext ever fixes the ordering
    // natively, this expectation inverts — remove this test and unskip the
    // parity test below.
    it("reproduces #2992: @extend inherits nothing because hashing ran first", () => {
      // `.wrap` should inherit `position: absolute` from `.shared`, but
      // postcss-extend-rule only saw the hashed selectors (`._shared_…`), so
      // `@extend .shared` matched nothing and the declarations were lost.
      expect(
        ruleBodiesForClass(css, "_wrap_").some((body) => /position:\s*absolute/.test(body)),
      ).toBe(false);
    });

    // SKIP / parity target: Next.js (webpack/css-loader) runs the project's
    // PostCSS plugins before CSS-module scoping, so `@extend .shared`
    // resolves against the original class names and .wrap inherits
    // `position: absolute`.
    //
    // ROOT CAUSE: Vite's compileCSS() unshifts the CSS-Modules plugin ahead
    // of the project's PostCSS plugins (vite/src/node/plugins/css.ts), so
    // user plugins always run on already-hashed selectors.
    //
    // TO FIX: run the project's PostCSS plugins before CSS-module scoping —
    // e.g. pre-expand @extend in an enforce:"pre" transform, or adopt the
    // vite-css-modules approach natively (the "with patchCssModules()"
    // describe below verifies that plugin as a userland workaround).
    //
    // VERIFY: unskip this test; it should pass without fixture changes, and
    // the characterization test above should then be removed.
    it.skip("resolves @extend before CSS-module scoping (Next.js parity)", () => {
      expect(
        ruleBodiesForClass(css, "_wrap_").some((body) => /position:\s*absolute/.test(body)),
      ).toBe(true);
    });
  });

  // The workaround from the issue: same app, but the fixture's vite.config.ts
  // adds vite-css-modules' patchCssModules() next to vinext(). The build
  // deliberately loads that config file (no `configFile: false`) — the plugin
  // living in the user's own vite config is the thing under test. Output
  // lands in the fixture's gitignored dist/ and is cleaned up afterwards.
  describe("with patchCssModules() (fixture: css-module-compatibility-fixed)", () => {
    let css = "";

    beforeAll(async () => {
      // The bare `vinext()` in the fixture's vite.config.ts auto-detects the
      // app directory from process.cwd() — same as running `vinext build`
      // from the project root — so the build must run with the fixture as
      // cwd (see the process.chdir precedent in tests/helpers.ts).
      const previousCwd = process.cwd();
      try {
        process.chdir(FIXED_FIXTURE_DIR);
        const builder = await createBuilder({
          root: FIXED_FIXTURE_DIR,
          logLevel: "silent",
        });
        await builder.buildApp();
      } finally {
        process.chdir(previousCwd);
      }
      css = await readAllCss(path.join(FIXED_FIXTURE_DIR, "dist"));
    }, 180_000);

    afterAll(async () => {
      await fs.rm(path.join(FIXED_FIXTURE_DIR, "dist"), { recursive: true, force: true });
    });

    it("resolves @extend before class-name scoping", () => {
      // postcss-extend-rule ran and consumed the at-rule.
      expect(css).not.toContain("@extend");
      // Both pipelines hash to a `_<local>_<hash>` shape, so the `_wrap_`
      // infix identifies the extending class in this output too.
      const wrapBodies = ruleBodiesForClass(css, "_wrap_");
      // The extending rule kept its own declaration …
      expect(wrapBodies.some((body) => /color:\s*red/.test(body))).toBe(true);
      // … AND inherited `position: absolute` from .shared — the declaration
      // the default pipeline silently drops (see the repro describe above).
      expect(wrapBodies.some((body) => /position:\s*absolute/.test(body))).toBe(true);
    });
  });
});
