/**
 * Defense-in-depth: validate module paths before passing them to dynamic import().
 *
 * Shared between entry.ts (initial hydration) and router.ts (client-side navigation)
 * to ensure all dynamic imports of page/app modules go through the same validation.
 *
 * Blocks:
 * - Non-string or empty values
 * - Paths that don't start with `/` or `./` (e.g., `https://evil.com/...`)
 * - Protocol URLs (`://`)
 * - Protocol-relative URLs (`//...`)
 * - Directory traversal (`..`)
 */
export function isValidModulePath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0) return false;
  // Must start with / or ./ (relative Vite module paths)
  if (!p.startsWith("/") && !p.startsWith("./")) return false;
  // Block protocol-relative URLs (e.g., "//evil.com/script.js")
  if (p.startsWith("//")) return false;
  // Must not contain protocol (prevents importing from external URLs)
  if (p.includes("://")) return false;
  // Must not traverse directories. Check path segments instead of any ".."
  // substring so valid catch-all route chunks like "__...slug__-hash.js" work.
  const pathOnly = p.split(/[?#]/, 1)[0];
  const segments = pathOnly.split(/[\\/]/);
  for (const segment of segments) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Malformed escapes are not traversal segments by themselves.
    }
    if (segment === ".." || decoded.split(/[\\/]/).includes("..")) return false;
  }
  return true;
}
