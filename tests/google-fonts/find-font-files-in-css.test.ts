import { describe, expect, it } from "vite-plus/test";
import { findFontFilesInCss } from "../../packages/vinext/src/build/google-fonts/find-font-files-in-css.js";

// Ported from Next.js: packages/font/src/google/find-font-files-in-css.test.ts
// https://github.com/vercel/next.js/blob/canary/packages/font/src/google/find-font-files-in-css.test.ts

describe("findFontFilesInCss", () => {
  it("finds all font files and preloads only requested subsets", () => {
    const css = `/* cyrillic */
@font-face { src: url(/fonts/inter-cyrillic.woff2) format('woff2'); }
/* latin */
@font-face { src: url(/fonts/inter-latin.woff2) format('woff2'); }
/* latin-ext */
@font-face { src: url(/fonts/inter-latin-ext.woff2) format('woff2'); }`;

    expect(findFontFilesInCss(css, ["latin"])).toEqual([
      {
        googleFontFileUrl: "/fonts/inter-cyrillic.woff2",
        preloadFontFile: false,
      },
      {
        googleFontFileUrl: "/fonts/inter-latin.woff2",
        preloadFontFile: true,
      },
      {
        googleFontFileUrl: "/fonts/inter-latin-ext.woff2",
        preloadFontFile: false,
      },
    ]);
  });

  it("does not preload font files when preloading is disabled", () => {
    const css = `/* latin */
@font-face { src: url(/fonts/inter-latin.woff2) format('woff2'); }`;

    expect(findFontFilesInCss(css)).toEqual([
      {
        googleFontFileUrl: "/fonts/inter-latin.woff2",
        preloadFontFile: false,
      },
    ]);
  });

  it("deduplicates font files shared by multiple variants", () => {
    const css = `/* latin */
@font-face { font-weight: 400; src: url(/fonts/inter-latin.woff2) format('woff2'); }
/* latin */
@font-face { font-weight: 700; src: url(/fonts/inter-latin.woff2) format('woff2'); }`;

    expect(findFontFilesInCss(css, ["latin"])).toEqual([
      {
        googleFontFileUrl: "/fonts/inter-latin.woff2",
        preloadFontFile: true,
      },
    ]);
  });
});
