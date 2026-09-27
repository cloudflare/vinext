const REACT_FLIGHT_STYLESHEET_PRELOAD_HINT = /^([0-9a-f]*:HL\[.*?),"stylesheet"(\]|,)/;
const STYLESHEET_TO_STYLE_JSON_PADDING = " ".repeat("stylesheet".length - "style".length);

// React Flight uses byte-length framing for text, ArrayBuffers, typed arrays,
// and DataViews. Their bodies are not newline-delimited and may contain any
// byte sequence, so they must pass through without text decoding or rewriting.
const LENGTH_PREFIXED_ROW_TAGS = new Set([
  "T",
  "A",
  "O",
  "o",
  // Byte streams use this tag in React 19.3 canary. Recognizing it here is
  // harmless with React 19.2, which never emits it.
  "b",
  "U",
  "S",
  "s",
  "L",
  "l",
  "G",
  "g",
  "M",
  "m",
  "V",
]);

// These are the newline-framed tags emitted by React 19.2. Keep this explicit:
// treating a future length-prefixed tag as newline-framed can desynchronize the
// stream if its body contains a newline.
const NEWLINE_PREFIXED_ROW_TAGS = new Set([
  "I",
  "H",
  "E",
  "N",
  "D",
  "J",
  "W",
  "R",
  "r",
  "X",
  "x",
  "C",
  "P",
  "#",
]);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Rewrite only a complete React Flight stylesheet hint row. */
function normalizeReactFlightHintLine(line: Uint8Array): Uint8Array {
  const text = decoder.decode(line);
  const normalized = text.replace(
    REACT_FLIGHT_STYLESHEET_PRELOAD_HINT,
    `$1,"style"${STYLESHEET_TO_STYLE_JSON_PADDING}$2`,
  );
  if (normalized === text) return line;

  const normalizedBytes = encoder.encode(normalized);
  // The padding is valid JSON whitespace and keeps this rewrite byte-length
  // preserving. If that invariant ever changes, leave the row untouched rather
  // than risking Flight framing desynchronization.
  return normalizedBytes.byteLength === line.byteLength ? normalizedBytes : line;
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  if (first.byteLength === 0) return second;
  const combined = new Uint8Array(first.byteLength + second.byteLength);
  combined.set(first);
  combined.set(second, first.byteLength);
  return combined;
}

// A plain loop is intentional: V8's Uint8Array.prototype.indexOf measured
// ~2.7x slower than this JIT-compiled loop for short Flight row scans.
function indexOfByte(bytes: Uint8Array, byte: number, from: number): number {
  for (let index = from; index < bytes.byteLength; index++) {
    if (bytes[index] === byte) return index;
  }
  return -1;
}

function parseHexBytes(bytes: Uint8Array, start: number, end: number): number | null {
  if (start === end) return null;

  let value = 0;
  for (let index = start; index < end; index++) {
    const byte = bytes[index];
    const digit = byte >= 48 && byte <= 57 ? byte - 48 : byte >= 97 && byte <= 102 ? byte - 87 : -1;
    if (digit === -1) return null;
    value = value * 16 + digit;
    if (!Number.isSafeInteger(value)) return null;
  }
  return value;
}

function isUntaggedJsonRowStart(byte: number): boolean {
  return (
    byte === 34 || // "
    byte === 45 || // -
    (byte >= 48 && byte <= 57) || // 0-9
    byte === 91 || // [
    byte === 102 || // f
    byte === 110 || // n
    byte === 116 || // t
    byte === 123 // {
  );
}

const COLON_BYTE = 58;
const COMMA_BYTE = 44;
const NEWLINE_BYTE = 10;
const HINT_TAG_BYTE = 72; // H
const LINK_HINT_CODE_BYTE = 76; // L

function createAsciiTagTable(tags: ReadonlySet<string>): Uint8Array {
  const table = new Uint8Array(128);
  for (const tag of tags) table[tag.charCodeAt(0)] = 1;
  return table;
}

// Byte lookup tables avoid allocating a one-character string per Flight row.
const LENGTH_PREFIXED_ROW_TAG_TABLE = createAsciiTagTable(LENGTH_PREFIXED_ROW_TAGS);
const NEWLINE_PREFIXED_ROW_TAG_TABLE = createAsciiTagTable(NEWLINE_PREFIXED_ROW_TAGS);

function isTagInTable(table: Uint8Array, byte: number): boolean {
  return byte < 128 && table[byte] === 1;
}

