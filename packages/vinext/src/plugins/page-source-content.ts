import { decodeVlqSegment } from "../server/dev-stack-sourcemap.js";
import { serverExportRewrittenRanges } from "./strip-server-exports.js";

type Segment = { generated: number; original: number };

/**
 * The source of a Pages Router page as a client sourcemap should show it, with
 * the code `stripServerExports` removes from the browser build blanked.
 * `compiled` is the page compiled to JavaScript and `mappings` its sourcemap
 * back to `source`. Blanking keeps every newline, so the original line and
 * column of every kept character stay the same.
 */
export function blankServerExportSource(
  source: string,
  compiled: string,
  mappings: string,
): string {
  const ranges = serverExportRewrittenRanges(compiled);
  if (!ranges) return source;

  const segments = decodeSegments(mappings, lineStarts(compiled), lineStarts(source));
  // Blank the whole module if the map cannot place the code.
  if (segments.length === 0) return blank(source, [{ start: 0, end: source.length }]);
  const originals = [...new Set(segments.map((segment) => segment.original))].sort(
    (left, right) => left - right,
  );
  // A mapped token runs until the next mapped original position.
  const originalEnd = (original: number): number => {
    let low = 0;
    let high = originals.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (originals[middle]! <= original) low = middle + 1;
      else high = middle;
    }
    return originals[low] ?? source.length;
  };

  const blanked = ranges.map(({ start, end }) => {
    // The segments covering [start, end): the last one at or before `start`
    // through every one before `end`. The range ends at the first segment at
    // or after `end`. Taking the extremes of all of them keeps the blanked
    // range covering the code even where compiling reorders it.
    let first = 0;
    let firstGenerated = 0;
    let after = source.length;
    let afterGenerated = compiled.length;
    const inside: number[] = [];
    for (const segment of segments) {
      if (segment.generated <= start) {
        first = segment.original;
        firstGenerated = segment.generated;
      } else if (segment.generated < end) {
        inside.push(segment.original);
      } else {
        after = segment.original;
        afterGenerated = segment.generated;
        break;
      }
    }
    // Kept code between those segments and the range, such as `live` before a
    // removed `, helper = ...` declarator or ` } from ` after a removed
    // specifier, stays when the source matches it.
    const keptBefore = compiled.slice(firstGenerated, start);
    const keptAfter = compiled.slice(end, afterGenerated);
    const keptBeforeEnd = source.startsWith(keptBefore, first) ? first + keptBefore.length : null;
    const keptAfterStart = source.endsWith(keptAfter, after) ? after - keptAfter.length : after;
    // A mapped token runs until the next mapped position or the kept code.
    const tokenEnd = (original: number) =>
      original < keptAfterStart
        ? Math.min(originalEnd(original), keptAfterStart)
        : originalEnd(original);
    let blankStart = keptBeforeEnd ?? first;
    let blankEnd = Math.max(keptAfterStart, keptBeforeEnd ?? tokenEnd(first));
    for (const original of inside) {
      blankStart = Math.min(blankStart, original);
      blankEnd = Math.max(blankEnd, tokenEnd(original));
    }
    return { start: blankStart, end: blankEnd };
  });
  return blank(source, blanked);
}

function blank(source: string, ranges: Array<{ start: number; end: number }>): string {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  let result = "";
  let cursor = 0;
  for (const { start, end } of sorted) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    result += source.slice(cursor, from) + source.slice(from, end).replace(/[^\r\n]/g, " ");
    cursor = end;
  }
  return result + source.slice(cursor);
}

function lineStarts(code: string): number[] {
  const starts = [0];
  for (let index = code.indexOf("\n"); index !== -1; index = code.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

// Mapped segments of the first source, sorted by generated offset.
function decodeSegments(
  mappings: string,
  generatedLines: number[],
  originalLines: number[],
): Segment[] {
  const segments: Segment[] = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  mappings.split(";").forEach((line, generatedLine) => {
    let generatedColumn = 0;
    for (const encoded of line.split(",")) {
      if (!encoded) continue;
      const decoded = decodeVlqSegment(encoded);
      if (decoded.length === 0) continue;
      generatedColumn += decoded[0]!;
      if (decoded.length < 4) continue;
      sourceIndex += decoded[1]!;
      originalLine += decoded[2]!;
      originalColumn += decoded[3]!;
      const generatedStart = generatedLines[generatedLine];
      const originalStart = originalLines[originalLine];
      if (sourceIndex !== 0 || generatedStart === undefined || originalStart === undefined) {
        continue;
      }
      segments.push({
        generated: generatedStart + generatedColumn,
        original: originalStart + originalColumn,
      });
    }
  });
  return segments.sort((left, right) => left.generated - right.generated);
}
