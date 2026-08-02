export type PrecompressedEncoding = "br" | "gzip" | "zstd";

const VARY_HEADER_BYTES = "Vary: Accept-Encoding\r\n".length;
const RESPONSE_HEADER_OVERHEAD: Record<PrecompressedEncoding, number> = {
  br: "Content-Encoding: br\r\n".length + VARY_HEADER_BYTES,
  gzip: "Content-Encoding: gzip\r\n".length + VARY_HEADER_BYTES,
  zstd: "Content-Encoding: zstd\r\n".length + VARY_HEADER_BYTES,
};

/**
 * Return whether an encoded representation reduces conservative HTTP/1 wire
 * bytes after accounting for the response fields needed to negotiate it.
 */
export function isPrecompressedVariantBeneficial(
  compressedSize: number,
  originalSize: number,
  encoding: PrecompressedEncoding,
): boolean {
  return originalSize - compressedSize > RESPONSE_HEADER_OVERHEAD[encoding];
}
