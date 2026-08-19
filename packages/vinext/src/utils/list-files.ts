import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "pathslash";

/**
 * Enumerate non-dot files while following directory symlinks. Missing directories
 * yield an empty list. Real paths are tracked only along the current recursion
 * chain, which breaks cycles while preserving distinct aliases of the same target.
 */
export async function listFilesFollowingSymlinks(
  directory: string,
  recursive: boolean,
): Promise<string[]> {
  const files: string[] = [];
  const ancestorRealPaths = new Set<string>();

  async function walk(currentDirectory: string, prefix: string): Promise<void> {
    let realDirectory: string;
    let entries: Dirent[];
    try {
      realDirectory = await realpath(currentDirectory);
      entries = await readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    if (ancestorRealPaths.has(realDirectory)) return;
    ancestorRealPaths.add(realDirectory);

    try {
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const entryPath = path.join(currentDirectory, entry.name);
        let isFile = entry.isFile();
        let isDirectory = entry.isDirectory();
        // Symlinks and some network filesystems do not expose a useful dirent
        // type, so resolve them before deciding whether to recurse.
        if (!isFile && !isDirectory) {
          try {
            const stats = await stat(entryPath);
            isFile = stats.isFile();
            isDirectory = stats.isDirectory();
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ELOOP") continue;
            throw error;
          }
        }
        if (isFile) files.push(`${prefix}${entry.name}`);
        else if (isDirectory && recursive) await walk(entryPath, `${prefix}${entry.name}/`);
      }
    } finally {
      ancestorRealPaths.delete(realDirectory);
    }
  }

  await walk(directory, "");
  return files;
}
