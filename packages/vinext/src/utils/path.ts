/**
 * Convert Windows-style backslash path separators to forward slashes.
 *
 * Generated entry modules embed absolute filesystem paths inside `import`
 * statements. On Windows the OS-native paths use `\` which is invalid in JS
 * module specifiers, so every entry generator normalizes paths through this
 * helper before stringifying them into the emitted code.
 */
export function normalizePathSeparators(p: string): string {
  return p.replace(/\\/g, "/");
}
