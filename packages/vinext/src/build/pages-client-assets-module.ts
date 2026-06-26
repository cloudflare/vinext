import fs from "node:fs";
import path from "node:path";
import type { PagesClientAssets } from "../server/pages-client-assets.js";

export const PAGES_CLIENT_ASSETS_MODULE = "vinext-client-assets.js";
const pagesClientAssetsByBuildRoot = new Map<string, string>();

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

export function setPagesClientAssetsBuildMetadata(buildRoot: string, moduleSource: string): void {
  pagesClientAssetsByBuildRoot.set(path.resolve(buildRoot), moduleSource);
}

export function takePagesClientAssetsBuildMetadata(buildRoot: string): string | null {
  const resolvedBuildRoot = path.resolve(buildRoot);
  const moduleSource = pagesClientAssetsByBuildRoot.get(resolvedBuildRoot) ?? null;
  pagesClientAssetsByBuildRoot.delete(resolvedBuildRoot);
  return moduleSource;
}
