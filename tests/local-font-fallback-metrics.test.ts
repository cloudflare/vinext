import { describe, it, expect } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  getFallbackMetricsFromFontFile,
  pickFontFileForFallbackGeneration,
  readLocalFontMetrics,
} from "../packages/vinext/src/build/local-fonts/fallback-metrics.js";

// Expected values throughout this file were produced by Next.js's own
// implementation (fontkit + get-fallback-metrics-from-font-file.js from
// next@16.2.6) on the same bytes.

const FIXTURES = path.resolve(import.meta.dirname, "fixtures/app-basic");
// Noto Sans subset (TrueType).
const NOTO_SANS_TTF = new Uint8Array(fs.readFileSync(path.join(FIXTURES, "assets/noto-sans.ttf")));
// Next.js's test/e2e/next-font/app/fonts/roboto/roboto-400.woff2.
const ROBOTO_WOFF2 = new Uint8Array(
  fs.readFileSync(path.join(FIXTURES, "app/script-nonce/with-next-font/font.woff2")),
);

// ── Font file builders ───────────────────────────────────────

const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const u32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const ascii = (tag: string) => Array.from({ length: tag.length }, (_, i) => tag.charCodeAt(i));

/** Assemble an sfnt (TrueType) file from raw table bytes. */
function buildSfnt(tables: Record<string, number[]>): Uint8Array {
  const tags = Object.keys(tables).sort();
  const directory = [...u32(0x00010000), ...u16(tags.length), ...u16(0), ...u16(0), ...u16(0)];
  const data: number[] = [];
  let offset = 12 + tags.length * 16;
  for (const tag of tags) {
    const table = tables[tag];
    directory.push(...ascii(tag), ...u32(0), ...u32(offset), ...u32(table.length));
    const padding = (4 - (table.length % 4)) % 4;
    data.push(...table, ...Array<number>(padding).fill(0));
    offset += table.length + padding;
  }
  return new Uint8Array([...directory, ...data]);
}

type CmapSubtable = [platformId: number, encodingId: number, subtable: number[]];

function buildCmap(subtables: CmapSubtable[]): number[] {
  const records: number[] = [];
  const data: number[] = [];
  for (const [platformId, encodingId, subtable] of subtables) {
    records.push(
      ...u16(platformId),
      ...u16(encodingId),
      ...u32(4 + subtables.length * 8 + data.length),
    );
    data.push(...subtable);
  }
  return [...u16(0), ...u16(subtables.length), ...records, ...data];
}

/** cmap format 4 with one segment per code point. */
function cmapFormat4(glyphs: Map<number, number>): number[] {
  const segments = [...glyphs.entries()]
    .sort(([a], [b]) => a - b)
    .map(([codePoint, glyph]) => ({ codePoint, delta: (glyph - codePoint) & 0xffff }));
  segments.push({ codePoint: 0xffff, delta: 1 });
  return [
    ...u16(4),
    ...u16(16 + segments.length * 8),
    ...u16(0),
    ...u16(segments.length * 2),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...segments.flatMap((segment) => u16(segment.codePoint)),
    ...u16(0),
    ...segments.flatMap((segment) => u16(segment.codePoint)),
    ...segments.flatMap((segment) => u16(segment.delta)),
    ...segments.flatMap(() => u16(0)),
  ];
}

/** cmap format 12 with one group per code point. */
function cmapFormat12(glyphs: Map<number, number>): number[] {
  return [
    ...u16(12),
    ...u16(0),
    ...u32(16 + glyphs.size * 12),
    ...u32(0),
    ...u32(glyphs.size),
    ...[...glyphs.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([codePoint, glyph]) => [...u32(codePoint), ...u32(codePoint), ...u32(glyph)]),
  ];
}

/** cmap format 0 (single-byte encoding). */
function cmapFormat0(glyphs: Map<number, number>): number[] {
  return [
    ...u16(0),
    ...u16(262),
    ...u16(0),
    ...Array.from({ length: 256 }, (_, codePoint) => glyphs.get(codePoint) ?? 0),
  ];
}

function buildTestFont(options: {
  cmap: number[];
  advanceWidths: number[];
  unitsPerEm?: number;
  ascent?: number;
  descent?: number;
  lineGap?: number;
}): Uint8Array {
  const {
    cmap,
    advanceWidths,
    unitsPerEm = 1000,
    ascent = 900,
    descent = -250,
    lineGap = 50,
  } = options;
  return buildSfnt({
    cmap,
    head: [...Array<number>(18).fill(0), ...u16(unitsPerEm), ...Array<number>(34).fill(0)],
    hhea: [
      ...u32(0x00010000),
      ...u16(ascent),
      ...u16(descent),
      ...u16(lineGap),
      ...Array<number>(24).fill(0),
      ...u16(advanceWidths.length),
    ],
    hmtx: advanceWidths.flatMap((width) => [...u16(width), ...u16(0)]),
    // Not read by vinext. fontkit (Next.js) only measures glyphs of fonts
    // with outlines, so add 64 empty TrueType glyphs.
    maxp: [...u32(0x00010000), ...u16(64), ...Array<number>(26).fill(0)],
    loca: Array<number>(65 * 2).fill(0),
    glyf: [],
  });
}

