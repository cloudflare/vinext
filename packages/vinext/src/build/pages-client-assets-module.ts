import fs from "node:fs";
import path from "node:path";
import type { PagesClientAssets } from "../server/pages-client-assets.js";

export const PAGES_CLIENT_ASSETS_MODULE = "vinext-client-assets.js";
const pagesClientAssetsByBuildSession = new Map<string, string>();

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

export function setPagesClientAssetsBuildMetadata(
  buildSession: string,
  moduleSource: string,
): void {
  pagesClientAssetsByBuildSession.set(buildSession, moduleSource);
}

export function takePagesClientAssetsBuildMetadata(buildSession: string): string | null {
  const moduleSource = pagesClientAssetsByBuildSession.get(buildSession) ?? null;
  pagesClientAssetsByBuildSession.delete(buildSession);
  return moduleSource;
}

export function clearPagesClientAssetsBuildMetadata(buildSession: string): void {
  pagesClientAssetsByBuildSession.delete(buildSession);
}
