import fs from "node:fs";
import path from "pathslash";
import { publicFilePathVariants } from "./public-file-path.js";

export function scanPublicFileRoutes(
  root: string,
  configuredPublicDir: string | false = "public",
): string[] {
  // Vite normalizes `publicDir: false` to an empty string in resolved config.
  // Treat both representations as disabled rather than scanning the project root.
  if (configuredPublicDir === false || configuredPublicDir === "") return [];
  const publicDir = path.resolve(root, configuredPublicDir);
  const routes: string[] = [];
  const visitedDirs = new Set<string>();

  function walk(dir: string): void {
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

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
      routes.push(...publicFilePathVariants("/" + relativePath));
    }
  }

  if (fs.existsSync(publicDir)) {
    try {
      walk(publicDir);
    } catch {
      // ignore unreadable dirs
    }
  }

  return [...new Set(routes)].sort();
}