/** Wrap an sfnt file as WOFF, zlib-compressing tables where that is smaller. */
function sfntToWoff(sfnt: Uint8Array): Uint8Array {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const numTables = view.getUint16(4);
  const tables = Array.from({ length: numTables }, (_, i) => {
    const record = 12 + i * 16;
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    const data = sfnt.subarray(offset, offset + length);
    const compressed = zlib.deflateSync(data);
    return {
      record: sfnt.subarray(record, record + 8),
      length,
      data: compressed.length < length ? compressed : data,
    };
  });
  const header = [...ascii("wOFF"), ...u32(view.getUint32(0)), ...u32(0), ...u16(numTables)];
  header.push(...Array<number>(44 - header.length).fill(0));
  const directory: number[] = [];
  const data: number[] = [];
  let offset = 44 + numTables * 20;
  for (const table of tables) {
    // tag, offset, compLength, origLength, origChecksum
    directory.push(...table.record.subarray(0, 4), ...u32(offset), ...u32(table.data.length));
    directory.push(...u32(table.length), ...table.record.subarray(4, 8));
    const padding = (4 - (table.data.length % 4)) % 4;
    data.push(...table.data, ...Array<number>(padding).fill(0));
    offset += table.data.length + padding;
  }
  return new Uint8Array([...header, ...directory, ...data]);
}

const WOFF2_TAG_INDEX: Record<string, number> = {
  cmap: 0,
  head: 1,
  hhea: 2,
  hmtx: 3,
  maxp: 4,
  glyf: 10,
  loca: 11,
};

function uintBase128(value: number): number[] {
  const bytes = [value & 0x7f];
  for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) {
    bytes.unshift((rest & 0x7f) | 0x80);
  }
  return bytes;
}

/**
 * Wrap an sfnt file as WOFF2 without glyf/loca transforms. With
 * `transformHmtx`, hmtx is stored in its transformed form (flags byte plus
 * advance widths, all left side bearings omitted).
 */
function sfntToWoff2(sfnt: Uint8Array, { transformHmtx = false } = {}): Uint8Array {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const numTables = view.getUint16(4);
  const directory: number[] = [];
  const data: number[] = [];
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    const tag = String.fromCharCode(...sfnt.subarray(record, record + 4));
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    const table = [...sfnt.subarray(offset, offset + length)];
    const index = WOFF2_TAG_INDEX[tag] ?? 63;
    if (tag === "hmtx" && transformHmtx) {
      const advanceWidths = table.filter((_, byte) => byte % 4 < 2);
      const transformed = [0x03, ...advanceWidths];
      directory.push(index | (1 << 6), ...uintBase128(length), ...uintBase128(transformed.length));
      data.push(...transformed);
      continue;
    }
    // glyf/loca need transform version 3 for "not transformed".
    const version = tag === "glyf" || tag === "loca" ? 3 : 0;
    directory.push(index | (version << 6), ...(index === 63 ? ascii(tag) : []));
    directory.push(...uintBase128(length));
    data.push(...table);
  }
  const compressed = zlib.brotliCompressSync(new Uint8Array(data));
  const header = [
    ...ascii("wOF2"),
    ...u32(view.getUint32(0)),
    ...u32(0),
    ...u16(numTables),
    ...u16(0),
    ...u32(sfnt.length),
    ...u32(compressed.length),
  ];
  header.push(...Array<number>(48 - header.length).fill(0));
  return new Uint8Array([...header, ...directory, ...compressed]);
}

// a–z and space map to glyphs 1–27; glyph widths are 400 + 10 × glyph id.
const LATIN_GLYPHS = new Map(
  "abcdefghijklmnopqrstuvwxyz "
    .split("")
    .map((character, index) => [character.charCodeAt(0), index + 1]),
);
const ADVANCE_WIDTHS = Array.from({ length: 28 }, (_, glyph) => 400 + glyph * 10);
const WITHOUT_Q = new Map([...LATIN_GLYPHS].filter(([codePoint]) => codePoint !== 0x71));
const FORMAT_4_FONT = buildTestFont({
  cmap: buildCmap([[3, 1, cmapFormat4(LATIN_GLYPHS)]]),
  advanceWidths: ADVANCE_WIDTHS,
});
const FORMAT_4_ARIAL = {
  ascentOverride: "75.30%",
  descentOverride: "20.92%",
  lineGapOverride: "4.18%",
  fallbackFont: "Arial",
  sizeAdjust: "119.51%",
};
// The font's own metrics, without size-adjust.
const UNADJUSTED_ARIAL = {
  ascentOverride: "90.00%",
  descentOverride: "25.00%",
  lineGapOverride: "5.00%",
  fallbackFont: "Arial",
  sizeAdjust: "100.00%",
};

