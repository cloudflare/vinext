/**
 * Font fallback metrics and hashing utilities.
 *
 * Generates adjusted fallback @font-face declarations to reduce CLS (Cumulative
 * Layout Shift) during font loading. Uses the same algorithm as Next.js:
 * - Google fonts: precalculated metrics from @capsizecss/metrics
 * - Local fonts: metrics extracted from font files via fontkitten
 *
 * Also provides font-family name hashing for class name scoping, matching
 * Next.js's `__FontFamily_<hash>` pattern.
 *
 * Build-time only — never imported at runtime or bundled into production output.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FontMetrics {
  ascent: number;
  descent: number;
  lineGap: number;
  unitsPerEm: number;
  xWidthAvg: number;
  category?: "serif" | "sans-serif" | "monospace" | "display" | "handwriting";
}

export interface FallbackFontResult {
  /** The generated @font-face CSS for the fallback font */
  css: string;
  /** The fallback font-family name (e.g. "__Inter_a3b2c1 Fallback") */
  fallbackFamily: string;
  /** The system font used as the base (e.g. "Arial") */
  fallbackFont: string;
}

// ---------------------------------------------------------------------------
// System font metrics — loaded from @capsizecss/metrics at first use
// ---------------------------------------------------------------------------

let _arialMetrics: FontMetrics | undefined;
let _timesNewRomanMetrics: FontMetrics | undefined;

async function getSystemFontMetrics(font: "Arial" | "Times New Roman"): Promise<FontMetrics> {
  if (font === "Arial" && _arialMetrics) return _arialMetrics;
  if (font === "Times New Roman" && _timesNewRomanMetrics) return _timesNewRomanMetrics;

  const { entireMetricsCollection } = await import("@capsizecss/metrics/entireMetricsCollection");
  const collection = entireMetricsCollection as unknown as Record<string, {
    ascent: number; descent: number; lineGap: number; unitsPerEm: number; xWidthAvg: number;
  } | undefined>;

  // Arial and Times New Roman are in the capsize collection
  const arialEntry = collection["arial"];
  const tnrEntry = collection["timesNewRoman"];

  _arialMetrics = arialEntry ? {
    ascent: arialEntry.ascent, descent: arialEntry.descent,
    lineGap: arialEntry.lineGap, unitsPerEm: arialEntry.unitsPerEm,
    xWidthAvg: arialEntry.xWidthAvg, category: "sans-serif" as const,
  } : {
    // Fallback values if capsize doesn't have Arial (shouldn't happen)
    ascent: 1854, descent: -434, lineGap: 67, unitsPerEm: 2048, xWidthAvg: 904.16, category: "sans-serif" as const,
  };

  _timesNewRomanMetrics = tnrEntry ? {
    ascent: tnrEntry.ascent, descent: tnrEntry.descent,
    lineGap: tnrEntry.lineGap, unitsPerEm: tnrEntry.unitsPerEm,
    xWidthAvg: tnrEntry.xWidthAvg, category: "serif" as const,
  } : {
    ascent: 1825, descent: -443, lineGap: 87, unitsPerEm: 2048, xWidthAvg: 819.72, category: "serif" as const,
  };

  return font === "Arial" ? _arialMetrics : _timesNewRomanMetrics;
}

// ---------------------------------------------------------------------------
// Capsize math — identical to Next.js's calculateSizeAdjustValues
// ---------------------------------------------------------------------------

function formatOverrideValue(val: number): string {
  return Math.abs(val * 100).toFixed(2);
}

interface SizeAdjustValues {
  sizeAdjust: string;
  ascentOverride: string;
  descentOverride: string;
  lineGapOverride: string;
  fallbackFont: string;
}

/**
 * Calculate size-adjust values for a fallback font.
 *
 * The math matches Next.js (packages/next/src/server/font-utils.ts) and
 * capsize exactly:
 *   sizeAdjust = (font.xWidthAvg / font.unitsPerEm) / (fallback.xWidthAvg / fallback.unitsPerEm)
 *   ascentOverride  = ascent  / (unitsPerEm * sizeAdjust)
 *   descentOverride = |descent| / (unitsPerEm * sizeAdjust)
 *   lineGapOverride = lineGap / (unitsPerEm * sizeAdjust)
 */
export async function calculateSizeAdjustValues(
  metrics: FontMetrics,
  fallbackBase?: "Arial" | "Times New Roman",
): Promise<SizeAdjustValues> {
  const fallback = resolveFallbackBase(metrics, fallbackBase);
  const fallbackMetrics = await getSystemFontMetrics(fallback);

  const mainFontAvgWidth = metrics.xWidthAvg / metrics.unitsPerEm;
  const fallbackFontAvgWidth = fallbackMetrics.xWidthAvg / fallbackMetrics.unitsPerEm;
  const sizeAdjust = metrics.xWidthAvg ? mainFontAvgWidth / fallbackFontAvgWidth : 1;

  return {
    sizeAdjust: formatOverrideValue(sizeAdjust),
    ascentOverride: formatOverrideValue(metrics.ascent / (metrics.unitsPerEm * sizeAdjust)),
    descentOverride: formatOverrideValue(metrics.descent / (metrics.unitsPerEm * sizeAdjust)),
    lineGapOverride: formatOverrideValue(metrics.lineGap / (metrics.unitsPerEm * sizeAdjust)),
    fallbackFont: fallback,
  };
}