/**
 * Rewrite stylesheet preload hints in a React Flight stream.
 *
 * The rewrite is byte-length preserving, so this transform keeps React's
 * text chunk boundaries instead of re-emitting one chunk per Flight row. Every
 * downstream consumer (the tee, the SSR Flight client, the inline RSC embed,
 * RSC response wrappers) pays a per-chunk cost, and splitting per row
 * multiplied the chunk count roughly 8x on content-heavy pages. Chunks with
 * no stylesheet hint are forwarded as-is without copying; only rows whose
 * tag is `HL` are decoded and inspected. Length-prefixed bodies remain separate
 * so binary bytes do not force adjacent text through the embed's base64 path.
 */
export function normalizeReactFlightPreloadHints(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let carry: Uint8Array | null = null;
  let rawBytesRemaining = 0;
  let passThrough = false;

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (passThrough) {
          controller.enqueue(chunk);
          return;
        }

        const bytes = carry === null ? chunk : concatBytes(carry, chunk);
        carry = null;
        const byteLength = bytes.byteLength;
        // Offset of the first byte not yet known to belong to a complete row.
        let offset = 0;
        let emittedThrough = 0;
        // Copy-on-write output: only allocate when a hint row is rewritten.
        let output = bytes;
        let ownsOutput = bytes !== chunk;

        while (offset < byteLength) {
          if (rawBytesRemaining > 0) {
            const length = Math.min(rawBytesRemaining, byteLength - offset);
            if (offset > emittedThrough)
              controller.enqueue(output.subarray(emittedThrough, offset));
            controller.enqueue(bytes.subarray(offset, offset + length));
            rawBytesRemaining -= length;
            offset += length;
            emittedThrough = offset;
            continue;
          }

          const colon = indexOfByte(bytes, COLON_BYTE, offset);
          if (colon === -1 || colon + 1 === byteLength) break;

          const tagByte = bytes[colon + 1];
          if (isTagInTable(LENGTH_PREFIXED_ROW_TAG_TABLE, tagByte)) {
            const comma = indexOfByte(bytes, COMMA_BYTE, colon + 2);
            if (comma === -1) break;

            const length = parseHexBytes(bytes, colon + 2, comma);
            if (length != null) {
              rawBytesRemaining = length;
              offset = comma + 1;
              continue;
            }

            // A known length-prefixed tag with an invalid length is malformed
            // or belongs to a newer protocol. Preserve the remaining stream
            // byte-for-byte instead of guessing at row boundaries.
            passThrough = true;
            offset = byteLength;
            break;
          }

          if (
            !isTagInTable(NEWLINE_PREFIXED_ROW_TAG_TABLE, tagByte) &&
            !isUntaggedJsonRowStart(tagByte)
          ) {
            // Unknown tags may be length-prefixed in a newer React release.
            // Stop inspecting this stream so their bodies can never be
            // mistaken for newline-framed Flight rows.
            passThrough = true;
            offset = byteLength;
            break;
          }

          const newline = indexOfByte(bytes, NEWLINE_BYTE, offset);
          if (newline === -1) break;

          if (tagByte === HINT_TAG_BYTE && bytes[colon + 2] === LINK_HINT_CODE_BYTE) {
            const line = bytes.subarray(offset, newline + 1);
            const normalized = normalizeReactFlightHintLine(line);
            if (normalized !== line) {
              if (!ownsOutput) {
                output = bytes.slice();
                ownsOutput = true;
              }
              output.set(normalized, offset);
            }
          }
          offset = newline + 1;
        }

        if (offset < byteLength) carry = bytes.slice(offset);
        if (offset > emittedThrough) {
          controller.enqueue(
            offset === byteLength && emittedThrough === 0
              ? output
              : output.subarray(emittedThrough, offset),
          );
        }
      },
      flush(controller) {
        if (carry !== null && carry.byteLength > 0) {
          controller.enqueue(rawBytesRemaining > 0 ? carry : normalizeReactFlightHintLine(carry));
        }
      },
    }),
  );
}

export type RscRawRenderer = (model: unknown, options?: unknown) => ReadableStream<Uint8Array>;

export type RscRawPrerenderer = (
  model: unknown,
  options?: unknown,
) => Promise<{ prelude: ReadableStream<Uint8Array> }>;

export function createRscRenderer(render: RscRawRenderer): RscRawRenderer {
  return (model, options) => normalizeReactFlightPreloadHints(render(model, options));
}

export function createRscPrerenderer(prerender: RscRawPrerenderer): RscRawPrerenderer {
  return async (model, options) => {
    const result = await prerender(model, options);
    return { prelude: normalizeReactFlightPreloadHints(result.prelude) };
  };
}
