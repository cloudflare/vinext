import type { Plugin, UserConfig } from "vite";

type CssTarget = NonNullable<UserConfig["build"]>["cssTarget"];

/**
 * CSS minification target. Vite defaults it to the same target as JS
 * (modern evergreens), which lets the CSS minifier (Lightning CSS by
 * default, or esbuild) rewrite
 * `@media (max-width: 768px)` to the Media Queries Level 4 range
 * syntax `@media (width <= 768px)`. Both forms are semantically
 * equivalent in modern browsers, but the rewrite is observable to
 * user code that inspects `cssText` of `CSSMediaRule`s and breaks
 * tools that pattern-match the raw query string. Next.js does not
 * perform this rewrite by default (its webpack/lightningcss CSS
 * pipeline preserves the original syntax), so user code carried
 * over from Next.js can break when migrating to vinext.
 *
 * The minifier lowers a CSS feature when ANY target in the list lacks
 * support, so we only need to pin one engine below the range-syntax
 * baseline. Range syntax shipped in Chrome 104, Edge 104, Firefox 63,
 * and Safari 16.4 (per esbuild's `internal/compat/css_table.go`
 * MediaRange entry — and caniuse). Of those, Safari is the latest:
 * pinning `safari15` (semantically Safari 15.0, which predates
 * Safari 16.4) is sufficient to suppress the rewrite on its own.
 *
 * The other three targets are pinned to ~2023 baselines instead of
 * the absolute oldest supported version so the minifier does NOT
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
 * stop an app from ever raising it. Instead nothing is set while config hooks
 * run, so the app and every plugin hook see and merge plain Vite values. The
 * post-ordered `config` and `configEnvironment` hooks only note where a target
 * was set, and the pin is applied once config is resolved.
 *
 * Both the top-level `build`, which Vite's CSS plugin minifies with (a copy of
 * the environment's in per-environment builds), and every environment's `build`
 * are checked.
 */
export function createCssTargetPlugin(): Plugin {
  let topLevelConfigured = false;
  const configuredEnvironments = new Set<string>();

  return {
    name: "vinext:css-target",
    enforce: "post",
    config: {
      order: "post",
      handler(config) {
        topLevelConfigured = config.build?.cssTarget !== undefined;
        configuredEnvironments.clear();
      },
    },
    configEnvironment: {
      order: "post",
      handler(name, config) {
        if (config.build?.cssTarget !== undefined) configuredEnvironments.add(name);
      },
    },
    configResolved: {
      // Before normal and post-ordered configResolved hooks read the target.
      order: "pre",
      handler(config) {
        pinUnsetCssTarget(config.build, topLevelConfigured);
        for (const [name, environment] of Object.entries(config.environments)) {
          pinUnsetCssTarget(environment.build, configuredEnvironments.has(name));
        }
      },
    },
  };
}

function pinUnsetCssTarget(build: { cssTarget: CssTarget; target: unknown }, configured: boolean) {
  // Vite resolves an unset `cssTarget` to the very value of `target`. A target
  // array set by a hook that runs after the ones above is a separate value.
  if (configured || build.cssTarget !== build.target) return;
  build.cssTarget = [...DEFAULT_CSS_TARGET];
}
