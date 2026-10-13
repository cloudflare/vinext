/**
 * Minimal font file reader for `next/font/local`'s `adjustFontFallback`.
 *
 * Next.js reads local font files with fontkit, but its fallback metrics only
 * use a handful of values: `unitsPerEm` (`head`), `ascent`/`descent`/`lineGap`
 * (`hhea`), and the advance widths (`hmtx`) of the glyphs that `cmap` maps a
 * few Latin characters to. This reader decodes only those four tables from
 * TTF/OTF, WOFF (zlib) and WOFF2 (brotli) files using `node:zlib`, and mirrors
 * fontkit's cmap subtable selection and lookups so the generated fallback
 * metrics match Next.js exactly.
 */

import zlib from "node:zlib";

type TableTag = "cmap" | "head" | "hhea" | "hmtx";

type FontTable = {
  view: DataView;
  /** WOFF2 transformed table (only `hmtx` is read in transformed form). */
  transformed: boolean;
};

type FontTables = Partial<Record<TableTag, FontTable>>;

export type FontFile = {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
  /**
   * Glyph id for a code point, or 0 when the font has no glyph for it. Throws
   * when the font has no cmap subtable fontkit could use.
   */
  glyphForCodePoint(codePoint: number): number;
  /** Throws when the font has no `hmtx` table. */
  advanceWidth(glyph: number): number;
};

// WOFF2 known table tags, indexed by the low six bits of the table directory
// flags. Only the tables this reader needs, plus glyf/loca (whose transform
// flag has inverted meaning), have to be recognised.
const WOFF2_KNOWN_TAGS: Record<number, string> = {
  0: "cmap",
  1: "head",
  2: "hhea",
  3: "hmtx",
  10: "glyf",
  11: "loca",
};

// fontkit's `CmapProcessor` preference order for Unicode cmap subtables.
const UNICODE_CMAP_SUBTABLES = [
  [3, 10],
  [0, 6],
  [0, 4],
  [3, 1],
  [0, 3],
  [0, 2],
  [0, 1],
  [0, 0],
] as const;

// Without a Unicode subtable fontkit falls back to the last subtable whose
// legacy encoding it can map, which only happens for Macintosh (platform 1)
// subtables: by Mac language id (fontkit's `LANGUAGE_ENCODINGS`) or by
// encoding id (x-mac-roman, iso-8859-6, iso-8859-8, x-mac-greek,
// x-mac-cyrillic, x-mac-ce). For the ASCII characters Next.js measures, those
// encodings are the identity mapping.
const MAC_MAPPED_LANGUAGE_IDS = new Set([
  15, 17, 18, 24, 25, 26, 27, 28, 30, 37, 38, 39, 40, 143, 146,
]);
const MAC_MAPPED_ENCODING_IDS = new Set([0, 4, 5, 6, 7, 29]);

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function isNeededTable(tag: string): tag is TableTag {
  return tag === "cmap" || tag === "head" || tag === "hhea" || tag === "hmtx";
}

function createTable(bytes: Uint8Array, transformed = false): FontTable {
  return { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), transformed };
}

function readSfntTables(bytes: Uint8Array, view: DataView): FontTables {
  const tables: FontTables = {};
  const numTables = view.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    const tag = readTag(view, record);
    if (!isNeededTable(tag)) continue;
    const offset = view.getUint32(record + 8);
    tables[tag] = createTable(bytes.subarray(offset, offset + view.getUint32(record + 12)));
  }
  return tables;
}

function readWoffTables(bytes: Uint8Array, view: DataView): FontTables {
  const tables: FontTables = {};
  const numTables = view.getUint16(12);
  for (let i = 0; i < numTables; i++) {
    const record = 44 + i * 20;
    const tag = readTag(view, record);
    if (!isNeededTable(tag)) continue;
    const offset = view.getUint32(record + 4);
    const compLength = view.getUint32(record + 8);
    const data = bytes.subarray(offset, offset + compLength);
    tables[tag] = createTable(
      compLength < view.getUint32(record + 12) ? new Uint8Array(zlib.inflateSync(data)) : data,
    );
  }
  return tables;
}

