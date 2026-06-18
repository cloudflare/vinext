// Ported from Next.js: packages/font/src/google/find-font-files-in-css.ts
// https://github.com/vercel/next.js/blob/canary/packages/font/src/google/find-font-files-in-css.ts
//
// Google Fonts css2 responses contain one @font-face block per available
// unicode subset, each preceded by a `/* <subset> */` comment and carrying
// its own `unicode-range`. Next.js keeps every block in the emitted CSS —
// the browser only downloads files whose unicode-range matches the page's
// content — but emits `<link rel="preload">` only for files whose subset
// the caller listed in `subsets`. This helper walks the CSS line by line,
// tracking the current subset comment, and flags which font files should
// be preloaded.
//
// vinext runs this against the *served* CSS (after gstatic URLs have been
// rewritten to `/<assetsDir>/_vinext_fonts/...`), so the returned URLs are
// directly usable in preload tags. The subset comments survive the URL
// rewrites because only `url(...)` contents are replaced.

export type FontFileInCss = {
  /** The file URL exactly as it appears in the CSS `src: url(...)`. */
  fontFileUrl: string;
  /** True when this file's subset is listed in `subsetsToPreload`. */
  preloadFontFile: boolean;
};

export function findFontFilesInCss(css: string, subsetsToPreload?: string[]): FontFileInCss[] {
  const fontFiles: FontFileInCss[] = [];
  const seen = new Set<string>();

  // Current subset — set by the `/* <subset> */` comment Google emits
  // immediately before each @font-face block.
  let currentSubset = "";
  for (const line of css.split("\n")) {
    const newSubset = /\/\* (.+?) \*\//.exec(line)?.[1];
    if (newSubset) {
      currentSubset = newSubset;
    } else {
      const fontFileUrl = /src: url\((.+?)\)/.exec(line)?.[1];
      if (fontFileUrl && !seen.has(fontFileUrl)) {
        seen.add(fontFileUrl);
        fontFiles.push({
          fontFileUrl,
          preloadFontFile: !!subsetsToPreload?.includes(currentSubset),
        });
      }
    }
  }

  return fontFiles;
}
