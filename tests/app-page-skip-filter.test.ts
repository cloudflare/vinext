import { describe, expect, test } from "vite-plus/test";
import {
  collectRscReferenceIds,
  createSkipFilterTransform,
  filterRow0,
  parseRscReferenceString,
  wrapRscBytesForResponse,
} from "../packages/vinext/src/server/app-page-skip-filter.js";

describe("parseRscReferenceString", () => {
  test("accepts bare hex reference", () => {
    expect(parseRscReferenceString("$5")).toBe(5);
  });

  test("accepts $L lazy reference", () => {
    expect(parseRscReferenceString("$L5")).toBe(5);
  });

  test("accepts $@ thenable reference", () => {
    expect(parseRscReferenceString("$@5")).toBe(5);
  });

  test("accepts $F reference", () => {
    expect(parseRscReferenceString("$F5")).toBe(5);
  });

  test("accepts $Q map reference", () => {
    expect(parseRscReferenceString("$Q5")).toBe(5);
  });

  test("accepts $W set reference", () => {
    expect(parseRscReferenceString("$W5")).toBe(5);
  });

  test("accepts $K formdata reference", () => {
    expect(parseRscReferenceString("$K5")).toBe(5);
  });

  test("accepts $B blob reference", () => {
    expect(parseRscReferenceString("$B5")).toBe(5);
  });

  test("parses multi-digit hex ids", () => {
    expect(parseRscReferenceString("$Lff")).toBe(255);
  });

  test("rejects $$ literal-dollar escape", () => {
    expect(parseRscReferenceString("$$")).toBeNull();
  });

  test("rejects $undefined", () => {
    expect(parseRscReferenceString("$undefined")).toBeNull();
  });

  test("rejects $NaN", () => {
    expect(parseRscReferenceString("$NaN")).toBeNull();
  });

  test("rejects $Z error tag", () => {
    expect(parseRscReferenceString("$Z")).toBeNull();
  });

  test("rejects $-Infinity", () => {
    expect(parseRscReferenceString("$-Infinity")).toBeNull();
  });

  test("rejects $n bigint prefix", () => {
    expect(parseRscReferenceString("$n123")).toBeNull();
  });

  test("rejects unrelated strings", () => {
    expect(parseRscReferenceString("abc")).toBeNull();
  });

  test("rejects $L without digits", () => {
    expect(parseRscReferenceString("$L")).toBeNull();
  });

  test("rejects lone $", () => {
    expect(parseRscReferenceString("$")).toBeNull();
  });
});

describe("collectRscReferenceIds", () => {
  test("collects a single top-level reference", () => {
    const set = new Set<number>();
    collectRscReferenceIds("$L5", set);
    expect(set).toEqual(new Set([5]));
  });

  test("walks nested arrays", () => {
    const set = new Set<number>();
    collectRscReferenceIds(["$L1", ["$2", "plain", ["$@3"]]], set);
    expect(set).toEqual(new Set([1, 2, 3]));
  });

  test("walks nested objects", () => {
    const set = new Set<number>();
    collectRscReferenceIds({ a: "$L1", b: { c: "$2", d: "$3" } }, set);
    expect(set).toEqual(new Set([1, 2, 3]));
  });

  test("ignores $$ and other non-row tags", () => {
    const set = new Set<number>();
    collectRscReferenceIds(["$$", "$undefined", "$Z", "$NaN", "$T"], set);
    expect(set).toEqual(new Set());
  });

  test("dedupes duplicate references", () => {
    const set = new Set<number>();
    collectRscReferenceIds(["$L1", "$L1", { a: "$1" }], set);
    expect(set).toEqual(new Set([1]));
  });

  test("no-op on primitives", () => {
    const set = new Set<number>();
    collectRscReferenceIds(42, set);
    collectRscReferenceIds(true, set);
    collectRscReferenceIds(null, set);
    collectRscReferenceIds(undefined, set);
    expect(set).toEqual(new Set());
  });

  test("handles empty object and empty array", () => {
    const set = new Set<number>();
    collectRscReferenceIds({}, set);
    collectRscReferenceIds([], set);
    expect(set).toEqual(new Set());
  });
});

