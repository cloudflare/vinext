import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Resolve a sibling module path relative to a caller's `import.meta.url`,
 * returning a forward-slash path safe for embedding in generated code.
 *
 * This is the single place that owns the
 * `fileURLToPath(new URL(rel, base)).replace(/\\/g, "/")` idiom so callers
 * don't duplicate it.
 *
 * @param rel  - Relative path to the target module (e.g. `"../server/foo.js"`)
 * @param base - The caller's `import.meta.url`
 */
export function resolveEntryPath(rel: string, base: string): string {
  return fileURLToPath(new URL(rel, base)).replace(/\\/g, "/");
}

/**
 * Resolve a real runtime module for a virtual entry generator.
 *
 * During local development we want to point at source files (for example `.ts`),
 * while packed builds only contain emitted `.js` files in `dist/`. Probe the
 * common source/build extensions and fall back to the `.js` path that exists in
 * published packages.
 */
export function resolveRuntimeEntryModule(name: string): string {
  for (const ext of [".ts", ".js", ".mts", ".mjs"]) {
    const filePath = resolveEntryPath(`../server/${name}${ext}`, import.meta.url);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return resolveEntryPath(`../server/${name}.js`, import.meta.url);
}
