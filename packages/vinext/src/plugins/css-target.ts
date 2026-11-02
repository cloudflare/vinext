import type { Plugin, UserConfig } from "vite";

type CssTarget = NonNullable<UserConfig["build"]>["cssTarget"];

/**
 * CSS minification target. Vite/esbuild defaults to the same target
 * as JS (modern evergreens), which lets esbuild's CSS minifier rewrite
 * `@media (max-width: 768px)` to the Media Queries Level 4 range
 * syntax `@media (width <= 768px)`. Both forms are semantically
 * equivalent in modern browsers, but the rewrite is observable to
 * user code that inspects `cssText` of `CSSMediaRule`s and breaks
 * tools that pattern-match the raw query string. Next.js does not
 * perform this rewrite by default (its webpack/lightningcss CSS
 * pipeline preserves the original syntax), so user code carried
 * over from Next.js can break when migrating to vinext.
 *
 * esbuild lowers a CSS feature when ANY target in the list lacks
 * support, so we only need to pin one engine below the range-syntax
 * baseline. Range syntax shipped in Chrome 104, Edge 104, Firefox 63,
 * and Safari 16.4 (per esbuild's `internal/compat/css_table.go`
 * MediaRange entry — and caniuse). Of those, Safari is the latest:
 * pinning `safari15` (semantically Safari 15.0, which predates
 * Safari 16.4) is sufficient to suppress the rewrite on its own.
 *
 * The other three targets are pinned to ~2023 baselines instead of
 * the absolute oldest supported version so esbuild does NOT
 * collaterally downlevel unrelated modern CSS features. With
 * chrome111/edge111/firefox114 we keep through:
 *   - `:is()` pseudo-class (Chrome 88, Firefox 78)
 *   - `hwb()` colors (Chrome 101, Firefox 96)
 *   - `lab()`, `oklch()`, `color()` (Chrome 111, Firefox 113)
 *   - gradient interpolation hints (Chrome 111)
 * CSS Nesting (Chrome 120, Safari 17.2) and Firefox-137 gradient
 * interpolation will still be lowered; that is an intentional
 * trade-off — those features are newer than the baseline and
 * lowering them is the correct behavior for our target audience.
 *
 * Mirrors the Next.js fixture
 * test/e2e/app-dir/css-media-query/css-media-query.test.ts which
 * asserts `cssText` preserves `max-width: 768px`.
 */
const DEFAULT_CSS_TARGET = ["chrome111", "edge111", "firefox114", "safari15"];

/**
 * Applies {@link DEFAULT_CSS_TARGET} only where nobody chose a target (#4413).
 *
 * Vite merges config by concatenating arrays, and the CSS minifier keeps the
 * oldest version of each browser, so a pin merged onto a chosen target would
 * stop an app from ever raising it. `false` is a real Vite value (skip CSS
 * syntax lowering), so only `undefined` means "not chosen".
 *
 * The `config` hook runs last so that targets set by the app or by any other
 * plugin's `config` hook are visible. The pin stays at the top level because
 * dev and `builder.sharedConfigBuild` builds read the top-level `build`.
 * Vite then folds the top-level `build` into each environment, which would
 * concatenate the pin onto a per-environment target, so `configEnvironment`
 * puts those targets back as they were declared.
 */
export function createCssTargetPlugin(): Plugin {
  let environmentTargets = new Map<string, CssTarget>();

  return {
    name: "vinext:css-target",
    config: {
      order: "post",
      handler(config) {
        environmentTargets = new Map();
        if (config.build?.cssTarget !== undefined) return;
        for (const [name, environment] of Object.entries(config.environments ?? {})) {
          const target = environment?.build?.cssTarget;
          if (target !== undefined) environmentTargets.set(name, target);
        }
        return { build: { cssTarget: DEFAULT_CSS_TARGET } };
      },
    },
    configEnvironment(name, config) {
      if (!environmentTargets.has(name)) return;
      config.build ??= {};
      config.build.cssTarget = environmentTargets.get(name);
    },
  };
}
