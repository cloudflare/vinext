import type { PagesClientAssets } from "../server/pages-client-assets.js";

export const PAGES_CLIENT_ASSETS_MODULE = "vinext-client-assets.js";

export function buildPagesClientAssetsModule(assets: PagesClientAssets): string {
  return `export default ${JSON.stringify(assets)};\n`;
}
