import { describe, expect, it } from "vite-plus/test";
import { readImageDimensions } from "../packages/vinext/src/utils/image-dimensions.js";

function createAvif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(68);
  const view = new DataView(bytes.buffer);
  const writeBox = (offset: number, size: number, type: string) => {
    view.setUint32(offset, size);
    bytes.set(new TextEncoder().encode(type), offset + 4);
  };

  writeBox(0, 16, "ftyp");
  bytes.set(new TextEncoder().encode("avif"), 8);
  writeBox(16, 52, "meta");
  writeBox(28, 40, "iprp");
  writeBox(36, 32, "ipco");
  writeBox(44, 24, "ispe");
  view.setUint32(56, width);
  view.setUint32(60, height);
  return bytes;
}

describe("image dimensions", () => {
  it("reads AVIF dimensions with bounded ISOBMFF traversal", () => {
    expect(readImageDimensions(createAvif(1200, 630))).toEqual({ width: 1200, height: 630 });
  });

  it("rejects zero-length AVIF boxes instead of looping", () => {
    const image = createAvif(1200, 630);
    new DataView(image.buffer).setUint32(44, 0);

    expect(() => readImageDimensions(image)).toThrow("disabled file type: heif");
  });

  it("rejects the vulnerable ICNS parser", () => {
    const image = Uint8Array.from([
      0x69, 0x63, 0x6e, 0x73, 0x00, 0x00, 0x00, 0x10, 0x69, 0x73, 0x33, 0x32, 0x00, 0x00, 0x00,
      0x00,
    ]);

    expect(() => readImageDimensions(image)).toThrow("disabled file type: icns");
  });
});