function readWoff2Tables(bytes: Uint8Array, view: DataView): FontTables {
  if (readTag(view, 4) === "ttcf") throw new Error("WOFF2 font collections are not supported");
  const numTables = view.getUint16(12);
  const totalCompressedSize = view.getUint32(20);
  let position = 48;

  const readUIntBase128 = (): number => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = view.getUint8(position++);
      if (i === 0 && byte === 0x80) throw new Error("Invalid UIntBase128 value");
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("Invalid UIntBase128 value");
  };

  const entries: Array<{ tag: string; length: number; transformed: boolean }> = [];
  for (let i = 0; i < numTables; i++) {
    const flags = view.getUint8(position++);
    let tag = WOFF2_KNOWN_TAGS[flags & 0x3f] ?? "";
    if ((flags & 0x3f) === 0x3f) {
      tag = readTag(view, position);
      position += 4;
    }
    const transformVersion = (flags >> 6) & 3;
    const origLength = readUIntBase128();
    // glyf/loca use transform version 0 for "transformed"; every other table
    // uses a non-zero version (same rule as fontkit).
    const transformed =
      tag === "glyf" || tag === "loca" ? transformVersion === 0 : transformVersion !== 0;
    entries.push({ tag, length: transformed ? readUIntBase128() : origLength, transformed });
  }

  const data = new Uint8Array(
    zlib.brotliDecompressSync(bytes.subarray(position, position + totalCompressedSize)),
  );
  const tables: FontTables = {};
  let offset = 0;
  for (const entry of entries) {
    if (isNeededTable(entry.tag)) {
      tables[entry.tag] = createTable(
        data.subarray(offset, offset + entry.length),
        entry.transformed,
      );
    }
    offset += entry.length;
  }
  return tables;
}

function readTables(bytes: Uint8Array): FontTables {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = readTag(view, 0);
  if (signature === "wOF2") return readWoff2Tables(bytes, view);
  if (signature === "wOFF") return readWoffTables(bytes, view);
  if (signature === "\0\x01\0\0" || signature === "true" || signature === "OTTO") {
    return readSfntTables(bytes, view);
  }
  throw new Error("Unknown font format");
}

function readCmapLanguage(view: DataView, offset: number): number {
  const format = view.getUint16(offset);
  if (format === 0 || format === 2 || format === 4 || format === 6) {
    return view.getUint16(offset + 4);
  }
  if (format === 8 || format === 10 || format === 12 || format === 13) {
    return view.getUint32(offset + 8);
  }
  if (format === 14) return Number.NaN;
  throw new Error(`Unknown cmap format ${format}`);
}

/** fontkit's cmap subtable selection: returns the chosen subtable's offset. */
function findCmapSubtable(view: DataView): number {
  const records: Array<{ platformId: number; encodingId: number; offset: number }> = [];
  const numTables = view.getUint16(2);
  for (let i = 0; i < numTables; i++) {
    const record = 4 + i * 8;
    records.push({
      platformId: view.getUint16(record),
      encodingId: view.getUint16(record + 2),
      offset: view.getUint32(record + 4),
    });
  }

  for (const [platformId, encodingId] of UNICODE_CMAP_SUBTABLES) {
    const record = records.find(
      (candidate) => candidate.platformId === platformId && candidate.encodingId === encodingId,
    );
    if (record) return record.offset;
  }

  let fallback: number | undefined;
  for (const record of records) {
    // fontkit has no encoding table for platforms above 3 and throws here.
    if (record.platformId > 3) throw new Error("Unsupported cmap platform");
    const languageId = readCmapLanguage(view, record.offset) - 1;
    if (
      record.platformId === 1 &&
      (MAC_MAPPED_LANGUAGE_IDS.has(languageId) || MAC_MAPPED_ENCODING_IDS.has(record.encodingId))
    ) {
      fallback = record.offset;
    }
  }
  if (fallback === undefined) throw new Error("Could not find a supported cmap table");
  return fallback;
}

