// Compact fallback metrics derived from Next.js
// `next/dist/server/capsize-font-metrics.json`.
//
// The tuple shape is:
// [serifFlag, ascent, descent, lineGap, unitsPerEm, xWidthAvg]

import { escapeCSSString } from "vinext/shims/font-utils";
import rawFallbackMetrics from "./fallback-metrics-data.json" with { type: "json" };

type AdjustFontFallback = {
  fallbackFont: string;
  ascentOverride: string;
  descentOverride: string;
  lineGapOverride: string;
  sizeAdjust: string;
};

const EXPECTED_METRIC_LENGTH = 6;
const fallbackMetrics: Record<string, number[]> = rawFallbackMetrics;

function formatName(value: string): string {
  return value
    .replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) =>
      index === 0 ? word.toLowerCase() : word.toUpperCase(),
    )
    .replace(/\s+/g, "");
}

function formatOverrideValue(value: number): string {
  return Math.abs(value * 100).toFixed(2);
}

export function getFallbackFontOverrideMetrics(fontFamily: string): AdjustFontFallback | undefined {
  const metric = fallbackMetrics[formatName(fontFamily)];
  if (!metric || metric.length !== EXPECTED_METRIC_LENGTH) return undefined;

  const [serifFlag, ascent, descent, lineGap, unitsPerEm, xWidthAvg] = metric;
  if (unitsPerEm === 0) return undefined;

  const fallbackFont = serifFlag === 1 ? "Times New Roman" : "Arial";
  const fallbackMetric = fallbackMetrics[formatName(fallbackFont)];
  if (!fallbackMetric || fallbackMetric.length !== EXPECTED_METRIC_LENGTH) return undefined;

  const [, , , , fallbackUnitsPerEm, fallbackXWidthAvg] = fallbackMetric;
  if (fallbackUnitsPerEm === 0) return undefined;

  const mainFontAvgWidth = xWidthAvg / unitsPerEm;
  const fallbackFontAvgWidth = fallbackXWidthAvg / fallbackUnitsPerEm;
  const sizeAdjust =
    xWidthAvg && fallbackFontAvgWidth ? mainFontAvgWidth / fallbackFontAvgWidth : 1;

  return {
    fallbackFont,
    ascentOverride: `${formatOverrideValue(ascent / (unitsPerEm * sizeAdjust))}%`,
    descentOverride: `${formatOverrideValue(descent / (unitsPerEm * sizeAdjust))}%`,
    lineGapOverride: `${formatOverrideValue(lineGap / (unitsPerEm * sizeAdjust))}%`,
    sizeAdjust: `${formatOverrideValue(sizeAdjust)}%`,
  };
}

// The fallback family name pattern '{family} Fallback' must match the name
// constructed in createFontLoader() in shims/font-google-base.ts. Keep both
// sites in sync to prevent silent fallback mismatches.
export function buildFallbackFontFace(family: string, metrics: AdjustFontFallback): string {
  const fallbackFamily = `'${escapeCSSString(family)} Fallback'`;
  return `@font-face {
  font-family: ${fallbackFamily};
  src: local("${escapeCSSString(metrics.fallbackFont)}");
  ascent-override: ${metrics.ascentOverride};
  descent-override: ${metrics.descentOverride};
  line-gap-override: ${metrics.lineGapOverride};
  size-adjust: ${metrics.sizeAdjust};
}\n`;
}