function fallbackMetrics(bytes: Uint8Array, category: "serif" | "sans-serif" = "sans-serif") {
  return getFallbackMetricsFromFontFile(readLocalFontMetrics(bytes), category);
}

// ── Tests ────────────────────────────────────────────────────

describe("next/font/local fallback metrics", () => {
  const notoArial = {
    ascentOverride: "100.41%",
    descentOverride: "27.52%",
    lineGapOverride: "0.00%",
    fallbackFont: "Arial",
    sizeAdjust: "106.47%",
  };
  const notoTimes = {
    ascentOverride: "91.80%",
    descentOverride: "25.16%",
    lineGapOverride: "0.00%",
    fallbackFont: "Times New Roman",
    sizeAdjust: "116.45%",
  };

  it.each([
    ["TTF", NOTO_SANS_TTF],
    ["WOFF", sfntToWoff(NOTO_SANS_TTF)],
    ["WOFF2", sfntToWoff2(NOTO_SANS_TTF)],
  ])("matches Next.js for a %s font", (_format, bytes) => {
    expect(fallbackMetrics(bytes, "sans-serif")).toEqual(notoArial);
    expect(fallbackMetrics(bytes, "serif")).toEqual(notoTimes);
  });

  it("matches Next.js for a WOFF2 font with transformed glyf/loca", () => {
    // Ported from Next.js: test/e2e/next-font/index.test.ts ("Roboto multiple
    // weights and styles", which generates the fallback from roboto-400.woff2)
    // https://github.com/vercel/next.js/blob/canary/test/e2e/next-font/index.test.ts
    expect(fallbackMetrics(ROBOTO_WOFF2, "sans-serif")).toEqual({
      ascentOverride: "92.49%",
      descentOverride: "24.34%",
      lineGapOverride: "0.00%",
      fallbackFont: "Arial",
      sizeAdjust: "100.30%",
    });
    expect(fallbackMetrics(ROBOTO_WOFF2, "serif")).toEqual({
      ascentOverride: "84.57%",
      descentOverride: "22.25%",
      lineGapOverride: "0.00%",
      fallbackFont: "Times New Roman",
      sizeAdjust: "109.71%",
    });
  });

  it("defaults to the serif fallback like Next.js", () => {
    expect(getFallbackMetricsFromFontFile(readLocalFontMetrics(ROBOTO_WOFF2)).fallbackFont).toBe(
      "Times New Roman",
    );
  });

  it("reads cmap format 4 and hmtx advance widths", () => {
    expect(fallbackMetrics(FORMAT_4_FONT)).toEqual(FORMAT_4_ARIAL);
    expect(fallbackMetrics(FORMAT_4_FONT, "serif")).toEqual({
      ascentOverride: "68.85%",
      descentOverride: "19.12%",
      lineGapOverride: "3.82%",
      fallbackFont: "Times New Roman",
      sizeAdjust: "130.72%",
    });
  });

  it("reads cmap format 12 and reuses the last advance width past numberOfHMetrics", () => {
    const font = buildTestFont({
      cmap: buildCmap([[3, 10, cmapFormat12(LATIN_GLYPHS)]]),
      advanceWidths: ADVANCE_WIDTHS.slice(0, 20),
      unitsPerEm: 2048,
      ascent: 1900,
      descent: -500,
      lineGap: 0,
    });
    expect(fallbackMetrics(font)).toEqual({
      ascentOverride: "164.37%",
      descentOverride: "43.26%",
      lineGapOverride: "0.00%",
      fallbackFont: "Arial",
      sizeAdjust: "56.44%",
    });
  });

  it("picks cmap subtables in fontkit's order", () => {
    // fontkit prefers a Windows Unicode BMP (3,1) subtable over Unicode (0,3).
    const font = buildTestFont({
      cmap: buildCmap([
        [0, 3, cmapFormat4(WITHOUT_Q)],
        [3, 1, cmapFormat4(LATIN_GLYPHS)],
      ]),
      advanceWidths: ADVANCE_WIDTHS,
    });
    expect(fallbackMetrics(font)).toEqual(FORMAT_4_ARIAL);
  });

  it("falls back to a Mac Roman cmap subtable without a Unicode one", () => {
    const font = buildTestFont({
      cmap: buildCmap([[1, 0, cmapFormat0(LATIN_GLYPHS)]]),
      advanceWidths: ADVANCE_WIDTHS,
    });
    expect(fallbackMetrics(font)).toEqual(FORMAT_4_ARIAL);
  });

  it("skips size-adjust when the average width can't be measured", () => {
    // A character without a glyph.
    const missingGlyph = buildTestFont({
      cmap: buildCmap([[3, 1, cmapFormat4(WITHOUT_Q)]]),
      advanceWidths: ADVANCE_WIDTHS,
    });
    // fontkit can't map a symbol-only (3,0) cmap.
    const symbolOnly = buildTestFont({
      cmap: buildCmap([
        [
          3,
          0,
          cmapFormat4(new Map([...LATIN_GLYPHS].map(([code, glyph]) => [code + 0xf000, glyph]))),
        ],
      ]),
      advanceWidths: ADVANCE_WIDTHS,
    });
    expect(fallbackMetrics(missingGlyph)).toEqual(UNADJUSTED_ARIAL);
    expect(fallbackMetrics(symbolOnly)).toEqual(UNADJUSTED_ARIAL);
  });

  it("reads advance widths from a WOFF2-transformed hmtx table", () => {
    // fontkit misreads this (rare) transform; vinext decodes it, so the
    // result matches the untransformed font.
    expect(fallbackMetrics(sfntToWoff2(FORMAT_4_FONT))).toEqual(FORMAT_4_ARIAL);
    expect(fallbackMetrics(sfntToWoff2(FORMAT_4_FONT, { transformHmtx: true }))).toEqual(
      FORMAT_4_ARIAL,
    );
  });

  it("throws for files that aren't readable fonts", () => {
    expect(() => readLocalFontMetrics(new TextEncoder().encode("vinext-local-font"))).toThrow(
      "Unknown font format",
    );
    expect(() => readLocalFontMetrics(ROBOTO_WOFF2.subarray(0, 200))).toThrow();
    expect(() => readLocalFontMetrics(NOTO_SANS_TTF.subarray(0, 64))).toThrow();
  });
});

