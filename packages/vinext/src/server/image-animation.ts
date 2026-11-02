/**
 * Animated image detection for the image optimization endpoint.
 *
 * Next.js serves an animated GIF, PNG (APNG) or WebP unoptimized rather than
 * flattening it to its first frame. This is a port of the `is-animated`
 * package Next.js compiles in (next/dist/compiled/is-animated, MIT, Józef
 * Sokołowski), which `imageOptimizer` in
 * packages/next/src/server/image-optimizer.ts calls on the upstream bytes.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP_FOURCC = [0x57, 0x45, 0x42, 0x50]; // "WEBP"
const WEBP_ANIM_CHUNK = [0x41, 0x4e, 0x49, 0x4d]; // "ANIM"

function bytesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** Length of a run of GIF data sub-blocks, including its zero terminator. */
function gifDataBlocksLength(bytes: Uint8Array, offset: number): number {
  let length = 0;
  while ((bytes[offset + length] ?? 0) !== 0) {
    length += bytes[offset + length] + 1;
  }
  return length + 1;
}

function isAnimatedGif(bytes: Uint8Array): boolean {
  let hasColorTable = bytes[10] & 0x80;
  let colorTableSize = bytes[10] & 0x07;
  // Header and logical screen descriptor, then the global color table.
  let offset = 13 + (hasColorTable ? 3 * 2 ** (colorTableSize + 1) : 0);
  let frames = 0;
  while (frames < 2 && offset < bytes.length) {
    switch (bytes[offset]) {
      // Image descriptor, its local color table, then its image data.
      case 0x2c:
        frames += 1;
        hasColorTable = bytes[offset + 9] & 0x80;
        colorTableSize = bytes[offset + 9] & 0x07;
        offset += 10 + (hasColorTable ? 3 * 2 ** (colorTableSize + 1) : 0);
        offset += gifDataBlocksLength(bytes, offset + 1) + 1;
        break;
      // Extension block.
      case 0x21:
        offset += 2;
        offset += gifDataBlocksLength(bytes, offset);
        break;
      // Trailer, or anything unexpected.
      default:
        offset = bytes.length;
    }
  }
  return frames > 1;
}

/** An APNG has an `acTL` chunk before its first `IDAT`, and `fdAT` frames after. */
function isAnimatedPng(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let hasAnimationControl = false;
  let hasImageData = false;
  let hasFrameData = false;
  let previousChunk: string | null = null;
  let offset = 8;
  // Chunk length and type must fit; a truncated chunk ends the scan.
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const chunk = ascii(bytes, offset + 4, offset + 8);
    switch (chunk) {
      case "acTL":
        hasAnimationControl = true;
        break;
      case "IDAT":
        if (!hasAnimationControl) return false;
        if (previousChunk !== "fcTL" && previousChunk !== "IDAT") return false;
        hasImageData = true;
        break;
      case "fdAT":
        if (!hasImageData) return false;
        if (previousChunk !== "fcTL" && previousChunk !== "fdAT") return false;
        hasFrameData = true;
        break;
    }
    previousChunk = chunk;
    offset += 12 + length;
  }
  return hasAnimationControl && hasImageData && hasFrameData;
}

function isAnimatedWebp(bytes: Uint8Array): boolean {
  const first = WEBP_ANIM_CHUNK[0];
  for (let offset = 0; offset < bytes.length; offset++) {
    if (bytes[offset] === first && bytesAt(bytes, offset, WEBP_ANIM_CHUNK)) return true;
  }
  return false;
}

/** Whether `bytes` are an animated GIF, PNG or WebP, judged by their signature. */
export function isAnimatedImage(bytes: Uint8Array): boolean {
  if (ascii(bytes, 0, 3) === "GIF") return isAnimatedGif(bytes);
  if (bytesAt(bytes, 0, PNG_SIGNATURE)) return isAnimatedPng(bytes);
  if (bytesAt(bytes, 8, WEBP_FOURCC)) return isAnimatedWebp(bytes);
  return false;
}
