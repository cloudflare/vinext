import fs from "node:fs";
import path from "pathslash";
import { getSharedChunkFiles } from "../server/pages-asset-tags.js";
import type { PagesClientAssets } from "../server/pages-client-assets.js";
import { ASSET_PREFIX_URL_DIR } from "../utils/asset-prefix.js";
import { VINEXT_CLIENT_ENTRY_MANIFEST } from "../utils/client-entry-manifest.js";

export const PAGES_CLIENT_ASSETS_MODULE = "vinext-client-assets.js";

export function buildPagesClientAssetsModule(assets: PagesClientAssets): string {
  const prepared = assets.ssrManifest
    ? { ...assets, sharedChunks: getSharedChunkFiles(assets.ssrManifest) }
    : assets;
  return `export default ${JSON.stringify(prepared)};\n`;
}

/**
 * Select the client bundle files that live outside `_next/static`, as URL
 * pathnames. Plugins emit these at the output root, for example a Module
 * Federation host's `remoteEntry.js`. Public directory files are copied
 * outside the bundle, and build metadata (vinext's and Cloudflare's
 * `.assetsignore`) is excluded.
 */
export function collectClientBuildFiles(fileNames: Iterable<string>): string[] {
  const files: string[] = [];
  for (const fileName of fileNames) {
    const pathname = `/${fileName}`;
    if (pathname.includes(`/${ASSET_PREFIX_URL_DIR}/`)) continue;
    if (pathname.startsWith("/.vite/") || fileName === VINEXT_CLIENT_ENTRY_MANIFEST) continue;
    // Deployment metadata from @cloudflare/vite-plugin, never served.
    if (fileName === ".assetsignore") continue;
    files.push(pathname);
  }
  return files.sort();
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
