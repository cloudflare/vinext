import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  calculateSizeAdjustValues,
  generateFallbackFontFace,
  getGoogleFontMetrics,
  getLocalFontMetrics,
  hashFontFamily,
  hashClassNames,
  pickFontFileForFallbackGeneration,
  rewriteFontFamilyInCSS,
  type FontMetrics,
} from "../packages/vinext/src/font-metrics.js";

// ── calculateSizeAdjustValues ───────────────────────────────

describe("calculateSizeAdjustValues", () => {
  const INTER_METRICS: FontMetrics = {
    ascent: 2048,
    descent: -512,
    lineGap: 0,
    unitsPerEm: 2048,
    xWidthAvg: 930,
    category: "sans-serif",
  };

  it("returns size-adjust values for a sans-serif font against Arial", async () => {
    const values = await calculateSizeAdjustValues(INTER_METRICS);
    expect(values.fallbackFont).toBe("Arial");
    expect(parseFloat(values.sizeAdjust)).toBeGreaterThan(0);
    expect(parseFloat(values.ascentOverride)).toBeGreaterThan(0);
    expect(parseFloat(values.descentOverride)).toBeGreaterThan(0);
    expect(values.lineGapOverride).toBe("0.00");
  });

  it("uses Times New Roman for serif fonts", async () => {
    const serifMetrics: FontMetrics = { ...INTER_METRICS, category: "serif" };
    const values = await calculateSizeAdjustValues(serifMetrics);
    expect(values.fallbackFont).toBe("Times New Roman");
  });

  it("respects explicit fallback base override", async () => {
    const values = await calculateSizeAdjustValues(INTER_METRICS, "Times New Roman");
    expect(values.fallbackFont).toBe("Times New Roman");
  });

  it("defaults to Arial for non-serif categories", async () => {
    for (const category of ["sans-serif", "monospace", "display", "handwriting"] as const) {
      const metrics: FontMetrics = { ...INTER_METRICS, category };
      const values = await calculateSizeAdjustValues(metrics);
      expect(values.fallbackFont).toBe("Arial");
    }
  });

  it("defaults to Arial when category is undefined", async () => {
    const metrics: FontMetrics = { ...INTER_METRICS, category: undefined };
    const values = await calculateSizeAdjustValues(metrics);
    expect(values.fallbackFont).toBe("Arial");
  });

  it("returns sizeAdjust 100 when xWidthAvg is 0", async () => {
    const metrics: FontMetrics = { ...INTER_METRICS, xWidthAvg: 0 };
    const values = await calculateSizeAdjustValues(metrics);
    expect(values.sizeAdjust).toBe("100.00");
  });

  it("produces deterministic output for same input", async () => {
    const a = await calculateSizeAdjustValues(INTER_METRICS);
    const b = await calculateSizeAdjustValues(INTER_METRICS);
    expect(a).toEqual(b);
  });
});

// ── generateFallbackFontFace ────────────────────────────────

