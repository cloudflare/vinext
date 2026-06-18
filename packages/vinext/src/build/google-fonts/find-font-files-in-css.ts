/**
 * Find all font files in the CSS response and determine which files should be preloaded.
 * In Google Fonts responses, the @font-face's subset is above it in a comment.
 * Walk through the CSS from top to bottom, keeping track of the current subset.
 *
 * Ported from Next.js:
 * packages/font/src/google/find-font-files-in-css.ts
 * https://github.com/vercel/next.js/blob/canary/packages/font/src/google/find-font-files-in-css.ts
 */
export function findFontFilesInCss(css: string, subsetsToPreload?: string[]) {
  const fontFiles: Array<{
    googleFontFileUrl: string;
    preloadFontFile: boolean;
  }> = [];

  let currentSubset = "";
  for (const line of css.split("\n")) {
    const newSubset = /\/\* (.+?) \*\//.exec(line)?.[1];
    if (newSubset) {
      currentSubset = newSubset;
    } else {
      const googleFontFileUrl = /src: url\((.+?)\)/.exec(line)?.[1];
      if (
        googleFontFileUrl &&
        !fontFiles.some((foundFile) => foundFile.googleFontFileUrl === googleFontFileUrl)
      ) {
        fontFiles.push({
          googleFontFileUrl,
          preloadFontFile: !!subsetsToPreload?.includes(currentSubset),
        });
      }
    }
  }

  return fontFiles;
}
