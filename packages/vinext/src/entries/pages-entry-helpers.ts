/**
 * Shared helpers used by the Pages Router entry generators.
 */
import path from "node:path";
import fs from "node:fs";
import { createValidFileMatcher } from "../routing/file-matcher.js";

/**
 * Find a file with any of the valid extensions in the given directory.
 * Returns the first matching absolute path, or null if not found.
 */
export function findFileWithExts(
  dir: string,
  name: string,
  matcher: ReturnType<typeof createValidFileMatcher>,
): string | null {
  for (const ext of matcher.dottedExtensions) {
    const filePath = path.join(dir, name + ext);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}