describe("generateFallbackFontFace", () => {
  const metrics: FontMetrics = {
    ascent: 2048,
    descent: -512,
    lineGap: 0,
    unitsPerEm: 2048,
    xWidthAvg: 930,
    category: "sans-serif",
  };

  it("generates valid @font-face CSS", async () => {
    const result = await generateFallbackFontFace(metrics, "__Inter_a3b2c1");
    expect(result).toBeDefined();
    if (!result) throw new Error("expected result");
    expect(result.css).toContain("@font-face");
    expect(result.css).toContain("font-family: '__Inter_a3b2c1 Fallback'");
    expect(result.css).toContain('src: local("Arial")');
    expect(result.css).toContain("ascent-override:");
    expect(result.css).toContain("descent-override:");
    expect(result.css).toContain("line-gap-override:");
    expect(result.css).toContain("size-adjust:");
  });

  it("returns fallbackFamily with Fallback suffix", async () => {
    const result = await generateFallbackFontFace(metrics, "__Inter_a3b2c1");
    expect(result).toBeDefined();
    if (!result) throw new Error("expected result");
    expect(result.fallbackFamily).toBe("__Inter_a3b2c1 Fallback");
  });

  it("returns the system font used as base", async () => {
    const result = await generateFallbackFontFace(metrics, "__Inter_a3b2c1");
    expect(result).toBeDefined();
    if (!result) throw new Error("expected result");
    expect(result.fallbackFont).toBe("Arial");
  });

  it("uses Times New Roman when specified", async () => {
    const result = await generateFallbackFontFace(metrics, "__Merriweather_x1y2z3", "Times New Roman");
    expect(result).toBeDefined();
    if (!result) throw new Error("expected result");
    expect(result.css).toContain('src: local("Times New Roman")');
    expect(result.fallbackFont).toBe("Times New Roman");
  });

  it("returns undefined when xWidthAvg is 0", async () => {
    const noWidth: FontMetrics = { ...metrics, xWidthAvg: 0 };
    const result = await generateFallbackFontFace(noWidth, "__Test_000000");
    expect(result).toBeUndefined();
  });

  it("returns undefined when unitsPerEm is 0", async () => {
    const noUpm: FontMetrics = { ...metrics, unitsPerEm: 0 };
    const result = await generateFallbackFontFace(noUpm, "__Test_000000");
    expect(result).toBeUndefined();
  });

  it("produces parseable percentage values", async () => {
    const result = await generateFallbackFontFace(metrics, "__Test_abc123");
    expect(result).toBeDefined();
    if (!result) throw new Error("expected result");
    const percentages = result.css.match(/(\d+\.\d+)%/g);
    expect(percentages).toHaveLength(4); // ascent, descent, lineGap, sizeAdjust
    for (const pct of percentages ?? []) {
      const num = parseFloat(pct);
      expect(Number.isFinite(num)).toBe(true);
    }
  });
});

// ── hashFontFamily ──────────────────────────────────────────

describe("hashFontFamily", () => {
  it("produces __family_hash format", () => {
    const result = hashFontFamily("Inter", "some-css-content");
    expect(result).toMatch(/^__Inter_[0-9a-f]{6}$/);
  });

  it("replaces spaces with underscores in family name", () => {
    const result = hashFontFamily("Roboto Mono", "some-css");
    expect(result).toMatch(/^__Roboto_Mono_[0-9a-f]{6}$/);
  });

  it("produces different hashes for different CSS content", () => {
    const a = hashFontFamily("Inter", "css-a");
    const b = hashFontFamily("Inter", "css-b");
    expect(a).not.toBe(b);
  });

  it("produces identical hashes for identical input", () => {
    const a = hashFontFamily("Inter", "same-css");
    const b = hashFontFamily("Inter", "same-css");
    expect(a).toBe(b);
  });

  it("uses sha1 hex slice(0,6)", () => {
    const result = hashFontFamily("Test", "content");
    const hash = result.split("_").pop();
    expect(hash).toMatch(/^[0-9a-f]{6}$/);
  });
});

// ── hashClassNames ──────────────────────────────────────────

describe("hashClassNames", () => {
  it("produces __className_hash and __variable_hash", () => {
    const result = hashClassNames("some-css-content");
    expect(result.className).toMatch(/^__className_[0-9a-f]{6}$/);
    expect(result.variable).toMatch(/^__variable_[0-9a-f]{6}$/);
  });

  it("produces identical output for same input", () => {
    const a = hashClassNames("same");
    const b = hashClassNames("same");
    expect(a).toEqual(b);
  });

  it("produces different output for different input", () => {
    const a = hashClassNames("css-a");
    const b = hashClassNames("css-b");
    expect(a.className).not.toBe(b.className);
    expect(a.variable).not.toBe(b.variable);
  });

  it("className and variable share the same hash", () => {
    const result = hashClassNames("test-css");
    const classHash = result.className.replace("__className_", "");
    const varHash = result.variable.replace("__variable_", "");
    expect(classHash).toBe(varHash);
  });
});

// ── getGoogleFontMetrics ────────────────────────────────────

