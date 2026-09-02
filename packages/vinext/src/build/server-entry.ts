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
  const entry = Reflect.get(manifest, RSC_ENTRY_MANIFEST_KEY);
  if (!entry || typeof entry !== "object") return fallbackPath;
  const file = Reflect.get(entry, "file");
  if (typeof file !== "string") return fallbackPath;

  const entryPath = path.resolve(serverDir, file);
  const relativePath = path.relative(serverDir, entryPath);
  if (relativePath.startsWith("../") || path.isAbsolute(relativePath)) return fallbackPath;
  return fs.existsSync(entryPath) ? entryPath : fallbackPath;
}
