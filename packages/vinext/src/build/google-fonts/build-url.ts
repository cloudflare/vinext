// Ported from Next.js: packages/font/src/google/get-google-fonts-url.ts
// https://github.com/vercel/next.js/blob/canary/packages/font/src/google/get-google-fonts-url.ts
//
// Constructs a Google Fonts CSS API URL from already-validated axis data.
// The caller is responsible for resolving the actual axis values (e.g. by
// reading `wght` min..max from the bundled font metadata for variable fonts);
// this module's only job is URL assembly.

import { sortFontsVariantValues } from "./sort-variants.js";

export type FontAxes = {
  /** Weight values: explicit faces ("400") or a variable range ("400..800"). */
  wght?: string[];
  /** Ital values, "0" (normal) and/or "1" (italic). */
  ital?: string[];
  /** Other variable axes the caller wants to include, e.g. `[["opsz","14..32"]]`. */
  variableAxes?: [string, string][];
};

export function buildGoogleFontsUrl(fontFamily: string, axes: FontAxes, display: string): string {
  // A "variant" is one combination of axis values that becomes one entry in
  // the URL's variant list. Each variant is a list of [key, value] pairs in
  // the order Google expects.
  const variants: Array<[string, string][]> = [];

  if (axes.wght) {
    for (const wght of axes.wght) {
      if (!axes.ital) {
        variants.push([["wght", wght], ...(axes.variableAxes ?? [])]);
      } else {
        for (const ital of axes.ital) {
          variants.push([["ital", ital], ["wght", wght], ...(axes.variableAxes ?? [])]);
        }
      }
    }
  } else if (axes.variableAxes) {
    // Variable font with no requested wght: emit only the other variable axes.
    variants.push([...axes.variableAxes]);
  }

  // Google requires axis tags within a variant to be ordered with lowercase
  // tags first, then alphabetically. Every variant must agree on the same
  // key order, since the URL takes the key list from variants[0] and
  // applies it to every variant's value list.
  if (axes.variableAxes) {
    for (const variant of variants) {
      variant.sort(([a], [b]) => {
        const aIsLowercase = a.charCodeAt(0) > 96;
        const bIsLowercase = b.charCodeAt(0) > 96;
        if (aIsLowercase && !bIsLowercase) return -1;
        if (bIsLowercase && !aIsLowercase) return 1;
        return a > b ? 1 : -1;
      });
    }
  }

  let url = `https://fonts.googleapis.com/css2?family=${fontFamily.replace(/ /g, "+")}`;

  if (variants.length > 0) {
    const keyList = variants[0].map(([key]) => key).join(",");
    const valueLists = variants
      .map((variant) => variant.map(([, val]) => val).join(","))
      .sort(sortFontsVariantValues)
      .join(";");
    url = `${url}:${keyList}@${valueLists}`;
  }

  return `${url}&display=${display}`;
}