describe("getGoogleFontMetrics", () => {
  it("returns metrics for Inter", async () => {
    const metrics = await getGoogleFontMetrics("Inter");
    expect(metrics).toBeDefined();
    if (!metrics) throw new Error("expected metrics");
    expect(metrics.ascent).toBeGreaterThan(0);
    expect(metrics.descent).toBeLessThan(0);
    expect(metrics.unitsPerEm).toBeGreaterThan(0);
    expect(metrics.xWidthAvg).toBeGreaterThan(0);
  });

  it("returns metrics for Roboto Mono", async () => {
    const metrics = await getGoogleFontMetrics("Roboto Mono");
    expect(metrics).toBeDefined();
    if (!metrics) throw new Error("expected metrics");
    expect(metrics.category).toBe("monospace");
  });

  it("returns sans-serif category for Inter", async () => {
    const metrics = await getGoogleFontMetrics("Inter");
    expect(metrics).toBeDefined();
    if (!metrics) throw new Error("expected metrics");
    expect(metrics.category).toBe("sans-serif");
  });

  it("returns undefined for unknown font", async () => {
    const metrics = await getGoogleFontMetrics("Not A Real Font XYZ123");
    expect(metrics).toBeUndefined();
  });

  it("returns metrics for Merriweather (serif)", async () => {
    const metrics = await getGoogleFontMetrics("Merriweather");
    expect(metrics).toBeDefined();
    if (!metrics) throw new Error("expected metrics");
    expect(metrics.category).toBe("serif");
  });

  it("returns complete metric properties", async () => {
    const metrics = await getGoogleFontMetrics("Open Sans");
    expect(metrics).toBeDefined();
    if (!metrics) throw new Error("expected metrics");
    expect(typeof metrics.ascent).toBe("number");
    expect(typeof metrics.descent).toBe("number");
    expect(typeof metrics.lineGap).toBe("number");
    expect(typeof metrics.unitsPerEm).toBe("number");
    expect(typeof metrics.xWidthAvg).toBe("number");
  });
});

// ── pickFontFileForFallbackGeneration ───────────────────────

describe("pickFontFileForFallbackGeneration", () => {
  it("picks normal weight (400) file when available", () => {
    const files = [
      { path: "bold.woff2", weight: "700" },
      { path: "regular.woff2", weight: "400" },
      { path: "light.woff2", weight: "300" },
    ];
    const picked = pickFontFileForFallbackGeneration(files);
    expect(picked.path).toBe("regular.woff2");
  });

  it("picks file closest to 400 when exact match unavailable", () => {
    const files = [
      { path: "bold.woff2", weight: "700" },
      { path: "medium.woff2", weight: "500" },
    ];
    const picked = pickFontFileForFallbackGeneration(files);
    expect(picked.path).toBe("medium.woff2");
  });

  it("picks variable font range that includes 400", () => {
    const files = [
      { path: "bold-only.woff2", weight: "700 900" },
      { path: "variable.woff2", weight: "100 900" },
    ];
    const picked = pickFontFileForFallbackGeneration(files);
    expect(picked.path).toBe("variable.woff2");
  });

  it("prefers normal style over italic at same weight distance", () => {
    const files = [
      { path: "italic.woff2", weight: "400", style: "italic" },
      { path: "normal.woff2", weight: "400", style: "normal" },
    ];
    const picked = pickFontFileForFallbackGeneration(files);
    expect(picked.path).toBe("normal.woff2");
  });

  it("handles 'normal' keyword as weight 400", () => {
    const files = [
      { path: "bold.woff2", weight: "bold" },
      { path: "normal.woff2", weight: "normal" },
    ];
    const picked = pickFontFileForFallbackGeneration(files);
    expect(picked.path).toBe("normal.woff2");
  });

  it("handles 'bold' keyword as weight 700", () => {
    const files = [
      { path: "thin.woff2", weight: "100" },
      { path: "bold.woff2", weight: "bold" },
    ];
    const picked = pickFontFileForFallbackGeneration(files);
    // Both equidistant from 400; prefer lighter (negative distance)
    expect(picked.path).toBe("thin.woff2");
  });

  it("returns a file when no weights specified", () => {
    const files = [
      { path: "a.woff2", weight: undefined, style: undefined },
      { path: "b.woff2", weight: undefined, style: undefined },
    ];
    const picked = pickFontFileForFallbackGeneration(files);
    expect(picked).toBeDefined();
  });

  it("returns single file when only one provided", () => {
    const files = [{ path: "only.woff2", weight: "900" }];
    const picked = pickFontFileForFallbackGeneration(files);
    expect(picked.path).toBe("only.woff2");
  });

  it("throws on empty array", () => {
    expect(() => pickFontFileForFallbackGeneration([])).toThrow();
  });
});

