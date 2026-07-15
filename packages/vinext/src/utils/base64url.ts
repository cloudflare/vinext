/**
 * Uint8Array <-> unpadded base64url. Shared by RSC cache-busting hashes and
 * RSC transport route tokens, which run in browser, Worker, and Node runtimes
 * — hence btoa/atob rather than Buffer.
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(encoded: string): Uint8Array | null {
  try {
    const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}
