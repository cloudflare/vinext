import { ASSET_PREFIX_URL_DIR, resolveAssetUrlPrefix, resolveAssetsDir } from "./asset-prefix.js";
import { appendDeploymentIdQuery } from "./deployment-id.js";

export function renderVinextBuiltUrl(
  filename: string,
  assetPrefix: string,
  deploymentId?: string,
): string {
  const urlPrefix = resolveAssetUrlPrefix(assetPrefix);
  const onDiskDir = resolveAssetsDir(assetPrefix);
  const dirPrefix = onDiskDir + "/";
  const stripped = filename.startsWith(dirPrefix)
    ? filename.slice(dirPrefix.length)
    : filename.startsWith(`${ASSET_PREFIX_URL_DIR}/`)
      ? filename.slice(ASSET_PREFIX_URL_DIR.length + 1)
      : filename;

  return appendDeploymentIdQuery(urlPrefix + stripped, deploymentId);
}