/** fontkit's `CmapProcessor.lookup` for the subtable formats it implements. */
function createCmapLookup(view: DataView): (codePoint: number) => number {
  const base = findCmapSubtable(view);
  const format = view.getUint16(base);

  if (format === 0) {
    return (codePoint) => (codePoint < 256 ? view.getUint8(base + 6 + codePoint) : 0);
  }

  if (format === 4) {
    const segCount = view.getUint16(base + 6) / 2;
    const endCodes = base + 14;
    const startCodes = endCodes + segCount * 2 + 2;
    const idDeltas = startCodes + segCount * 2;
    const idRangeOffsets = idDeltas + segCount * 2;
    return (codePoint) => {
      let low = 0;
      let high = segCount - 1;
      while (low <= high) {
        const segment = (low + high) >> 1;
        const startCode = view.getUint16(startCodes + segment * 2);
        if (codePoint < startCode) {
          high = segment - 1;
        } else if (codePoint > view.getUint16(endCodes + segment * 2)) {
          low = segment + 1;
        } else {
          const rangeOffsetPosition = idRangeOffsets + segment * 2;
          const rangeOffset = view.getUint16(rangeOffsetPosition);
          const idDelta = view.getUint16(idDeltas + segment * 2);
          if (rangeOffset === 0) return (codePoint + idDelta) & 0xffff;
          const glyph = view.getUint16(
            rangeOffsetPosition + rangeOffset + (codePoint - startCode) * 2,
          );
          return glyph === 0 ? 0 : (glyph + idDelta) & 0xffff;
        }
      }
      return 0;
    };
  }

  if (format === 6) {
    const firstCode = view.getUint16(base + 6);
    const entryCount = view.getUint16(base + 8);
    return (codePoint) => {
      const index = codePoint - firstCode;
      return index >= 0 && index < entryCount ? view.getUint16(base + 10 + index * 2) : 0;
    };
  }

  if (format === 12 || format === 13) {
    const groupCount = view.getUint32(base + 12);
    return (codePoint) => {
      let low = 0;
      let high = groupCount - 1;
      while (low <= high) {
        const group = (low + high) >> 1;
        const record = base + 16 + group * 12;
        const startCharCode = view.getUint32(record);
        if (codePoint < startCharCode) {
          high = group - 1;
        } else if (codePoint > view.getUint32(record + 4)) {
          low = group + 1;
        } else {
          const glyph = view.getUint32(record + 8);
          return format === 12 ? glyph + (codePoint - startCharCode) : glyph;
        }
      }
      return 0;
    };
  }

  throw new Error(`Unsupported cmap format ${format}`);
}

/**
 * Read the metrics Next.js's `getFallbackMetricsFromFontFile` needs from a
 * font file. Throws when the file isn't a supported, well-formed font (where
 * fontkit would also fail to load it).
 */
export function readFontFile(bytes: Uint8Array): FontFile {
  const { cmap, head, hhea, hmtx } = readTables(bytes);
  if (!head || !hhea) throw new Error("Missing head or hhea table");

  const unitsPerEm = head.view.getUint16(18);
  if (unitsPerEm === 0) throw new Error("Invalid unitsPerEm");
  const numberOfHMetrics = hhea.view.getUint16(34);

  let lookup: ((codePoint: number) => number) | undefined;
  return {
    unitsPerEm,
    ascent: hhea.view.getInt16(4),
    descent: hhea.view.getInt16(6),
    lineGap: hhea.view.getInt16(8),
    glyphForCodePoint(codePoint) {
      if (!cmap) throw new Error("Missing cmap table");
      lookup ??= createCmapLookup(cmap.view);
      return lookup(codePoint);
    },
    advanceWidth(glyph) {
      if (!hmtx) throw new Error("Missing hmtx table");
      // Glyphs past numberOfHMetrics share the last advance width.
      if (numberOfHMetrics === 0) return 0;
      const index = Math.min(glyph, numberOfHMetrics - 1);
      // A WOFF2-transformed hmtx starts with a flags byte followed by the
      // advance widths; fontkit doesn't decode this (rare) transform, so this
      // is the one place the reader is more correct than Next.js.
      return hmtx.transformed ? hmtx.view.getUint16(1 + index * 2) : hmtx.view.getUint16(index * 4);
    },
  };
}
