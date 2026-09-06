import fs from "node:fs";
import path from "pathslash";

/**
 * Cloudflare Vite builds emit `dist/<worker-name>/wrangler.json`
 * (or `dist/server/wrangler.json`). The Node `vinext start` server
 * looks for `dist/server/index.js` / `entry.js` and misses that output.
 */
export function findEmittedWranglerConfig(cwd: string): string | null {
  const dist = path.join(cwd, "dist");
  if (!fs.existsSync(dist)) return null;

  const serverCfg = path.join(dist, "server", "wrangler.json");
  if (fs.existsSync(serverCfg)) return serverCfg;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dist, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(dist, entry.name, "wrangler.json");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
