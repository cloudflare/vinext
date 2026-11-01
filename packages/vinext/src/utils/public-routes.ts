import fs from "node:fs";
import path from "pathslash";
import { publicFileRouteKey } from "./public-file-path.js";

export function scanPublicFileRoutes(
  root: string,
  configuredPublicDir: string | false = "public",
): string[] {
  return [...new Set(scanPublicFiles(root, configuredPublicDir).map(publicFileRouteKey))].sort();
}

/** List the files in the public directory as `/`-prefixed relative paths. */
export function scanPublicFiles(
  root: string,
  configuredPublicDir: string | false = "public",
): string[] {
  // Vite normalizes `publicDir: false` to an empty string in resolved config.
  // Treat both representations as disabled rather than scanning the project root.
  if (configuredPublicDir === false || configuredPublicDir === "") return [];
  const publicDir = path.resolve(root, configuredPublicDir);
  const files: string[] = [];
  // The directories being walked, so a symlink to one of them can't loop.
  // Two links to the same directory are both walked, since each serves the files.
  const ancestorDirs = new Set<string>();

  function walk(dir: string): void {
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (ancestorDirs.has(realDir)) return;
    ancestorDirs.add(realDir);
    try {
      walkEntries(dir);
    } finally {
      ancestorDirs.delete(realDir);
    }
  }

  function walkEntries(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (!stat.isFile()) continue;
      } else if (!entry.isFile()) {
        continue;
      }
      const relativePath = path.relative(publicDir, fullPath);
      files.push("/" + relativePath);
    }
  }

  if (fs.existsSync(publicDir)) {
    try {
      walk(publicDir);
    } catch {
      // ignore unreadable dirs
    }
  }

  return files;
}
