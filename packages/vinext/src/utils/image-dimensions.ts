import { disableTypes, imageSize } from "image-size";

type ImageDimensions = {
  width?: number;
  height?: number;
};

type IsoBmffBox = {
  type: string;
  dataStart: number;
  end: number;
};

const AVIF_BRANDS = new Set(["avif", "avis", "avio"]);

// vinext accepts neither ICNS nor JPEG XL file imports. JPEG 2000 is also not
// a supported static-import extension. Keep those parsers unreachable, along
// with image-size's HEIF parser, which also handles AVIF and contains the same
// zero-length-box failure mode. AVIF is parsed by the bounded reader below.
disableTypes(["heif", "icns", "j2c", "jp2", "jxl", "jxl-stream"]);

function readUint32(input: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > input.length) return undefined;
  return new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(offset);
}

function readFourCc(input: Uint8Array, offset: number): string | undefined {
  if (offset < 0 || offset + 4 > input.length) return undefined;
  return String.fromCodePoint(...input.subarray(offset, offset + 4));
}

function readBox(input: Uint8Array, offset: number, limit: number): IsoBmffBox | undefined {
  const size = readUint32(input, offset);
  const type = readFourCc(input, offset + 4);
  if (size === undefined || type === undefined || size < 8) return undefined;

  const end = offset + size;
  if (end > limit || end > input.length) return undefined;
  return { type, dataStart: offset + 8, end };
}

function findBoxes(input: Uint8Array, start: number, end: number, type: string): IsoBmffBox[] {
  const matches: IsoBmffBox[] = [];
  let offset = start;
  while (offset < end) {
    const box = readBox(input, offset, end);
    if (!box) break;
    if (box.type === type) matches.push(box);
    offset = box.end;
  }
  return matches;
}

function isAvif(input: Uint8Array): boolean {
  const ftyp = readBox(input, 0, input.length);
  if (!ftyp || ftyp.type !== "ftyp" || ftyp.end - ftyp.dataStart < 8) return false;

  const brands = [readFourCc(input, ftyp.dataStart)];
  for (let offset = ftyp.dataStart + 8; offset + 4 <= ftyp.end; offset += 4) {
    brands.push(readFourCc(input, offset));
  }
  return brands.some((brand) => brand !== undefined && AVIF_BRANDS.has(brand));
}

function readAvifDimensions(input: Uint8Array): ImageDimensions | undefined {
  if (!isAvif(input)) return undefined;

  const sizes: Required<ImageDimensions>[] = [];
  for (const meta of findBoxes(input, 0, input.length, "meta")) {
    // A meta box starts with one version byte and three flag bytes.
    for (const iprp of findBoxes(input, meta.dataStart + 4, meta.end, "iprp")) {
      for (const ipco of findBoxes(input, iprp.dataStart, iprp.end, "ipco")) {
        for (const ispe of findBoxes(input, ipco.dataStart, ipco.end, "ispe")) {
          const width = readUint32(input, ispe.dataStart + 4);
          const height = readUint32(input, ispe.dataStart + 8);
          if (width !== undefined && height !== undefined) sizes.push({ width, height });
        }
      }
    }
  }

  return sizes.reduce<Required<ImageDimensions> | undefined>((largest, candidate) => {
    if (!largest || candidate.width * candidate.height > largest.width * largest.height) {
      return candidate;
    }
    return largest;
  }, undefined);
}

export function readImageDimensions(input: Uint8Array): ImageDimensions {
  return readAvifDimensions(input) ?? imageSize(input);
}