// ── rewriteFontFamilyInCSS ──────────────────────────────────

describe("rewriteFontFamilyInCSS", () => {
  it("rewrites single-quoted font-family", () => {
    const css = `@font-face { font-family: 'Inter'; src: url(inter.woff2); }`;
    const result = rewriteFontFamilyInCSS(css, "Inter", "__Inter_a3b2c1");
    expect(result).toContain("font-family: '__Inter_a3b2c1'");
  });

  it("rewrites double-quoted font-family", () => {
    const css = `@font-face { font-family: "Inter"; src: url(inter.woff2); }`;
    const result = rewriteFontFamilyInCSS(css, "Inter", "__Inter_a3b2c1");
    expect(result).toContain("font-family: '__Inter_a3b2c1'");
  });

  it("rewrites unquoted font-family", () => {
    const css = `@font-face { font-family: Inter; src: url(inter.woff2); }`;
    const result = rewriteFontFamilyInCSS(css, "Inter", "__Inter_a3b2c1");
    expect(result).toContain("font-family: '__Inter_a3b2c1'");
  });

  it("rewrites multiple @font-face blocks", () => {
    const css = [
      `@font-face { font-family: 'Inter'; font-weight: 400; }`,
      `@font-face { font-family: 'Inter'; font-weight: 700; }`,
    ].join("\n");
    const result = rewriteFontFamilyInCSS(css, "Inter", "__Inter_abc123");
    const matches = result.match(/__Inter_abc123/g);
    expect(matches).toHaveLength(2);
  });

  it("does not rewrite unrelated font-family declarations", () => {
    const css = `@font-face { font-family: 'Roboto'; } @font-face { font-family: 'Inter'; }`;
    const result = rewriteFontFamilyInCSS(css, "Inter", "__Inter_abc123");
    expect(result).toContain("font-family: 'Roboto'");
    expect(result).toContain("font-family: '__Inter_abc123'");
  });

  it("handles font-family with space in name", () => {
    const css = `@font-face { font-family: 'Open Sans'; }`;
    const result = rewriteFontFamilyInCSS(css, "Open Sans", "__Open_Sans_abc123");
    expect(result).toContain("font-family: '__Open_Sans_abc123'");
  });

  it("is case-insensitive for font-family property", () => {
    const css = `@font-face { Font-Family: 'Inter'; }`;
    const result = rewriteFontFamilyInCSS(css, "Inter", "__Inter_abc123");
    expect(result).toContain("'__Inter_abc123'");
  });

  it("handles regex-special characters in font name", () => {
    const css = `@font-face { font-family: 'Font (Bold)'; }`;
    const result = rewriteFontFamilyInCSS(css, "Font (Bold)", "__Font_Bold_abc123");
    expect(result).toContain("font-family: '__Font_Bold_abc123'");
  });
});

// ── Integration: Google font end-to-end ─────────────────────

