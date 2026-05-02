import fs from "node:fs";
import path from "node:path";

export function scanPublicFileRoutes(root: string): string[] {
  const publicDir = path.join(root, "public");
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
      const relativePath = path.relative(publicDir, fullPath).split(path.sep).join("/");
      routes.push("/" + relativePath);
    }
  }

  if (fs.existsSync(publicDir)) {
    try {
      walk(publicDir);
    } catch {
      // ignore unreadable dirs
    }
  }

  routes.sort();
  return routes;
}
