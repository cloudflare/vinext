import { describe, expect, it } from "vite-plus/test";
import { findFontFilesInCss } from "../../packages/vinext/src/build/google-fonts/find-font-files-in-css.js";

// Ported behavior from Next.js: packages/font/src/google/find-font-files-in-css.ts
// Google Fonts css2 responses annotate each @font-face block with a
// `/* <subset> */` comment; only files whose subset was requested are
// flagged for preloading (issue #1897).

const GOOGLE_CSS = [
  "/* cyrillic */",
  "@font-face {",
  "  font-family: 'Inter';",
  "  src: url(https://fonts.gstatic.com/s/inter/v20/cyrillic.woff2) format('woff2');",
  "  unicode-range: U+0301, U+0400-045F;",
  "}",
  "/* latin-ext */",
  "@font-face {",
  "  font-family: 'Inter';",
  "  src: url(https://fonts.gstatic.com/s/inter/v20/latin-ext.woff2) format('woff2');",
  "}",
  "/* latin */",
  "@font-face {",
  "  font-family: 'Inter';",
  "  src: url(https://fonts.gstatic.com/s/inter/v20/latin.woff2) format('woff2');",
  "}",
].join("\n");

describe("findFontFilesInCss", () => {
  it("collects every font file with its preload flag from subset comments", () => {
    const files = findFontFilesInCss(GOOGLE_CSS, ["latin"]);
    expect(files).toEqual([
      {
        fontFileUrl: "https://fonts.gstatic.com/s/inter/v20/cyrillic.woff2",
        preloadFontFile: false,
      },
      {
        fontFileUrl: "https://fonts.gstatic.com/s/inter/v20/latin-ext.woff2",
        preloadFontFile: false,
      },
      {
        fontFileUrl: "https://fonts.gstatic.com/s/inter/v20/latin.woff2",
        preloadFontFile: true,
      },
    ]);
  });

  it("flags multiple requested subsets", () => {
    const files = findFontFilesInCss(GOOGLE_CSS, ["latin", "cyrillic"]);
    expect(files.filter((f) => f.preloadFontFile).map((f) => f.fontFileUrl)).toEqual([
      "https://fonts.gstatic.com/s/inter/v20/cyrillic.woff2",
      "https://fonts.gstatic.com/s/inter/v20/latin.woff2",
    ]);
  });

  it("flags nothing when subsetsToPreload is undefined (preload: false)", () => {
    const files = findFontFilesInCss(GOOGLE_CSS, undefined);
    expect(files).toHaveLength(3);
    expect(files.every((f) => !f.preloadFontFile)).toBe(true);
  });

  it("works against served URLs after the cache-dir rewrite", () => {
    // The plugin runs this on the *served* CSS (urls already rewritten to
    // /<assetsDir>/_vinext_fonts/...) — subset comments survive the rewrite.
    const css = [
      "/* latin */",
      "@font-face {",
      "  src: url(/_next/static/_vinext_fonts/inter-abc/inter-12345678.woff2) format('woff2');",
      "}",
    ].join("\n");
    const files = findFontFilesInCss(css, ["latin"]);
    expect(files).toEqual([
      {
        fontFileUrl: "/_next/static/_vinext_fonts/inter-abc/inter-12345678.woff2",
        preloadFontFile: true,
      },
    ]);
  });

  it("deduplicates repeated file URLs", () => {
    const css = ["/* latin */", "src: url(/a.woff2);", "src: url(/a.woff2);"].join("\n");
    expect(findFontFilesInCss(css, ["latin"])).toHaveLength(1);
  });

  it("returns no preloads for CSS without subset comments", () => {
    // Some mocked/edge-case CSS carries no comments; files are still
    // collected (and self-hosted) but none are preloadable.
    const css = "@font-face {\n  src: url(/a.woff2);\n}";
    const files = findFontFilesInCss(css, ["latin"]);
    expect(files).toEqual([{ fontFileUrl: "/a.woff2", preloadFontFile: false }]);
  });
});
