import fs from "node:fs";
import path from "pathslash";
import { getSharedChunkFiles } from "../server/pages-asset-tags.js";
import type { PagesClientAssets } from "../server/pages-client-assets.js";

export const PAGES_CLIENT_ASSETS_MODULE = "vinext-client-assets.js";

export function buildPagesClientAssetsModule(assets: PagesClientAssets): string {
  const prepared = assets.ssrManifest
    ? { ...assets, sharedChunks: getSharedChunkFiles(assets.ssrManifest) }
    : assets;
  return `export default ${JSON.stringify(prepared)};\n`;
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
