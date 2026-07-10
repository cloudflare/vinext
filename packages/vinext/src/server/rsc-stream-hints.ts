const REACT_FLIGHT_STYLESHEET_PRELOAD_HINT = /^([0-9a-f]*:HL\[.*?),"stylesheet"(\]|,)/;

// React Flight uses byte-length framing for text, ArrayBuffers, typed arrays,
// and DataViews. Their bodies are not newline-delimited and may contain any
// byte sequence, so they must pass through without text decoding or rewriting.
const LENGTH_PREFIXED_ROW_TAGS = new Set([
  "T",
  "A",
  "O",
  "o",
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

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Rewrite only a complete React Flight stylesheet hint row. */
function normalizeReactFlightHintLine(line: Uint8Array): Uint8Array {
  const text = decoder.decode(line);
  const normalized = text.replace(REACT_FLIGHT_STYLESHEET_PRELOAD_HINT, '$1,"style"$2');
  return normalized === text ? line : encoder.encode(normalized);
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

export function normalizeReactFlightPreloadHints(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let carry = new Uint8Array();
  let rawBytesRemaining = 0;

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
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
