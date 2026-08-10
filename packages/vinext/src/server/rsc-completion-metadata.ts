import { VINEXT_RSC_COMPLETION_METADATA_HEADER } from "./headers.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FRAME_ESCAPE_BYTE = 0xff;
const FOOTER_TAG_BYTE = 0x00;
const FOOTER_PREFIX_BYTES = 2;
const FOOTER_LENGTH_BYTES = 4;
const MAX_FOOTER_BYTES = 256;

export type RscCompletionMetadata = Readonly<{
  dynamicStaleTimeSeconds: number;
  serverStaleTimeSeconds?: number | null;
}>;

function isDynamicStaleTimeSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function encodeFooter(metadata: RscCompletionMetadata): Uint8Array {
  const payload = encoder.encode(JSON.stringify(metadata));
  const footer = new Uint8Array(payload.byteLength + FOOTER_LENGTH_BYTES + FOOTER_PREFIX_BYTES);
  if (footer.byteLength > MAX_FOOTER_BYTES) {
    throw new Error("RSC completion metadata exceeded its framing limit");
  }
  footer[0] = FRAME_ESCAPE_BYTE;
  footer[1] = FOOTER_TAG_BYTE;
  footer.set(payload, FOOTER_PREFIX_BYTES);
  new DataView(footer.buffer).setUint32(
    FOOTER_PREFIX_BYTES + payload.byteLength,
    payload.byteLength,
  );
  return footer;
}

function invalidFooter(): never {
  throw new Error("Invalid or truncated RSC completion metadata footer");
}

function parseFooterCandidate(candidate: Uint8Array): RscCompletionMetadata {
  if (candidate.byteLength > MAX_FOOTER_BYTES) {
    throw new Error("RSC completion metadata exceeded its framing limit");
  }
  if (
    candidate.byteLength < FOOTER_PREFIX_BYTES + FOOTER_LENGTH_BYTES ||
    candidate[0] !== FRAME_ESCAPE_BYTE ||
    candidate[1] !== FOOTER_TAG_BYTE
  ) {
    return invalidFooter();
  }

  const lengthOffset = candidate.byteLength - FOOTER_LENGTH_BYTES;
  const payloadLength = new DataView(
    candidate.buffer,
    candidate.byteOffset + lengthOffset,
    FOOTER_LENGTH_BYTES,
  ).getUint32(0);
  if (payloadLength !== lengthOffset - FOOTER_PREFIX_BYTES) return invalidFooter();

  try {
    const parsed: unknown = JSON.parse(
      decoder.decode(candidate.subarray(FOOTER_PREFIX_BYTES, lengthOffset)),
    );
    if (typeof parsed !== "object" || parsed === null) return invalidFooter();
    const fields = parsed as Record<string, unknown>;
    if (!isDynamicStaleTimeSeconds(fields.dynamicStaleTimeSeconds)) return invalidFooter();

    const hasServerStaleTime = Object.hasOwn(fields, "serverStaleTimeSeconds");
    const serverStaleTimeSeconds = fields.serverStaleTimeSeconds;
    if (
      hasServerStaleTime &&
      serverStaleTimeSeconds !== null &&
      !isDynamicStaleTimeSeconds(serverStaleTimeSeconds)
    ) {
      return invalidFooter();
    }
    return {
      dynamicStaleTimeSeconds: fields.dynamicStaleTimeSeconds,
      ...(hasServerStaleTime
        ? { serverStaleTimeSeconds: serverStaleTimeSeconds as number | null }
        : {}),
    };
  } catch {
    return invalidFooter();
  }
}

function escapeFlightChunk(chunk: Uint8Array): Uint8Array {
  const firstEscape = chunk.indexOf(FRAME_ESCAPE_BYTE);
  if (firstEscape === -1) return chunk;

  let escapeCount = 1;
  for (let index = firstEscape + 1; index < chunk.byteLength; index++) {
    if (chunk[index] === FRAME_ESCAPE_BYTE) escapeCount++;
  }
  const escaped = new Uint8Array(chunk.byteLength + escapeCount);
  escaped.set(chunk.subarray(0, firstEscape), 0);
  let output = firstEscape;
  for (let index = firstEscape; index < chunk.byteLength; index++) {
    const byte = chunk[index]!;
    escaped[output++] = byte;
    if (byte === FRAME_ESCAPE_BYTE) escaped[output++] = FRAME_ESCAPE_BYTE;
  }
  return escaped;
}

