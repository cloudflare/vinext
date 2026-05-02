// Ported from Next.js: packages/font/src/google/get-font-axes.ts
// https://github.com/vercel/next.js/blob/canary/packages/font/src/google/get-font-axes.ts
//
// Resolves the axis values that belong in a Google Fonts URL given the
// caller's requested weights, styles, and (optional) selected variable axes.
// For variable fonts this is the only place that turns the literal sentinel
// `"variable"` into the actual `min..max` range from the bundled metadata.

import { googleFontsMetadata } from "./font-metadata.js";
import type { FontAxes } from "./build-url.js";

const formatAvailableValues = (values: string[]): string =>
  values.map((val) => `\`${val}\``).join(", ");

export function getFontAxes(
  fontFamily: string,
  weights: string[],
  styles: string[],
  selectedVariableAxes?: string[],
): FontAxes {
  const hasItalic = styles.includes("italic");
  const hasNormal = styles.includes("normal");
  // Google treats omitted ital as ital=0, so italic-only requests do not need
  // to enumerate ital=0; just ['1'] suffices.
  const ital = hasItalic ? [...(hasNormal ? ["0"] : []), "1"] : undefined;

  // Variable-font sentinel: a single "variable" entry means the caller wants
  // the full axis range from metadata, not a list of explicit weights.
  if (weights[0] === "variable") {
    const allAxes = googleFontsMetadata[fontFamily].axes;
    if (!allAxes) {
      // Reaching this branch means validate accepted a "variable" weight for
      // a non-variable font, which should be impossible because the
      // metadata-based validator rejects this earlier. Treat as an internal
      // invariant.
      throw new Error("invariant variable font without axes");
    }

    if (selectedVariableAxes) {
      const definableAxes = allAxes.map(({ tag }) => tag).filter((tag) => tag !== "wght");
      if (definableAxes.length === 0) {
        throw new Error(`Font \`${fontFamily}\` has no definable \`axes\``);
      }
      if (!Array.isArray(selectedVariableAxes)) {
        throw new Error(
          `Invalid axes value for font \`${fontFamily}\`, expected an array of axes.\nAvailable axes: ${formatAvailableValues(definableAxes)}`,
        );
      }
      for (const key of selectedVariableAxes) {
        if (!definableAxes.includes(key)) {
          throw new Error(
            `Invalid axes value \`${key}\` for font \`${fontFamily}\`.\nAvailable axes: ${formatAvailableValues(definableAxes)}`,
          );
        }
      }
    }

    let weightAxis: string | undefined;
    let variableAxes: [string, string][] | undefined;
    for (const { tag, min, max } of allAxes) {
      if (tag === "wght") {
        weightAxis = `${min}..${max}`;
      } else if (selectedVariableAxes?.includes(tag)) {
        if (!variableAxes) variableAxes = [];
        variableAxes.push([tag, `${min}..${max}`]);
      }
    }

    return {
      wght: weightAxis ? [weightAxis] : undefined,
      ital,
      variableAxes,
    };
  }

  // Non-variable path: weights are explicit face values that the URL builder
  // emits verbatim.
  return {
    wght: weights,
    ital,
    variableAxes: undefined,
  };
}
