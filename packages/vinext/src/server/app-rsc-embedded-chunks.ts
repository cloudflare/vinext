export const RSC_EMBEDDED_BINARY_CHUNK = 3;

export type RscEmbeddedChunk = string | [typeof RSC_EMBEDDED_BINARY_CHUNK, string];

const BASE64_CHUNK_SIZE = 0x8000;
const textEncoder = new TextEncoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function decodeRscEmbeddedChunk(chunk: RscEmbeddedChunk): Uint8Array {
  if (typeof chunk === "string") {
    return textEncoder.encode(chunk);
  }
  return base64ToBytes(chunk[1]);
}

export function concatUint8Arrays(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.byteLength;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
