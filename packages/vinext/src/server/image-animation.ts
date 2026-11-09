/**
 * Animated image detection for the image optimization endpoint.
 *
 * Animated images are served as-is to preserve all their frames.
 * The GIF, PNG and WebP checks are a port of the `is-animated`
 * package Next.js compiles in (next/dist/compiled/is-animated, MIT, Józef
 * Sokołowski), which `imageOptimizer` in
 * packages/next/src/server/image-optimizer.ts calls on the upstream bytes.
 */

import type { ImageSourceReader } from "./image-source-reader.js";

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
async function gifDataBlocksLength(source: ImageSourceReader, offset: number): Promise<number> {
  let length = 0;
  for (;;) {
    const size = (await source.byte(offset + length)) ?? 0;
    if (size === 0) return length + 1;
    length += size + 1;
  }
}

async function isAnimatedGif(source: ImageSourceReader, head: Uint8Array): Promise<boolean> {
  let hasColorTable = head[10] & 0x80;
  let colorTableSize = head[10] & 0x07;
  // Header and logical screen descriptor, then the global color table.
  let offset = 13 + (hasColorTable ? 3 * 2 ** (colorTableSize + 1) : 0);
  let frames = 0;
  while (frames < 2) {
    switch ((await source.byte(offset)) ?? 0x3b) {
      // Image descriptor, its local color table, then its image data.
      case 0x2c: {
        frames += 1;
        const flags = (await source.byte(offset + 9)) ?? 0;
        hasColorTable = flags & 0x80;
        colorTableSize = flags & 0x07;
        offset += 10 + (hasColorTable ? 3 * 2 ** (colorTableSize + 1) : 0);
        offset += (await gifDataBlocksLength(source, offset + 1)) + 1;
        break;
      }
      // Extension block.
      case 0x21:
        offset += 2;
        offset += await gifDataBlocksLength(source, offset);
        break;
      // Trailer, which the source's end reads as, or anything unexpected.
      default:
        return false;
    }
  }
  return true;
}

/** An APNG has an `acTL` chunk before its first `IDAT`, and `fdAT` frames after. */
async function isAnimatedPng(source: ImageSourceReader): Promise<boolean> {
  let hasAnimationControl = false;
  let hasImageData = false;
  let hasFrameData = false;
  let previousChunk: string | null = null;
  let offset = 8;
  for (;;) {
    // Chunk length and type must fit; a truncated chunk ends the scan.
    const header = await source.bytes(offset, 8);
    if (header.byteLength < 8) break;
    const length = new DataView(header.buffer).getUint32(0);
    const chunk = ascii(header, 4, 8);
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

/** Bytes of a WebP source searched per read. */
const WEBP_SCAN_STEP = 65_536;

/** Like is-animated, any `ANIM` in a WebP source marks it animated. */
async function isAnimatedWebp(source: ImageSourceReader): Promise<boolean> {
  const first = WEBP_ANIM_CHUNK[0];
  // Each read overlaps the next by all but one byte of `ANIM`.
  const readLength = WEBP_SCAN_STEP + WEBP_ANIM_CHUNK.length - 1;
  for (let start = 0; ; start += WEBP_SCAN_STEP) {
    const bytes = await source.bytes(start, readLength);
    for (let offset = 0; offset < bytes.length; offset++) {
      if (bytes[offset] === first && bytesAt(bytes, offset, WEBP_ANIM_CHUNK)) return true;
    }
    if (bytes.length < readLength) return false;
  }
}

/** An AVIF sequence advertises `avis` as a major or compatible brand. */
async function isAnimatedAvif(source: ImageSourceReader, head: Uint8Array): Promise<boolean> {
  const boxSize = new DataView(head.buffer).getUint32(0);
  if (boxSize < 16) return false;
  if (ascii(head, 8, 12) === "avis") return (await source.bytes(12, 4)).length === 4;

  // Skip the minor version at byte 12 and stop at the end of the ftyp box.
  const sequenceBrand = [0x61, 0x76, 0x69, 0x73]; // "avis"
  for (let offset = 16; offset + 4 <= boxSize; offset += 4096) {
    const length = Math.min(4096, boxSize - offset);
    const brands = await source.bytes(offset, length);
    for (let index = 0; index + 4 <= brands.length; index += 4) {
      if (bytesAt(brands, index, sequenceBrand)) return true;
    }
    if (brands.length < length) return false;
  }
  return false;
}

/**
 * Whether a source is an animated GIF, PNG, WebP or AVIF.
 * The source is parsed as it streams in, so only the bytes a format's check
 * needs are read, and none are kept beyond what the reader holds to replay.
 */
export async function isAnimatedImage(source: ImageSourceReader): Promise<boolean> {
  const head = await source.bytes(0, 12);
  if (ascii(head, 0, 3) === "GIF") return isAnimatedGif(source, head);
  if (bytesAt(head, 0, PNG_SIGNATURE)) return isAnimatedPng(source);
  if (bytesAt(head, 8, WEBP_FOURCC)) return isAnimatedWebp(source);
  if (head.length === 12 && ascii(head, 4, 8) === "ftyp") {
    return isAnimatedAvif(source, head);
  }
  return false;
}
