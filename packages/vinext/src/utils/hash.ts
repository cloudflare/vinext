/**
 * FNV-1a hash producing a 64-bit result (two 32-bit rounds with different seeds).
 * Used for deterministic key generation where collisions must be rare.
 */
export function fnv1a64(input: string): string {
  // First 32-bit round with standard FNV offset basis
  let h1 = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h1 ^= input.charCodeAt(i);
    h1 = (h1 * 0x01000193) >>> 0;
  }
  // Second 32-bit round with different seed
  let h2 = 0x050c5d1f;
  for (let i = 0; i < input.length; i++) {
    h2 ^= input.charCodeAt(i);
    h2 = (h2 * 0x01000193) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}