export function extractRscCompletionMetadata(buffer: ArrayBuffer): {
  buffer: ArrayBuffer;
  metadata?: RscCompletionMetadata;
} {
  const bytes = new Uint8Array(buffer);
  const firstEscape = bytes.indexOf(FRAME_ESCAPE_BYTE);
  if (firstEscape === -1) return { buffer };

  const decoded = new Uint8Array(bytes.byteLength);
  decoded.set(bytes.subarray(0, firstEscape));
  let output = firstEscape;
  for (let index = firstEscape; index < bytes.byteLength; index++) {
    const byte = bytes[index]!;
    if (byte !== FRAME_ESCAPE_BYTE) {
      decoded[output++] = byte;
      continue;
    }

    const escapedByte = bytes[++index];
    if (escapedByte === undefined) {
      throw new Error("Truncated RSC completion metadata escape sequence");
    }
    if (escapedByte === FRAME_ESCAPE_BYTE) {
      decoded[output++] = FRAME_ESCAPE_BYTE;
      continue;
    }
    if (escapedByte !== FOOTER_TAG_BYTE) {
      throw new Error("Invalid RSC completion metadata escape sequence");
    }

    return {
      buffer: decoded.buffer.slice(0, output),
      metadata: parseFooterCandidate(bytes.subarray(index - 1)),
    };
  }
  return { buffer: decoded.buffer.slice(0, output) };
}

export function appendRscCompletionMetadata(
  source: ReadableStream<Uint8Array>,
  getMetadata: () => RscCompletionMetadata | undefined,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (!next.done) {
        controller.enqueue(escapeFlightChunk(next.value));
        return;
      }
      const metadata = getMetadata();
      if (metadata) controller.enqueue(encodeFooter(metadata));
      controller.close();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export function stripRscCompletionMetadata(
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let escapePending = false;
  let footerCandidate: number[] | undefined;

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const output: number[] = [];
        const flushOutput = (): void => {
          if (output.length === 0) return;
          controller.enqueue(Uint8Array.from(output));
          output.length = 0;
        };

        let offset = 0;
        while (offset < chunk.byteLength) {
          if (footerCandidate) {
            footerCandidate.push(chunk[offset++]!);
            if (footerCandidate.length > MAX_FOOTER_BYTES) {
              controller.error(new Error("RSC completion metadata exceeded its framing limit"));
              return;
            }
            continue;
          }

          if (escapePending) {
            const escapedByte = chunk[offset++]!;
            escapePending = false;
            if (escapedByte === FRAME_ESCAPE_BYTE) {
              output.push(FRAME_ESCAPE_BYTE);
              continue;
            }
            if (escapedByte === FOOTER_TAG_BYTE) {
              footerCandidate = [FRAME_ESCAPE_BYTE, FOOTER_TAG_BYTE];
              continue;
            }
            controller.error(new Error("Invalid RSC completion metadata escape sequence"));
            return;
          }

          const escapeOffset = chunk.indexOf(FRAME_ESCAPE_BYTE, offset);
          if (escapeOffset === -1) {
            flushOutput();
            controller.enqueue(chunk.subarray(offset));
            return;
          }
          if (escapeOffset > offset) {
            flushOutput();
            controller.enqueue(chunk.subarray(offset, escapeOffset));
          }
          escapePending = true;
          offset = escapeOffset + 1;
        }
        flushOutput();
      },
      flush(controller) {
        if (escapePending) {
          controller.error(new Error("Truncated RSC completion metadata escape sequence"));
          return;
        }
        if (footerCandidate) {
          const candidate = Uint8Array.from(footerCandidate);
          try {
            parseFooterCandidate(candidate);
          } catch (error) {
            controller.error(error);
          }
        }
      },
    }),
  );
}

/** Remove vinext's internal completion footer before React reads a Flight response. */
export function stripRscCompletionMetadataResponse(response: Response): Response {
  if (response.headers.get(VINEXT_RSC_COMPLETION_METADATA_HEADER) !== "1" || !response.body) {
    return response;
  }
  return new Response(stripRscCompletionMetadata(response.body), {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}
