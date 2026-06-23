export const isWindows = process.platform === "win32";

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

/** Strip a trailing `.js` extension from a module specifier so
 *  `resolveShimModulePath` looks for the correct base name (e.g. `headers.js`
 *  → `headers`). Public and internal shim imports may carry extensionful
 *  subpaths; normalising before resolution prevents looking for non-existent
 *  files like `headers.js.ts`. */
export function stripJsExtension(name: string): string {
  return name.endsWith(".js") ? name.slice(0, -3) : name;
}