// Ported from Next.js: packages/font/src/local/pick-font-file-for-fallback-generation.test.ts
// https://github.com/vercel/next.js/blob/canary/packages/font/src/local/pick-font-file-for-fallback-generation.test.ts
describe("pickFontFileForFallbackGeneration", () => {
  it("picks the weight closest to 400", () => {
    expect(pickFontFileForFallbackGeneration([{ weight: "300" }, { weight: "600" }])).toEqual({
      weight: "300",
    });
    expect(pickFontFileForFallbackGeneration([{ weight: "200" }, { weight: "500" }])).toEqual({
      weight: "500",
    });
    expect(pickFontFileForFallbackGeneration([{ weight: "normal" }, { weight: "700" }])).toEqual({
      weight: "normal",
    });
    expect(pickFontFileForFallbackGeneration([{ weight: "bold" }, { weight: "900" }])).toEqual({
      weight: "bold",
    });
  });

  it("picks the thinner weight if both have the same distance to 400", () => {
    expect(pickFontFileForFallbackGeneration([{ weight: "300" }, { weight: "500" }])).toEqual({
      weight: "300",
    });
  });

  it("picks the variable range closest to 400", () => {
    expect(
      pickFontFileForFallbackGeneration([{ weight: "100 300" }, { weight: "600 900" }]),
    ).toEqual({ weight: "100 300" });
    expect(
      pickFontFileForFallbackGeneration([{ weight: "100 200" }, { weight: "500 800" }]),
    ).toEqual({ weight: "500 800" });
    expect(
      pickFontFileForFallbackGeneration([{ weight: "100 900" }, { weight: "300 399" }]),
    ).toEqual({ weight: "100 900" });
  });

  it("prefers normal style over italic", () => {
    expect(
      pickFontFileForFallbackGeneration([
        { weight: "400", style: "normal" },
        { weight: "400", style: "italic" },
      ]),
    ).toEqual({ weight: "400", style: "normal" });
    expect(
      pickFontFileForFallbackGeneration([
        { weight: "400", style: "italic" },
        { weight: "400", style: "normal" },
      ]),
    ).toEqual({ weight: "400", style: "normal" });
  });

  it("returns undefined for an invalid weight instead of throwing", () => {
    // Next.js throws `Invalid weight value in src array`; vinext keeps
    // accepting the call and just skips the adjusted fallback.
    expect(
      pickFontFileForFallbackGeneration([
        { path: "./font1.woff2", weight: "normal bold" },
        { path: "./font2.woff2", weight: "400 bold" },
        { path: "./font3.woff2", weight: "normal 700" },
        { path: "./font4.woff2", weight: "100 abc" },
      ]),
    ).toBeUndefined();
  });

  it("returns undefined for an empty list", () => {
    expect(pickFontFileForFallbackGeneration([])).toBeUndefined();
  });
});
