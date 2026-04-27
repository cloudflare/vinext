// Ported from Next.js: packages/font/src/google/validate-google-font-function-call.ts
// https://github.com/vercel/next.js/blob/canary/packages/font/src/google/validate-google-font-function-call.ts
//
// Vinext drops Next's SWC-coupled `(functionName, fontFunctionArgument)`
// calling convention because the plugin already knows the family at parse
// time. Behaviour is otherwise identical: validate the caller's options
// against the bundled metadata, default missing fields, and reject anything
// Google Fonts would reject at request time.

import { googleFontsMetadata } from "./font-metadata.js";

const ALLOWED_DISPLAY_VALUES = ["auto", "block", "swap", "fallback", "optional"];

type GoogleFontOptions = {
  weight?: string | string[];
  style?: string | string[];
  preload?: boolean;
  display?: string;
  axes?: string[];
  fallback?: string[];
  adjustFontFallback?: boolean;
  variable?: string;
  subsets?: string[];
};

type ValidatedGoogleFontOptions = {
  fontFamily: string;
  weights: string[];
  styles: string[];
  display: string;
  preload: boolean;
  selectedVariableAxes?: string[];
  fallback?: string[];
  adjustFontFallback: boolean;
  variable?: string;
  subsets: string[];
};

const formatAvailableValues = (values: string[]): string =>
  values.map((val) => `\`${val}\``).join(", ");

const dedupe = (values: string[]): string[] => Array.from(new Set(values));

export function validateGoogleFontOptions(
  fontFamily: string,
  options: GoogleFontOptions,
): ValidatedGoogleFontOptions {
  const {
    weight,
    style,
    display = "swap",
    axes,
    fallback,
    adjustFontFallback = true,
    variable,
    subsets = [],
  } = options;
  let preload = options.preload ?? true;

  const fontFamilyData = googleFontsMetadata[fontFamily];
  if (!fontFamilyData) {
    throw new Error(`Unknown font \`${fontFamily}\``);
  }

  if (axes !== undefined && !Array.isArray(axes)) {
    throw new Error(
      `Invalid axes value for font \`${fontFamily}\`, expected an array of axis names.`,
    );
  }

  const availableSubsets = fontFamilyData.subsets;
  if (availableSubsets.length === 0) {
    // No preloadable subsets means preload is meaningless. Silently disable
    // it rather than forcing the caller to opt out.
    preload = false;
  } else if (preload) {
    // Deliberate parity gap: Next.js uses `if (!subsets)` so an explicit
    // `subsets: []` passes silently. vinext rejects it as well, since an
    // empty subsets array with preload enabled is always a caller mistake.
    if (subsets.length === 0) {
      throw new Error(
        `Preload is enabled but no subsets were specified for font \`${fontFamily}\`. Please specify subsets or disable preloading if your intended subset can't be preloaded.\nAvailable subsets: ${formatAvailableValues(availableSubsets)}`,
      );
    }
    for (const subset of subsets) {
      if (!availableSubsets.includes(subset)) {
        throw new Error(
          `Unknown subset \`${subset}\` for font \`${fontFamily}\`.\nAvailable subsets: ${formatAvailableValues(availableSubsets)}`,
        );
      }
    }
  }

  const fontWeights = fontFamilyData.weights;
  const fontStyles = fontFamilyData.styles;

  const weights = !weight ? [] : dedupe(Array.isArray(weight) ? weight : [weight]);
  const styles = !style ? [] : dedupe(Array.isArray(style) ? style : [style]);

  if (weights.length === 0) {
    if (fontWeights.includes("variable")) {
      // Caller said "any weight" and the font has a variable face, so use it.
      weights.push("variable");
    } else {
      throw new Error(
        `Missing weight for font \`${fontFamily}\`.\nAvailable weights: ${formatAvailableValues(fontWeights)}`,
      );
    }
  }

  if (weights.length > 1 && weights.includes("variable")) {
    throw new Error(
      `Unexpected \`variable\` in weight array for font \`${fontFamily}\`. You only need \`variable\`, it includes all available weights.`,
    );
  }

  for (const selectedWeight of weights) {
    if (!fontWeights.includes(selectedWeight)) {
      throw new Error(
        `Unknown weight \`${selectedWeight}\` for font \`${fontFamily}\`.\nAvailable weights: ${formatAvailableValues(fontWeights)}`,
      );
    }
  }

  if (styles.length === 0) {
    if (fontStyles.length === 1) {
      // Italic-only fonts (rare) have no normal face, so use that face.
      styles.push(fontStyles[0]);
    } else {
      styles.push("normal");
    }
  }

  for (const selectedStyle of styles) {
    if (!fontStyles.includes(selectedStyle)) {
      throw new Error(
        `Unknown style \`${selectedStyle}\` for font \`${fontFamily}\`.\nAvailable styles: ${formatAvailableValues(fontStyles)}`,
      );
    }
  }

  if (!ALLOWED_DISPLAY_VALUES.includes(display)) {
    throw new Error(
      `Invalid display value \`${display}\` for font \`${fontFamily}\`.\nAvailable display values: ${formatAvailableValues(ALLOWED_DISPLAY_VALUES)}`,
    );
  }

  if (axes) {
    if (!fontWeights.includes("variable")) {
      throw new Error("Axes can only be defined for variable fonts.");
    }
    if (weights[0] !== "variable") {
      throw new Error(
        "Axes can only be defined for variable fonts when the weight property is nonexistent or set to `variable`.",
      );
    }
  }

  return {
    fontFamily,
    weights,
    styles,
    display,
    preload,
    selectedVariableAxes: axes,
    fallback,
    adjustFontFallback,
    variable,
    subsets,
  };
}
