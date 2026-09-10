import { defineConfig } from "vite";
import vinext from "vinext";
import { patchCssModules } from "vite-css-modules";

// Workaround for https://github.com/cloudflare/vinext/issues/2992:
// vite-css-modules takes CSS-module handling out of Vite's compileCSS black
// box (where the CSS-Modules plugin is unshifted ahead of the project's
// PostCSS plugins) and integrates it into the module graph instead, so the
// project's postcss.config (postcss-extend-rule) sees the original selectors
// and `@extend` can resolve.
export default defineConfig({
  plugins: [vinext(), patchCssModules()],
});