describe("Google font metrics integration", () => {
  it("generates a complete fallback @font-face for Inter", async () => {
    const metrics = await getGoogleFontMetrics("Inter");
    expect(metrics).toBeDefined();
    if (!metrics) throw new Error("expected metrics");

    const hashedFamily = hashFontFamily("Inter", "test-css");
    const fallback = await generateFallbackFontFace(metrics, hashedFamily);
    expect(fallback).toBeDefined();
    if (!fallback) throw new Error("expected fallback");
    expect(fallback.css).toContain("@font-face");
    expect(fallback.css).toContain(`font-family: '${hashedFamily} Fallback'`);
    expect(fallback.css).toContain('src: local("Arial")');
    expect(fallback.fallbackFamily).toBe(`${hashedFamily} Fallback`);
  });

  it("generates a serif fallback for Merriweather", async () => {
    const metrics = await getGoogleFontMetrics("Merriweather");
    expect(metrics).toBeDefined();
    if (!metrics) throw new Error("expected metrics");

    const hashedFamily = hashFontFamily("Merriweather", "test-css");
    const fallback = await generateFallbackFontFace(metrics, hashedFamily);
    expect(fallback).toBeDefined();
    if (!fallback) throw new Error("expected fallback");
    expect(fallback.css).toContain('src: local("Times New Roman")');
  });

  it("hashClassNames produces valid CSS class names", () => {
    const classes = hashClassNames("font-css-content");
    expect(classes.className).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]*$/);
    expect(classes.variable).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]*$/);
  });
});

// ── getLocalFontMetrics ─────────────────────────────────────

describe("getLocalFontMetrics", () => {
  const FONT_PATH = resolve(import.meta.dirname, "fixtures/fonts/inter-latin-400.woff2");

  it("extracts metrics from a real .woff2 font file", async () => {
    const buf = await readFile(FONT_PATH);
    const metrics = await getLocalFontMetrics(buf);
    expect(metrics).toBeDefined();
    if (!metrics) throw new Error("expected metrics");

    expect(metrics.unitsPerEm).toBe(2048);
    expect(metrics.ascent).toBeGreaterThan(0);
    expect(metrics.descent).toBeLessThan(0);
    expect(typeof metrics.lineGap).toBe("number");
    expect(metrics.xWidthAvg).toBeGreaterThan(0);
  });

  it("returns correct ascent/descent signs", async () => {
    const buf = await readFile(FONT_PATH);
    const metrics = await getLocalFontMetrics(buf);
    if (!metrics) throw new Error("expected metrics");

    // Inter: ascent is positive, descent is negative (standard OS/2 table convention)
    expect(metrics.ascent).toBeGreaterThan(0);
    expect(metrics.descent).toBeLessThan(0);
  });

  it("metrics can be used with calculateSizeAdjustValues", async () => {
    const buf = await readFile(FONT_PATH);
    const metrics = await getLocalFontMetrics(buf);
    if (!metrics) throw new Error("expected metrics");

    const adjustValues = await calculateSizeAdjustValues({
      ...metrics,
      category: "sans-serif",
    });
    expect(parseFloat(adjustValues.sizeAdjust)).toBeGreaterThan(0);
    expect(adjustValues.fallbackFont).toBe("Arial");
  });

  it("metrics can be used with generateFallbackFontFace", async () => {
    const buf = await readFile(FONT_PATH);
    const metrics = await getLocalFontMetrics(buf);
    if (!metrics) throw new Error("expected metrics");

    const hashedFamily = hashFontFamily("test-local", "some-css-content");
    const fallback = await generateFallbackFontFace(
      { ...metrics, category: "sans-serif" },
      hashedFamily,
    );
    expect(fallback).toBeDefined();
    if (!fallback) throw new Error("expected fallback");

    expect(fallback.css).toContain("size-adjust:");
    expect(fallback.css).toContain("ascent-override:");
    expect(fallback.css).toContain("descent-override:");
    expect(fallback.css).toContain(`${hashedFamily} Fallback`);
  });

  it("returns undefined for invalid/corrupt buffer", async () => {
    const corruptBuf = Buffer.from("not a font file");
    const metrics = await getLocalFontMetrics(corruptBuf);
    expect(metrics).toBeUndefined();
  });

  it("returns undefined for empty buffer", async () => {
    const emptyBuf = Buffer.alloc(0);
    const metrics = await getLocalFontMetrics(emptyBuf);
    expect(metrics).toBeUndefined();
  });
});
