import fs from "node:fs";
import path from "node:path";
import type { PagesClientAssets } from "../server/pages-client-assets.js";

export const PAGES_CLIENT_ASSETS_MODULE = "vinext-client-assets.js";

export function buildPagesClientAssetsModule(assets: PagesClientAssets): string {
  return `export default ${JSON.stringify(assets)};\n`;
}

export function writePagesClientAssetsModuleIfMissing(
  outputDir: string,
  moduleSource: string,
): void {
  const outputPath = path.join(outputDir, PAGES_CLIENT_ASSETS_MODULE);
  if (fs.existsSync(outputPath)) return;
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, moduleSource);
}

export function findCloudflareWorkerOutputDirs(buildRoot: string): string[] {
  const distDir = path.resolve(buildRoot, "dist");
  if (!fs.existsSync(distDir)) return [];

  const clientDir = path.join(distDir, "client");
  const outputDirs: string[] = [];
  const pendingDirs = [distDir];
  while (pendingDirs.length > 0) {
    const directory = pendingDirs.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(directory, entry.name);
      if (candidate === clientDir) continue;
      if (fs.existsSync(path.join(candidate, "wrangler.json"))) {
        outputDirs.push(candidate);
        continue;
      }
      pendingDirs.push(candidate);
    }
  }
  return outputDirs;
}
