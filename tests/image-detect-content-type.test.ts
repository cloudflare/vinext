import { describe, it, expect } from "vitest";
import { detectContentType } from "../packages/vinext/src/server/image-optimization.js";

function makeBuffer(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

describe("detectContentType", () => {
  it("returns null for empty buffer", () => {
    expect(detectContentType(new ArrayBuffer(0))).toBeNull();
  });

  it("returns null for 1-byte buffer", () => {
    expect(detectContentType(makeBuffer(0x00))).toBeNull();
  });

  it("returns null for unrecognized bytes", () => {
    expect(detectContentType(makeBuffer(0x01, 0x02, 0x03, 0x04))).toBeNull();
  });

  it("detects JPEG (FF D8)", () => {
    expect(detectContentType(makeBuffer(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
  });

  it("detects PNG (89 50 4E 47 0D 0A 1A 0A)", () => {
    expect(detectContentType(makeBuffer(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(
      "image/png",
    );
  });

  it("detects GIF (47 49 46)", () => {
    expect(detectContentType(makeBuffer(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image/gif");
  });

  it("detects WebP (RIFF....WEBP)", () => {
    // RIFF + 4 size bytes + WEBP
    expect(
      detectContentType(
        makeBuffer(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50),
      ),
    ).toBe("image/webp");
  });

  it("detects AVIF (ftypavif)", () => {
    // 4 size bytes + ftypavif
    const ftyp = [..."ftypavif"].map((c) => c.charCodeAt(0));
    expect(detectContentType(makeBuffer(0x00, 0x00, 0x00, 0x1c, ...ftyp))).toBe("image/avif");
  });

  it("detects AVIF sequence (ftypavis)", () => {
    const ftyp = [..."ftypavis"].map((c) => c.charCodeAt(0));
    expect(detectContentType(makeBuffer(0x00, 0x00, 0x00, 0x1c, ...ftyp))).toBe("image/avif");
  });

  it("detects ICO (00 00 01 00)", () => {
    expect(detectContentType(makeBuffer(0x00, 0x00, 0x01, 0x00))).toBe("image/x-icon");
  });

  it("detects ICNS (69 63 6E 73)", () => {
    expect(detectContentType(makeBuffer(0x69, 0x63, 0x6e, 0x73))).toBe("image/icns");
  });

  it("detects TIFF little-endian (49 49 2A 00)", () => {
    expect(detectContentType(makeBuffer(0x49, 0x49, 0x2a, 0x00))).toBe("image/tiff");
  });

  it("detects TIFF big-endian (4D 4D 00 2A)", () => {
    expect(detectContentType(makeBuffer(0x4d, 0x4d, 0x00, 0x2a))).toBe("image/tiff");
  });

  it("detects BMP (42 4D)", () => {
    expect(detectContentType(makeBuffer(0x42, 0x4d, 0x00, 0x00))).toBe("image/bmp");
  });

  it("detects JPEG XL bare codestream (FF 0A)", () => {
    expect(detectContentType(makeBuffer(0xff, 0x0a, 0x00, 0x00))).toBe("image/jxl");
  });

  it("detects JPEG XL container (00 00 00 0C 4A 58 4C 20 0D 0A 87 0A)", () => {
    expect(
      detectContentType(
        makeBuffer(0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a),
      ),
    ).toBe("image/jxl");
  });

  it("detects PDF (%PDF)", () => {
    expect(detectContentType(makeBuffer(0x25, 0x50, 0x44, 0x46))).toBe("application/pdf");
  });

  it("detects SVG with <?xml declaration", () => {
    const svgXml = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const encoder = new TextEncoder();
    expect(detectContentType(encoder.encode(svgXml).buffer)).toBe("image/svg+xml");
  });

  it("detects SVG with <svg tag", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const encoder = new TextEncoder();
    expect(detectContentType(encoder.encode(svg).buffer)).toBe("image/svg+xml");
  });

  it("detects SVG with leading whitespace", () => {
    const svg = '  \n\t  <svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const encoder = new TextEncoder();
    expect(detectContentType(encoder.encode(svg).buffer)).toBe("image/svg+xml");
  });

  it("detects HEIC (ftypheic)", () => {
    const ftyp = [..."ftypheic"].map((c) => c.charCodeAt(0));
    expect(detectContentType(makeBuffer(0x00, 0x00, 0x00, 0x1c, ...ftyp))).toBe("image/heic");
  });

  it("detects JP2 (ftypjp2)", () => {
    const ftyp = [..."ftypjp2"].map((c) => c.charCodeAt(0));
    expect(detectContentType(makeBuffer(0x00, 0x00, 0x00, 0x0f, ...ftyp, 0x20))).toBe("image/jp2");
  });
});
