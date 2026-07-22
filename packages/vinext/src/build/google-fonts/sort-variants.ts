// Ported from Next.js: packages/font/src/google/sort-fonts-variant-values.ts
// https://github.com/vercel/next.js/blob/canary/packages/font/src/google/sort-fonts-variant-values.ts
//
// Comparator used by `Array.prototype.sort` when assembling the variant
// segment of a Google Fonts URL. Google's CSS API requires variant values to
// be ordered numerically, not lexically. The string ordering of
// `["100","1000","300"]` would put 1000 before 300, and `["1,100","0,200"]`
// would put the higher ital prefix first; both produce HTTP 400.

export function sortFontsVariantValues(valA: string, valB: string): number {
  // "ital,wght" pair format: compare ital first, then wght when ital matches.
  if (valA.includes(",") && valB.includes(",")) {
    const [aPrefix, aSuffix] = valA.split(",", 2);
    const [bPrefix, bSuffix] = valB.split(",", 2);

    if (aPrefix === bPrefix) {
      return parseInt(aSuffix) - parseInt(bSuffix);
    }
    return parseInt(aPrefix) - parseInt(bPrefix);
  }

  // Plain weight string: numeric compare.
  return parseInt(valA) - parseInt(valB);
}
