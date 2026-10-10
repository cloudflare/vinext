/**
 * Fallback font metrics for `next/font/local`'s `adjustFontFallback`.
 *
 * Ported from Next.js:
 * packages/font/src/local/get-fallback-metrics-from-font-file.ts
 * https://github.com/vercel/next.js/blob/canary/packages/font/src/local/get-fallback-metrics-from-font-file.ts
 * packages/font/src/local/pick-font-file-for-fallback-generation.ts
 * https://github.com/vercel/next.js/blob/canary/packages/font/src/local/pick-font-file-for-fallback-generation.ts
 *
 * Next.js reads the font with fontkit; vinext uses the minimal reader in
 * `./font-file.ts`, which produces the same values.
 */

import type { AdjustFontFallback } from "../google-fonts/fallback-metrics.js";
import { readFontFile, type FontFile } from "./font-file.js";

/** The font file values `getFallbackMetricsFromFontFile` depends on. */
export type LocalFontMetrics = {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
  /** Average width of `AVG_CHARACTERS`, undefined when a character is missing. */
  azAvgWidth: number | undefined;
};

// The font metadata of the fallback fonts, retrieved with fontkit on system
// font files. The average width is calculated with `calcAverageWidth` below.
const DEFAULT_SANS_SERIF_FONT = {
  name: "Arial",
  azAvgWidth: 934.5116279069767,
  unitsPerEm: 2048,
};
const DEFAULT_SERIF_FONT = {
  name: "Times New Roman",
  azAvgWidth: 854.3953488372093,
  unitsPerEm: 2048,
};

// Next.js picked these characters to approximate the average width of Latin
// text, taking letter frequency and word length (spaces) into account.
const AVG_CHARACTERS = "aaabcdeeeefghiijklmnnoopqrrssttuvwxyz      ";

const NORMAL_WEIGHT = 400;
const BOLD_WEIGHT = 700;
const WEIGHT_SEPARATOR_RE = / +/;

function calcAverageWidth(font: FontFile): number | undefined {
  try {
    let totalWidth = 0;
    for (const character of AVG_CHARACTERS) {
      // Every character must have a glyph, otherwise skip size-adjust.
      const glyph = font.glyphForCodePoint(character.charCodeAt(0));
      if (glyph === 0) return undefined;
      totalWidth += font.advanceWidth(glyph);
    }
    return totalWidth / AVG_CHARACTERS.length;
  } catch {
    // Could not calculate the average width from the font file, skip size-adjust
    return undefined;
  }
}

/**
 * Read the values needed for fallback metrics from a font file. Throws when
 * the file can't be read as a font, where Next.js logs
 * `Failed to load font file` and generates no fallback face.
 */
export function readLocalFontMetrics(bytes: Uint8Array): LocalFontMetrics {
  const font = readFontFile(bytes);
  return {
    unitsPerEm: font.unitsPerEm,
    ascent: font.ascent,
    descent: font.descent,
    lineGap: font.lineGap,
    azAvgWidth: calcAverageWidth(font),
  };
}

function formatOverrideValue(value: number): string {
  return Math.abs(value * 100).toFixed(2) + "%";
}

/**
 * Given font file metrics and a category, calculate the fallback font
 * override values used to generate the adjusted fallback `@font-face`.
 */
export function getFallbackMetricsFromFontFile(
  font: LocalFontMetrics,
  category: "serif" | "sans-serif" = "serif",
): AdjustFontFallback {
  const fallbackFont = category === "serif" ? DEFAULT_SERIF_FONT : DEFAULT_SANS_SERIF_FONT;
  const { ascent, descent, lineGap, unitsPerEm, azAvgWidth } = font;
  const fallbackFontAvgWidth = fallbackFont.azAvgWidth / fallbackFont.unitsPerEm;
  const sizeAdjust = azAvgWidth ? azAvgWidth / unitsPerEm / fallbackFontAvgWidth : 1;

  return {
    ascentOverride: formatOverrideValue(ascent / (unitsPerEm * sizeAdjust)),
    descentOverride: formatOverrideValue(descent / (unitsPerEm * sizeAdjust)),
    lineGapOverride: formatOverrideValue(lineGap / (unitsPerEm * sizeAdjust)),
    fallbackFont: fallbackFont.name,
    sizeAdjust: formatOverrideValue(sizeAdjust),
  };
}

function getWeightNumber(weight: string): number {
  return weight === "normal" ? NORMAL_WEIGHT : weight === "bold" ? BOLD_WEIGHT : Number(weight);
}

/**
 * Get the distance from normal (400) weight for the provided weight. Variable
 * font ranges ("100 900") compare the range to 400. Returns undefined for an
 * invalid weight, where Next.js throws.
 */
function getDistanceFromNormalWeight(weight: string | undefined): number | undefined {
  if (!weight) return 0;

  const [firstWeight, secondWeight] = weight.trim().split(WEIGHT_SEPARATOR_RE).map(getWeightNumber);
  if (Number.isNaN(firstWeight) || Number.isNaN(secondWeight)) return undefined;

  // Not a variable font: just return the distance from normal weight
  if (!secondWeight) return firstWeight - NORMAL_WEIGHT;

  // Normal weight is within the variable font range
  if (firstWeight <= NORMAL_WEIGHT && secondWeight >= NORMAL_WEIGHT) return 0;

  // Normal weight is outside the variable font range
  const firstWeightDistance = firstWeight - NORMAL_WEIGHT;
  const secondWeightDistance = secondWeight - NORMAL_WEIGHT;
  if (Math.abs(firstWeightDistance) < Math.abs(secondWeightDistance)) {
    return firstWeightDistance;
  }
  return secondWeightDistance;
}

/**
 * If multiple font files are provided for a font family, pick the one most
 * likely to be used for the bulk of the text on a page:
 * - most text has normal weight, so use the one closest to 400
 * - most text has normal style, so prefer normal over italic
 * - with the same distance from normal weight, prefer the thinner one
 *
 * Returns undefined for an empty list or an invalid weight (Next.js throws
 * for the latter; vinext keeps accepting the call without a fallback face).
 */
export function pickFontFileForFallbackGeneration<T extends { weight?: string; style?: string }>(
  fontFiles: readonly T[],
): T | undefined {
  let usedFontFile: T | undefined;
  for (const currentFontFile of fontFiles) {
    if (!usedFontFile) {
      usedFontFile = currentFontFile;
      continue;
    }

    const usedFontDistance = getDistanceFromNormalWeight(usedFontFile.weight);
    const currentFontDistance = getDistanceFromNormalWeight(currentFontFile.weight);
    if (usedFontDistance === undefined || currentFontDistance === undefined) return undefined;

    // Prefer normal style if they have the same weight
    if (
      usedFontDistance === currentFontDistance &&
      (currentFontFile.style === undefined || currentFontFile.style === "normal")
    ) {
      usedFontFile = currentFontFile;
      continue;
    }

    const absUsedDistance = Math.abs(usedFontDistance);
    const absCurrentDistance = Math.abs(currentFontDistance);

    // Use closest absolute distance to normal weight, preferring the thinner
    // font if both have the same absolute distance
    if (
      absCurrentDistance < absUsedDistance ||
      (absUsedDistance === absCurrentDistance && currentFontDistance < usedFontDistance)
    ) {
      usedFontFile = currentFontFile;
    }
  }
  return usedFontFile;
}
