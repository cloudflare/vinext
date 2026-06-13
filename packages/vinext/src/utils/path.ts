const isWindows = process.platform === "win32";

/**
 * Convert Windows-style backslash path separators to forward slashes.
 *
 * Generated entry modules embed absolute filesystem paths inside `import`
 * statements. On Windows the OS-native paths use `\` which is invalid in JS
 * module specifiers, so every entry generator normalizes paths through this
 * helper before stringifying them into the emitted code.
 *
 * No-op on POSIX — skips the regex scan entirely since backslashes never
 * appear in filesystem paths on Linux/macOS.
 */
export function normalizePathSeparators(p: string): string {
  return isWindows ? p.replace(/\\/g, "/") : p;
}

export function stripViteModuleQuery(id: string): string {
  const queryIndex = id.search(/[?#]/);
  return queryIndex === -1 ? id : id.slice(0, queryIndex);
}
