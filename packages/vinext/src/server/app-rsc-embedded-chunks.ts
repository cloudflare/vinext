export const RSC_EMBEDDED_BINARY_CHUNK = 3;
/** Text that `escapeRscDataBlockText` changed, as read from its data block. */
export const RSC_EMBEDDED_ESCAPED_TEXT_CHUNK = 4;

export type RscEmbeddedChunk =
  | string
  | [typeof RSC_EMBEDDED_BINARY_CHUNK, string]
  | [typeof RSC_EMBEDDED_ESCAPED_TEXT_CHUNK, string];

const BASE64_CHUNK_SIZE = 0x8000;
const textEncoder = new TextEncoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

// Flight text is embedded as the raw content of a non-executed <script> data
// block. The HTML parser ends or re-modes that content at "</script",
// "<script" and "<!--" (ASCII case-insensitive), turns CR and CRLF into LF and
// NUL into U+FFFD, and Flight's text rows are length-prefixed in bytes. Each of
// those characters becomes U+E000 (private use) plus a digit; U+E000 itself is
// escaped too, so the browser can restore the exact text.
// https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements
const DATA_BLOCK_ESCAPE = "\uE000";
const DATA_BLOCK_ESCAPED_CHARS = "\0\r<\uE000";
const DATA_BLOCK_UNSAFE_RE = /[\0\r\uE000]|<(?=!--|\/?script)/i;
const DATA_BLOCK_UNSAFE_CHARS_RE = /[\0\r\uE000]|<(?=!--|\/?script)/gi;
const DATA_BLOCK_ESCAPE_RE = /\uE000([0-3])/g;

function escapeDataBlockChar(char: string): string {
  return DATA_BLOCK_ESCAPE + DATA_BLOCK_ESCAPED_CHARS.indexOf(char);
}

function unescapeDataBlockChar(_escape: string, index: string): string {
  return DATA_BLOCK_ESCAPED_CHARS[Number(index)];
}

/** Returns `text` itself when it needs no escaping. */
export function escapeRscDataBlockText(text: string): string {
  if (!DATA_BLOCK_UNSAFE_RE.test(text)) return text;
  return text.replace(DATA_BLOCK_UNSAFE_CHARS_RE, escapeDataBlockChar);
}

export function unescapeRscDataBlockText(text: string): string {
  return text.replace(DATA_BLOCK_ESCAPE_RE, unescapeDataBlockChar);
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
  if (chunk[0] === RSC_EMBEDDED_ESCAPED_TEXT_CHUNK) {
    return textEncoder.encode(unescapeRscDataBlockText(chunk[1]));
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
