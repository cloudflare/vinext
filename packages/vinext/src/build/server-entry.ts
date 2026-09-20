import fs from "node:fs";
import path from "pathslash";

const RSC_ENTRY_MANIFEST_KEY = "virtual:vinext-rsc-entry";

/** Resolve the built App handler even when a deployment host owns index.js. */
export function resolveBuiltRscEntryPath(serverDir: string): string {
  const fallbackPath = path.join(serverDir, "index.js");
  const manifestPath = path.join(serverDir, ".vite", "manifest.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return fallbackPath;
    }
    if (error instanceof SyntaxError) return fallbackPath;
    throw error;
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return fallbackPath;
  const entry = findRscEntryChunk(manifest as Record<string, unknown>);
  if (!entry) return fallbackPath;
  const file = Reflect.get(entry, "file");
  if (typeof file !== "string") return fallbackPath;

  const entryPath = path.resolve(serverDir, file);
  const relativePath = path.relative(serverDir, entryPath);
  if (relativePath.startsWith("../") || path.isAbsolute(relativePath)) return fallbackPath;
  return fs.existsSync(entryPath) ? entryPath : fallbackPath;
}

/**
 * Vite prefixes virtual module ids with the project root when the build root is
 * not the process cwd, so the manifest key arrives as
 * `<root>/virtual:vinext-rsc-entry` instead of the bare id — the same shape the
 * plugin's own `resolveId` handles for `virtual:vinext-server-entry`. Matching
 * the bare key alone misses that manifest and falls back to `index.js`, which in
 * a multi-stage Cloudflare build is the Worker entry: importing it on Node fails
 * with a raw ESM loader error and `vinext build --prerender-all` dies before it
 * renders anything. Refs cloudflare/vinext#3318
 */
function findRscEntryChunk(manifest: Record<string, unknown>): Record<string, unknown> | null {
  for (const [key, value] of Object.entries(manifest)) {
    if (key !== RSC_ENTRY_MANIFEST_KEY && !key.endsWith(`/${RSC_ENTRY_MANIFEST_KEY}`)) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}
