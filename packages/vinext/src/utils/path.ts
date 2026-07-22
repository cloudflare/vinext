export const isWindows = process.platform === "win32";

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
