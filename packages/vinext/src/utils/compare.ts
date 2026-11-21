export const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

/**
 * Turbopack reads a folder's subfolders from a `BTreeMap<RcStr, _>`, whose
 * keys compare as Rust `str`s: by UTF-8 bytes. That is Unicode code point
 * order, which JavaScript's `<` (UTF-16 code units) doesn't match above the
 * Basic Multilingual Plane.
 * https://github.com/vercel/next.js/blob/v16.2.7/crates/next-core/src/app_structure.rs#L188-L192
 * https://github.com/vercel/next.js/blob/v16.2.7/turbopack/crates/turbo-rcstr/src/lib.rs#L350-L354
 */
export function compareFolderNames(a: string, b: string): number {
  const left = Array.from(a, (char) => char.codePointAt(0) ?? 0);
  const right = Array.from(b, (char) => char.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}
