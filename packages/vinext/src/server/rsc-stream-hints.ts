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

function indexOfByte(bytes: Uint8Array, byte: number, from = 0): number {
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

export function normalizeReactFlightPreloadHints(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let carry = new Uint8Array();
  let rawBytesRemaining = 0;
  let passThrough = false;

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (passThrough) {
          controller.enqueue(chunk);
          return;
        }

        let bytes = concatBytes(carry, chunk);
        carry = new Uint8Array();

        while (bytes.byteLength > 0) {
          if (rawBytesRemaining > 0) {
            const length = Math.min(rawBytesRemaining, bytes.byteLength);
            controller.enqueue(bytes.slice(0, length));
            rawBytesRemaining -= length;
            bytes = bytes.subarray(length);
            continue;
          }

          const colon = indexOfByte(bytes, 58);
          if (colon === -1 || colon + 1 === bytes.byteLength) {
            carry = bytes.slice();
            return;
          }

          const tag = String.fromCharCode(bytes[colon + 1]);
          if (LENGTH_PREFIXED_ROW_TAGS.has(tag)) {
            const comma = indexOfByte(bytes, 44, colon + 2);
            if (comma === -1) {
              carry = bytes.slice();
              return;
            }

            const length = parseHexBytes(bytes, colon + 2, comma);
            if (length != null) {
              controller.enqueue(bytes.slice(0, comma + 1));
              rawBytesRemaining = length;
              bytes = bytes.subarray(comma + 1);
              continue;
            }

            // A known length-prefixed tag with an invalid length is malformed
            // or belongs to a newer protocol. Preserve the remaining stream
            // byte-for-byte instead of guessing at row boundaries.
            passThrough = true;
            controller.enqueue(bytes);
            return;
          }

          const tagByte = bytes[colon + 1];
          if (!NEWLINE_PREFIXED_ROW_TAGS.has(tag) && !isUntaggedJsonRowStart(tagByte)) {
            // Unknown tags may be length-prefixed in a newer React release.
            // Stop inspecting this stream so their bodies can never be
            // mistaken for newline-framed Flight rows.
            passThrough = true;
            controller.enqueue(bytes);
            return;
          }

          const newline = indexOfByte(bytes, 10);
          if (newline === -1) {
            carry = bytes.slice();
            return;
          }

          controller.enqueue(normalizeReactFlightHintLine(bytes.slice(0, newline + 1)));
          bytes = bytes.subarray(newline + 1);
        }
      },
      flush(controller) {
        if (carry.byteLength > 0) {
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
