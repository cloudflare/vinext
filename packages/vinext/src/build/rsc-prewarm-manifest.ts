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
  const normalized = normalizePathTrailingSlash(withBasePath, config.trailingSlash);
  return new URL(normalized, "http://vinext.local").pathname;
}

function getRscPrewarmManifestFileName(
  config: RscPrewarmBuildConfig,
  rscBuildIdentity: string,
): string {
  return `${resolveAssetsDir(config.assetPrefix)}/${config.buildId}/${rscBuildIdentity}/${RSC_PREWARM_MANIFEST_FILENAME}`;
}

export function getRscPrewarmManifestUrl(
  config: RscPrewarmBuildConfig,
  rscBuildIdentity: string,
): string {
  const fileName = getRscPrewarmManifestFileName(config, rscBuildIdentity);
  return renderVinextBuiltUrl(fileName, config.assetPrefix, config.deploymentId, "html");
}

export function writeRscPrewarmManifest(
  clientDir: string,
  config: RscPrewarmBuildConfig,
  rscBuildIdentity: string,
  paths: readonly string[],
): void {
  const outputPath = path.join(clientDir, getRscPrewarmManifestFileName(config, rscBuildIdentity));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({ version: 1, paths }) + "\n", "utf-8");
}

/** Emit the exact production URL paths whose completed prerender is ISR-cacheable. */
export function emitRscPrewarmManifest(root: string, config: RscPrewarmBuildConfig): void {
  let rscBuildIdentity: string;
  try {
    rscBuildIdentity = fs.readFileSync(path.join(root, "dist/server/RSC_BUILD_ID"), "utf-8").trim();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (!rscBuildIdentity) return;
  const manifest = readPrerenderManifest(
    path.join(root, "dist", "server", "vinext-prerender.json"),
  );
  const paths =
    manifest?.buildId === config.buildId
      ? getPrewarmableAppPaths(manifest).map((pathname) => toDeploymentPath(pathname, config))
      : [];
  writeRscPrewarmManifest(path.join(root, "dist", "client"), config, rscBuildIdentity, paths);
}
