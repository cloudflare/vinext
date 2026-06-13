import { ASSET_PREFIX_URL_DIR, resolveAssetUrlPrefix, resolveAssetsDir } from "./asset-prefix.js";
import { appendDeploymentIdQuery } from "./deployment-id.js";

export function renderVinextBuiltUrl(
  filename: string,
  assetPrefix: string,
  deploymentId?: string,
  hostType?: "js" | "css" | "html",
): string {
  const urlPrefix = resolveAssetUrlPrefix(assetPrefix);
  const onDiskDir = resolveAssetsDir(assetPrefix);
  const dirPrefix = onDiskDir + "/";
  const stripped = filename.startsWith(dirPrefix)
    ? filename.slice(dirPrefix.length)
    : filename.startsWith(`${ASSET_PREFIX_URL_DIR}/`)
      ? filename.slice(ASSET_PREFIX_URL_DIR.length + 1)
      : filename;

  const url = urlPrefix + stripped;
  // Native ESM resolves a chunk's imports relative to the importing module URL.
  // Adding a deployment query to URLs embedded in JavaScript gives the entry a
  // different module identity while its relative imports remain unversioned,
  // splitting React/RSC singleton state across duplicate module graphs.
  return hostType === "js" ? url : appendDeploymentIdQuery(url, deploymentId);
}