describe("filterRow0", () => {
  test("rewrites record by deleting skipped keys", () => {
    const row0 = {
      "slot:layout:/": "$L1",
      "slot:page": "$L2",
      __route: "route:/",
    };
    const { rewritten, liveIds } = filterRow0(row0, new Set(["slot:layout:/"]));
    expect(rewritten).toEqual({ "slot:page": "$L2", __route: "route:/" });
    expect(liveIds).toEqual(new Set([2]));
  });

  test("seeds liveIds from surviving keys only, not killed ones", () => {
    // Killed slot references row 1; kept slot references row 2.
    // Row 1 must not appear in liveIds — it was referenced only from a killed slot.
    const row0 = {
      "slot:layout:/": "$L1",
      "slot:page": "$L2",
      __route: "route:/",
    };
    const { liveIds } = filterRow0(row0, new Set(["slot:layout:/"]));
    expect(liveIds.has(1)).toBe(false);
    expect(liveIds.has(2)).toBe(true);
  });

  test("keeps a row referenced from both a kept and a killed key", () => {
    // Both slots reference row 2; killed slot also references row 1.
    // Row 2 is shared, so it stays live via the kept slot.
    const row0 = {
      "slot:layout:/": ["$L1", "$L2"],
      "slot:page": "$L2",
    };
    const { liveIds } = filterRow0(row0, new Set(["slot:layout:/"]));
    expect(liveIds).toEqual(new Set([2]));
  });

  test("empty skipIds returns a rewrite with full liveIds", () => {
    const row0 = {
      "slot:layout:/": "$L1",
      "slot:page": "$L2",
    };
    const { rewritten, liveIds } = filterRow0(row0, new Set());
    expect(rewritten).toEqual(row0);
    expect(liveIds).toEqual(new Set([1, 2]));
  });

  test("skipIds with no matching row-0 keys yields a no-op rewrite", () => {
    const row0 = {
      "slot:layout:/": "$L1",
      "slot:page": "$L2",
    };
    const { rewritten, liveIds } = filterRow0(row0, new Set(["slot:nonexistent"]));
    expect(rewritten).toEqual(row0);
    expect(liveIds).toEqual(new Set([1, 2]));
  });
});

function createRscStream(
  rows: string[],
  chunkBoundaries: readonly number[] = [],
): ReadableStream<Uint8Array> {
  const text = rows.join("\n") + "\n";
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const boundaries = [...chunkBoundaries, bytes.byteLength];
  return new ReadableStream({
    start(controller) {
      let start = 0;
      for (const end of boundaries) {
        controller.enqueue(bytes.slice(start, end));
        start = end;
      }
      controller.close();
    },
  });
}

