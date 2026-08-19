import fs from "node:fs";
import path from "pathslash";
import type { ResolvedNextConfig } from "../config/next-config.js";
import { getPrewarmableAppPaths, readPrerenderManifest } from "../server/prerender-manifest.js";
import { resolveAssetsDir } from "../utils/asset-prefix.js";
import { renderVinextBuiltUrl } from "../utils/built-asset-url.js";
import { normalizePathTrailingSlash } from "vinext/shims/url-utils";

const RSC_PREWARM_MANIFEST_FILENAME = "vinext-rsc-prewarm.json";

type RscPrewarmBuildConfig = Pick<
  ResolvedNextConfig,
  "assetPrefix" | "basePath" | "buildId" | "deploymentId" | "trailingSlash"
>;

function toDeploymentPath(pathname: string, config: RscPrewarmBuildConfig): string {
  const withBasePath = config.basePath
    ? pathname === "/"
      ? config.basePath
      : `${config.basePath}${pathname}`
    : pathname;
  return normalizePathTrailingSlash(withBasePath, config.trailingSlash);
}

export function getRscPrewarmManifestUrl(config: RscPrewarmBuildConfig): string {
  const fileName = `${resolveAssetsDir(config.assetPrefix)}/${config.buildId}/${RSC_PREWARM_MANIFEST_FILENAME}`;
  return renderVinextBuiltUrl(fileName, config.assetPrefix, config.deploymentId, "html");
}

/** Emit the exact production URL paths whose completed prerender is ISR-cacheable. */
export function emitRscPrewarmManifest(root: string, config: RscPrewarmBuildConfig): void {
  const manifest = readPrerenderManifest(
    path.join(root, "dist", "server", "vinext-prerender.json"),
  );
  const paths = manifest
    ? getPrewarmableAppPaths(manifest).map((pathname) => toDeploymentPath(pathname, config))
    : [];
  const outputPath = path.join(
    root,
    "dist",
    "client",
    resolveAssetsDir(config.assetPrefix),
    config.buildId,
    RSC_PREWARM_MANIFEST_FILENAME,
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({ version: 1, paths }) + "\n", "utf-8");
}
