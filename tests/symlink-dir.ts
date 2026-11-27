import fs from "node:fs";

/**
 * Links a directory the way pnpm does: a directory symlink, or a junction where
 * Windows doesn't permit symlinks (there pnpm's own links are junctions too).
 * Windows resolves the relative symlinks pnpm creates inside `source` against
 * a junction's own location, so a junction would break them.
 */
export function symlinkDir(source: string, target: string): void {
  try {
    fs.symlinkSync(source, target, "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    fs.symlinkSync(source, target, "junction");
  }
}