async function collectStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe("createSkipFilterTransform", () => {
  test("empty skipIds passes through byte-equal", async () => {
    const rows = [
      `0:{"slot:layout:/":"$L1","slot:page":"$L2"}`,
      `1:["$","div",null,{"children":"root"}]`,
      `2:["$","p",null,{"children":"hello"}]`,
    ];
    const text = rows.join("\n") + "\n";

    const input = createRscStream(rows);
    const transform = createSkipFilterTransform(new Set());
    const output = await collectStreamText(input.pipeThrough(transform));
    expect(output).toBe(text);
  });

  test("single skipped key with one orphaned child drops the child row", async () => {
    const rows = [
      `1:["$","header",null,{"children":"layout"}]`,
      `2:["$","p",null,{"children":"page"}]`,
      `0:{"slot:layout:/":"$L1","slot:page":"$L2","__route":"route:/"}`,
    ];
    const input = createRscStream(rows);
    const transform = createSkipFilterTransform(new Set(["slot:layout:/"]));
    const output = await collectStreamText(input.pipeThrough(transform));
    expect(output).toContain(`2:["$","p",null,{"children":"page"}]`);
    expect(output).not.toContain(`1:["$","header"`);
    const expectedRow0 = `0:${JSON.stringify({ "slot:page": "$L2", __route: "route:/" })}`;
    expect(output).toContain(expectedRow0);
  });

  test("keeps a row referenced from both kept and killed slots", async () => {
    const rows = [
      `1:["$","header",null,{"children":"layout-only"}]`,
      `2:["$","span",null,{"children":"shared"}]`,
      `0:{"slot:layout:/":["$L1","$L2"],"slot:page":"$L2"}`,
    ];
    const input = createRscStream(rows);
    const transform = createSkipFilterTransform(new Set(["slot:layout:/"]));
    const output = await collectStreamText(input.pipeThrough(transform));
    expect(output).toContain(`2:["$","span",null,{"children":"shared"}]`);
    expect(output).not.toContain(`1:["$","header"`);
  });

  test("parses row 0 split across multiple chunks", async () => {
    const rows = [
      `1:["$","div",null,{"children":"layout"}]`,
      `2:["$","p",null,{"children":"page"}]`,
      `0:{"slot:layout:/":"$L1","slot:page":"$L2"}`,
    ];
    // Split the text at several arbitrary boundaries inside row 0.
    const fullText = rows.join("\n") + "\n";
    const encoder = new TextEncoder();
    const bytes = encoder.encode(fullText);
    // Pick boundaries inside the row 0 range.
    const row0Start = fullText.indexOf("0:");
    const row0End = fullText.length - 1;
    const boundaries = [
      row0Start + 3,
      row0Start + 10,
      row0Start + Math.floor((row0End - row0Start) / 2),
    ];

    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        let start = 0;
        for (const end of [...boundaries, bytes.byteLength]) {
          controller.enqueue(bytes.slice(start, end));
          start = end;
        }
        controller.close();
      },
    });

    const transform = createSkipFilterTransform(new Set(["slot:layout:/"]));
    const output = await collectStreamText(input.pipeThrough(transform));
    expect(output).toContain(`2:["$","p",null,{"children":"page"}]`);
    expect(output).not.toContain(`1:["$","div"`);
    const expectedRow0 = `0:${JSON.stringify({ "slot:page": "$L2" })}`;
    expect(output).toContain(expectedRow0);
  });

  test("parses a post-root row split across multiple chunks", async () => {
    // Row 0 arrives first (async case), then row 2 spans chunk boundaries.
    const rows = [`0:{"slot:page":"$L2"}`, `2:["$","section",null,{"children":"spanned"}]`];
    const fullText = rows.join("\n") + "\n";
    const encoder = new TextEncoder();
    const bytes = encoder.encode(fullText);
    const row2Start = fullText.indexOf("2:");
    const boundaries = [row2Start + 4, row2Start + 14];

    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        let start = 0;
        for (const end of [...boundaries, bytes.byteLength]) {
          controller.enqueue(bytes.slice(start, end));
          start = end;
        }
        controller.close();
      },
    });

    const transform = createSkipFilterTransform(new Set());
    const output = await collectStreamText(input.pipeThrough(transform));
    expect(output).toContain(`2:["$","section",null,{"children":"spanned"}]`);
    expect(output).toContain(`0:{"slot:page":"$L2"}`);
  });

  test("drops an orphaned sibling even when out of input order", async () => {
    // Row 0 references $L5 and $L2 only. Rows 3 and 4 are only referenced
    // from killed slot and must drop.
    const rows = [
      `5:["$","div",null,{"children":"kept-5"}]`,
      `3:["$","div",null,{"children":"orphan-3"}]`,
      `4:["$","div",null,{"children":"orphan-4"}]`,
      `2:["$","div",null,{"children":"kept-2"}]`,
      `0:{"slot:page":["$L5","$L2"],"slot:layout:/":["$L3","$L4"]}`,
    ];
    const input = createRscStream(rows);
    const transform = createSkipFilterTransform(new Set(["slot:layout:/"]));
    const output = await collectStreamText(input.pipeThrough(transform));
    expect(output).toContain(`5:["$","div",null,{"children":"kept-5"}]`);
    expect(output).toContain(`2:["$","div",null,{"children":"kept-2"}]`);
    expect(output).not.toContain("orphan-3");
    expect(output).not.toContain("orphan-4");
  });

  test("flush emits a trailing row that lacks a terminating newline", async () => {
    // Construct a byte sequence missing the final newline.
    const rows = [`1:["$","div",null,{"children":"layout"}]`, `0:{"slot:page":"$L1"}`];
    const text = rows.join("\n");
    const bytes = new TextEncoder().encode(text);
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const transform = createSkipFilterTransform(new Set());
    const output = await collectStreamText(input.pipeThrough(transform));
    expect(output).toContain(`1:["$","div",null,{"children":"layout"}]`);
    expect(output).toContain(`0:{"slot:page":"$L1"}`);
  });

  test("preserves bytes after row 0 in the same chunk when row 0 is mid-buffer", async () => {
    // Row 0 arrives first, immediately followed in the same chunk by a partial
    // row 1. The remaining bytes of row 1 arrive in a second chunk. With
    // non-empty skipIds the filter must carry over the residue across the
    // initial -> streaming phase transition. A regression here drops the
    // residue and loses row 1 entirely.
    const rows = [`0:{"slot:page":"$L1"}`, `1:["$","section",null,{"children":"after-root"}]`];
    const fullText = rows.join("\n") + "\n";
    const encoder = new TextEncoder();
    const bytes = encoder.encode(fullText);
    // Boundary inside row 1 so bytes after row 0 in chunk 1 are residue.
    const row1Start = fullText.indexOf("1:");
    const split = row1Start + 6;

    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });

    const transform = createSkipFilterTransform(new Set(["slot:layout:/"]));
    const output = await collectStreamText(input.pipeThrough(transform));
    expect(output).toContain(`0:{"slot:page":"$L1"}`);
    expect(output).toContain(`1:["$","section",null,{"children":"after-root"}]`);
  });

  test("passes through unrecognized rows that arrive before row 0", async () => {
    // Streaming phase passes unrecognized rows through verbatim. The initial
    // phase must do the same so a malformed line buffered before row 0 still
    // reaches the client. Otherwise a stray non-row-shaped line in front of
    // row 0 silently disappears.
    const rows = [
      `not-a-row-prefix-line`,
      `1:["$","div",null,{"children":"layout"}]`,
      `0:{"slot:page":"$L1"}`,
    ];
    const input = createRscStream(rows);
    const transform = createSkipFilterTransform(new Set(["slot:layout:/"]));
    const output = await collectStreamText(input.pipeThrough(transform));
    expect(output).toContain(`not-a-row-prefix-line`);
  });

  test("falls back to canonical passthrough when row 0 JSON cannot be parsed", async () => {
    const rows = [
      `1:["$","div",null,{"children":"before-root"}]`,
      `0:{"slot:page":"$L2"`,
      `2:["$","section",null,{"children":"after-root"}]`,
      `3:["$","footer",null,{"children":"tail"}]`,
    ];
    const input = createRscStream(rows);
    const transform = createSkipFilterTransform(new Set(["slot:layout:/"]));
    const output = await collectStreamText(input.pipeThrough(transform));

    expect(output).toBe(rows.join("\n") + "\n");
  });

  test("filters the same orphan on repeat runs (no shared state)", async () => {
    const rows = [
      `1:["$","div",null,{"children":"layout"}]`,
      `2:["$","p",null,{"children":"page"}]`,
      `0:{"slot:layout:/":"$L1","slot:page":"$L2"}`,
    ];
    const skip = new Set(["slot:layout:/"]);
    for (let i = 0; i < 2; i++) {
      const input = createRscStream(rows);
      const transform = createSkipFilterTransform(skip);
      const output = await collectStreamText(input.pipeThrough(transform));
      expect(output).toContain(`2:["$","p",null,{"children":"page"}]`);
      expect(output).not.toContain(`1:["$","div"`);
    }
  });
});

describe("wrapRscBytesForResponse", () => {
  test("empty skipIds returns the raw ArrayBuffer identity", () => {
    const bytes = new TextEncoder().encode("hello").buffer;
    const result = wrapRscBytesForResponse(bytes, new Set());
    expect(result).toBe(bytes);
  });

  test("non-empty skipIds returns a filtered stream", async () => {
    const rows = [
      `1:["$","header",null,{"children":"layout"}]`,
      `2:["$","p",null,{"children":"page"}]`,
      `0:{"slot:layout:/":"$L1","slot:page":"$L2"}`,
    ];
    const text = rows.join("\n") + "\n";
    const bytes = new TextEncoder().encode(text).buffer;

    const result = wrapRscBytesForResponse(bytes, new Set(["slot:layout:/"]));
    // The result is a BodyInit — wrap in Response to normalize.
    const response = new Response(result);
    const output = await response.text();
    expect(output).toContain(`2:["$","p",null,{"children":"page"}]`);
    expect(output).not.toContain(`1:["$","header"`);
  });
});