/**
 * Determine which system font to use as the fallback base.
 * If explicitly specified, use that. Otherwise infer from font category.
 */
function resolveFallbackBase(
  metrics: FontMetrics,
  explicit?: "Arial" | "Times New Roman",
): "Arial" | "Times New Roman" {
  if (explicit) return explicit;
  return metrics.category === "serif" ? "Times New Roman" : "Arial";
}

// ---------------------------------------------------------------------------
// Fallback @font-face CSS generation
// ---------------------------------------------------------------------------

/**
 * Generate a fallback @font-face CSS declaration.
 *
 * Produces CSS like:
 *   @font-face {
 *     font-family: '__Inter_a3b2c1 Fallback';
 *     src: local("Arial");
 *     ascent-override: 96.83%;
 *     descent-override: 24.15%;
 *     line-gap-override: 0.00%;
 *     size-adjust: 107.64%;
 *   }
 */
export async function generateFallbackFontFace(
  metrics: FontMetrics,
  hashedFamily: string,
  fallbackBase?: "Arial" | "Times New Roman",
): Promise<FallbackFontResult | undefined> {
  if (!metrics.xWidthAvg || !metrics.unitsPerEm) return undefined;

  const values = await calculateSizeAdjustValues(metrics, fallbackBase);
  const fallbackFamily = `${hashedFamily} Fallback`;

  const css = `@font-face {
  font-family: '${fallbackFamily}';
  src: local("${values.fallbackFont}");
  ascent-override: ${values.ascentOverride}%;
  descent-override: ${values.descentOverride}%;
  line-gap-override: ${values.lineGapOverride}%;
  size-adjust: ${values.sizeAdjust}%;
}`;

  return { css, fallbackFamily, fallbackFont: values.fallbackFont };
}

// ---------------------------------------------------------------------------
// Google font metrics lookup
// ---------------------------------------------------------------------------

/**
 * Look up precalculated metrics for a Google Font by family name.
 *
 * Uses @capsizecss/metrics which contains data for 1900+ Google Fonts.
 * Returns undefined if the font isn't in the database.
 */
export async function getGoogleFontMetrics(fontFamily: string): Promise<FontMetrics | undefined> {
  // Import dynamically — this is build-time only, never bundled
  const { entireMetricsCollection } = await import("@capsizecss/metrics/entireMetricsCollection");
  // The collection's per-font types are overly specific; cast through unknown
  // to treat it as a simple string-keyed record.
  const collection = entireMetricsCollection as unknown as Record<string, {
    ascent: number;
    descent: number;
    lineGap: number;
    unitsPerEm: number;
    xWidthAvg: number;
    category?: string;
  } | undefined>;

  // Convert family name to camelCase key (same as Next.js formatName)
  const key = fontFamily
    .replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) =>
      index === 0 ? word.toLowerCase() : word.toUpperCase(),
    )
    .replace(/\s+/g, "");

  const entry = collection[key];
  if (!entry) return undefined;

  return {
    ascent: entry.ascent,
    descent: entry.descent,
    lineGap: entry.lineGap,
    unitsPerEm: entry.unitsPerEm,
    xWidthAvg: entry.xWidthAvg,
    category: entry.category as FontMetrics["category"],
  };
}

// ---------------------------------------------------------------------------
// Local font metrics extraction
// ---------------------------------------------------------------------------

/**
 * Characters used to calculate average width, weighted by letter frequency.
 * Same string as Next.js (packages/font/src/local/get-fallback-metrics-from-font-file.ts).
 */
const AVG_CHARACTERS = "aaabcdeeeefghiijklmnnoopqrrssttuvwxyz      ";

/** Minimal font interface matching the subset of fontkitten's Font we use. */
interface FontkitFont {
  ascent: number;
  descent: number;
  lineGap: number;
  unitsPerEm: number;
  glyphsForString(s: string): Array<{ codePoints: number[]; advanceWidth: number }>;
  hasGlyphForCodePoint(cp: number): boolean;
}

/**
 * Extract font metrics from a font file buffer using fontkitten.
 *
 * Matches Next.js behavior: reads ascent, descent, lineGap, unitsPerEm from
 * the font's OS/2 table, then calculates xWidthAvg using a letter-frequency-
 * weighted string.
 */
