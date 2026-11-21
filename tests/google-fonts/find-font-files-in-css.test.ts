import { describe, expect, it } from "vite-plus/test";
import { findFontFilesInCss } from "../../packages/vinext/src/build/google-fonts/find-font-files-in-css.js";

// Ported from Next.js: packages/font/src/google/find-font-files-in-css.test.ts
// https://github.com/vercel/next.js/blob/canary/packages/font/src/google/find-font-files-in-css.test.ts

describe("findFontFilesInCss", () => {
  it.each([
    ["https://fonts.gstatic.com/l/font?kit=a=b&skey=c&v=v20", "format('woff2')", "woff2"],
    ["https://fonts.gstatic.com/l/font?kit=a%2Bb&skey=c", 'format("woff")', "woff"],
    ["https://fonts.gstatic.com/l/font", "format('truetype')", "ttf"],
    ["https://fonts.gstatic.com/l/font", "format('opentype')", "otf"],
    ["https://fonts.gstatic.com/l/font", "format('embedded-opentype')", "eot"],
    ["https://fonts.gstatic.com/l/font", "", "woff2"],
    ["https://fonts.gstatic.com/l/font", "format('unknown')", "woff2"],
    ["https://fonts.gstatic.com/s/font.ttf?kit=a&v=1#font", "format('woff2')", "ttf"],
    ["https://fonts.gstatic.com/l/font?kit=a.woff", "format('woff2')", "woff2"],
  ])("resolves the extension of %s %s as %s", (url, format, ext) => {
    const css = `/* latin */
@font-face {
  src: url(${url}) ${format};
}
@font-face {
  src: url(${url}) ${format};
}`;
    expect(findFontFilesInCss(css, ["latin"])).toEqual([
      { googleFontFileUrl: url, preloadFontFile: true, ext },
    ]);
  });

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
        ext: "woff2",
      },
      {
        googleFontFileUrl: "/fonts/inter-latin.woff2",
        preloadFontFile: true,
        ext: "woff2",
      },
      {
        googleFontFileUrl: "/fonts/inter-latin-ext.woff2",
        preloadFontFile: false,
        ext: "woff2",
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
        ext: "woff2",
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
        ext: "woff2",
      },
    ]);
  });
});
