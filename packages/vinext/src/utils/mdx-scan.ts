import fs from "node:fs";
import path from "node:path";

/** Module-level cache for hasMdxFiles — avoids re-scanning per Vite environment. */
export const mdxScanCache = new Map<string, boolean>();

/**
 * Check if the project has .mdx files in app/ or pages/ directories.
 */
export function hasMdxFiles(root: string, appDir: string | null, pagesDir: string | null): boolean {
  const cacheKey = `${root}\0${appDir ?? ""}\0${pagesDir ?? ""}`;
  if (mdxScanCache.has(cacheKey)) return mdxScanCache.get(cacheKey)!;
  const dirs = [appDir, pagesDir].filter(Boolean) as string[];
  for (const dir of dirs) {
    if (fs.existsSync(dir) && scanDirForMdx(dir)) {
      mdxScanCache.set(cacheKey, true);
      return true;
    }
  }
  mdxScanCache.set(cacheKey, false);
  return false;
}

function scanDirForMdx(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (scanDirForMdx(full)) return true;
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mdx")) {
        return true;
      }
    }
  } catch {
    // ignore unreadable dirs
  }
  return false;
}
