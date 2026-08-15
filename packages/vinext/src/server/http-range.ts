import { parseHttpDate } from "./http-date.js";

export type ByteRange =
  | { kind: "ignore" }
  | { kind: "unsatisfiable" }
  | { kind: "range"; start: number; end: number };

/**
 * Parse a single bytes range. Unsupported range units, malformed values, and
 * multipart ranges are ignored, which RFC 9110 permits servers to do.
 */
export function parseByteRange(value: string | undefined, size: number): ByteRange {
  if (!value || value.slice(0, 6).toLowerCase() !== "bytes=") return { kind: "ignore" };

  const spec = value.slice("bytes=".length).trim();
  if (spec.includes(",")) return { kind: "ignore" };

  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (!match[1] && !match[2])) return { kind: "ignore" };

  if (!match[1]) {
    const suffixLength = parseDecimalInteger(match[2]);
    if (suffixLength === "overflow") {
      if (size === 0) return { kind: "unsatisfiable" };
      return { kind: "range", start: 0, end: size - 1 };
    }
    if (suffixLength === 0 || size === 0) return { kind: "unsatisfiable" };
    return {
      kind: "range",
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    };
  }

  const start = parseDecimalInteger(match[1]);
  const requestedEnd = match[2] ? parseDecimalInteger(match[2]) : size - 1;
  // The wire grammar has no JavaScript-safe-integer limit. A start beyond
  // that limit is necessarily beyond any file size Node can address, while an
  // overflowing end still denotes the remainder of the representation.
  if (start === "overflow") return { kind: "unsatisfiable" };
  if (requestedEnd === "overflow") {
    if (start >= size) return { kind: "unsatisfiable" };
    return { kind: "range", start, end: size - 1 };
  }
  if (start >= size || requestedEnd < start) return { kind: "unsatisfiable" };

  return {
    kind: "range",
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}

/**
 * If-Range requires strong entity-tag comparison. Date validators are matched
 * at HTTP-date (whole-second) precision because filesystem mtimes are finer,
 * and allow a range when the representation has not changed since that date.
 * Vinext's static ETags are currently weak, so its emitted Last-Modified value
 * is the validator that can enable a range response on a later request.
 */
export function ifRangeAllowsRange(
  value: string | undefined,
  etag: string,
  mtimeMs: number,
): boolean {
  if (!value) return true;

  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("W/")) {
    return !trimmed.startsWith("W/") && !etag.startsWith("W/") && trimmed === etag;
  }

  const timestamp = parseHttpDate(trimmed);
  return Number.isFinite(timestamp) && Math.floor(mtimeMs / 1000) * 1000 <= timestamp;
}

function parseDecimalInteger(value: string): number | "overflow" {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : "overflow";
}
