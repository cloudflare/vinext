// Public surface for the Google Fonts metadata + URL pipeline.
//
// This barrel exists so consumers (build plugin in PR 2) import a single
// path without having to know whether a helper lives in `validate.ts` vs
// `get-axes.ts` vs `build-url.ts`. The shape mirrors Next.js's flow:
//
//   validateGoogleFontOptions(family, opts) → ValidatedGoogleFontOptions
//   getFontAxes(family, weights, styles, axes) → FontAxes
//   buildGoogleFontsUrl(family, axes, display) → URL string

export { validateGoogleFontOptions } from "./validate.js";
export type { GoogleFontOptions, ValidatedGoogleFontOptions } from "./validate.js";

export { getFontAxes } from "./get-axes.js";

export { buildGoogleFontsUrl } from "./build-url.js";
export type { FontAxes } from "./build-url.js";

export { sortFontsVariantValues } from "./sort-variants.js";

export { googleFontsMetadata } from "./font-metadata.js";
export type { FontFamilyMetadata, VariableAxisDescriptor } from "./font-metadata.js";
