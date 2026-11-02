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
 * Stands in for {@link DEFAULT_CSS_TARGET} until config is resolved. As a
 * single string it merges like an unset value: a later scalar replaces it,
 * and a later array is concatenated after it.
 */
const DEFAULT_CSS_TARGET_MARKER = "vinext:default-css-target";

/**
 * Applies {@link DEFAULT_CSS_TARGET} only where nobody chose a target (#4413).
 *
 * Vite merges config by concatenating arrays, and the CSS minifier keeps the
 * oldest version of each browser, so a pin merged onto a chosen target would
 * stop an app from ever raising it. `false` is a real Vite value (skip CSS
 * syntax lowering), so only `undefined` means "not chosen".
 *
 * The marker is set at the top level, which dev and `builder.sharedConfigBuild`
 * builds read and Vite folds into every environment. Once config is resolved,
 * a marker left on its own becomes the pin, and a marker inside an array is
 * removed. Every target set by the app or another plugin's hook, at any level
 * or hook order, then resolves exactly as it would without vinext.
 */
export function createCssTargetPlugin(): Plugin {
  return {
    name: "vinext:css-target",
    config: {
      order: "post",
      handler(config) {
        if (config.build?.cssTarget === undefined) {
          return { build: { cssTarget: DEFAULT_CSS_TARGET_MARKER } };
        }
      },
    },
    configResolved: {
      // Before any other plugin's configResolved can read the marker.
      order: "pre",
      handler(config) {
        const builds = [
          config.build,
          ...Object.values(config.environments).map((env) => env.build),
        ];
        for (const build of builds) {
          (build as { cssTarget: CssTarget }).cssTarget = resolveCssTarget(build.cssTarget);
        }
      },
    },
  };
}

function resolveCssTarget(target: CssTarget): CssTarget {
  if (target === DEFAULT_CSS_TARGET_MARKER) return [...DEFAULT_CSS_TARGET];
  if (!Array.isArray(target)) return target;
  return target.filter((entry) => entry !== DEFAULT_CSS_TARGET_MARKER);
}