export async function getLocalFontMetrics(
  fontBuffer: Buffer,
): Promise<FontMetrics | undefined> {
  // Dynamic import — fontkitten is pure JS (no native bindings), build-time only
  let create: (buf: Buffer) => FontkitFont;
  try {
    const mod = await import("fontkitten");
    create = mod.create as (buf: Buffer) => FontkitFont;
  } catch {
    return undefined;
  }

  try {
    const font = create(fontBuffer);
    const xWidthAvg = calcAverageWidth(font);

    return {
      ascent: font.ascent,
      descent: font.descent,
      lineGap: font.lineGap,
      unitsPerEm: font.unitsPerEm,
      xWidthAvg: xWidthAvg ?? 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * Calculate the average character width using letter-frequency weighting.
 * Same algorithm as Next.js (packages/font/src/local/get-fallback-metrics-from-font-file.ts).
 */
function calcAverageWidth(font: FontkitFont): number | undefined {
  try {
    const glyphs = font.glyphsForString(AVG_CHARACTERS);
    const hasAllChars = glyphs
      .flatMap((glyph) => glyph.codePoints)
      .every((codePoint) => font.hasGlyphForCodePoint(codePoint));

    if (!hasAllChars) return undefined;

    const widths = glyphs.map((glyph) => glyph.advanceWidth);
    const totalWidth = widths.reduce((sum, width) => sum + width, 0);
    return totalWidth / widths.length;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Font-family hashing
// ---------------------------------------------------------------------------

/**
 * Generate a hashed font-family name from CSS content.
 *
 * Matches Next.js: sha1(css).hex().slice(0, 6).
 * Result: `__Inter_a3b2c1`
 */
export function hashFontFamily(family: string, css: string): string {
  const hash = createHash("sha1").update(css).digest("hex").slice(0, 6);
  return `__${family.replace(/\s+/g, "_")}_${hash}`;
}

/**
 * Generate hashed class names from a font-family hash.
 *
 * Matches Next.js css-loader getLocalIdent:
 *   className -> `__className_<hash>`
 *   variable  -> `__variable_<hash>`
 */
export function hashClassNames(css: string): { className: string; variable: string } {
  const hash = createHash("sha1").update(css).digest("hex").slice(0, 6);
  return {
    className: `__className_${hash}`,
    variable: `__variable_${hash}`,
  };
}

// ---------------------------------------------------------------------------
// Pick font file for fallback generation (local fonts with multiple sources)
// ---------------------------------------------------------------------------

/**
 * Pick the font file closest to normal weight (400) and normal style.
 * Same algorithm as Next.js (packages/font/src/local/pick-font-file-for-fallback-generation.ts).
 */
export function pickFontFileForFallbackGeneration<
  T extends { weight?: string; style?: string },
>(fontFiles: T[]): T {
  if (fontFiles.length === 0) {
    throw new Error("pickFontFileForFallbackGeneration: fontFiles must not be empty");
  }
  const NORMAL_WEIGHT = 400;

  function getDistanceFromNormalWeight(weight?: string): number {
    if (!weight) return 0;
    const parts = weight.trim().split(/ +/).map((w) =>
      w === "normal" ? NORMAL_WEIGHT : w === "bold" ? 700 : Number(w),
    );
    const [first, second] = parts;
    if (Number.isNaN(first)) return 0;
    if (second === undefined || Number.isNaN(second)) return first - NORMAL_WEIGHT;

    // Variable font range
    if (first <= NORMAL_WEIGHT && second >= NORMAL_WEIGHT) return 0;
    const d1 = first - NORMAL_WEIGHT;
    const d2 = second - NORMAL_WEIGHT;
    return Math.abs(d1) < Math.abs(d2) ? d1 : d2;
  }

  return fontFiles.reduce((best, current) => {
    if (!best) return current;
    const bestDist = getDistanceFromNormalWeight(best.weight);
    const currDist = getDistanceFromNormalWeight(current.weight);

    if (bestDist === currDist && (current.style === undefined || current.style === "normal")) {
      return current;
    }
    if (Math.abs(currDist) < Math.abs(bestDist)) return current;
    if (Math.abs(bestDist) === Math.abs(currDist) && currDist < bestDist) return current;
    return best;
  });
}

// ---------------------------------------------------------------------------
// Rewrite font-family in @font-face CSS
// ---------------------------------------------------------------------------

/**
 * Rewrite all font-family declarations in @font-face blocks to use a hashed name.
 *
 * Input:  `@font-face { font-family: 'Inter'; ... }`
 * Output: `@font-face { font-family: '__Inter_a3b2c1'; ... }`
 */
export function rewriteFontFamilyInCSS(css: string, originalFamily: string, hashedFamily: string): string {
  // Match font-family declarations inside @font-face blocks
  // Handle both quoted and unquoted variants
  const escaped = originalFamily.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(font-family\\s*:\\s*)(?:'${escaped}'|"${escaped}"|${escaped})`,
    "gi",
  );
  return css.replace(re, `$1'${hashedFamily}'`);
}
