import fs from "node:fs";
import path from "node:path";
import {
  CACHEABILITY_MANIFEST_MODULE,
  type CacheabilityManifest,
} from "vinext/internal/server/cacheability-manifest";

function resolveGeneratedServerConfig(root: string, configuredPath: string | undefined): string {
  const distDirectory = path.join(root, "dist");
  const configPath = path.resolve(root, configuredPath ?? "dist/server/wrangler.json");
  const relativeConfigPath = path.relative(distDirectory, configPath);
  if (relativeConfigPath.startsWith("..") || path.isAbsolute(relativeConfigPath)) {
    throw new Error(
      "Two-stage CDN warming requires a generated Wrangler config under dist/. Pass --config dist/server/wrangler.json (or another generated dist config).",
    );
  }
  if (!fs.existsSync(configPath) || !fs.lstatSync(configPath).isFile()) {
    throw new Error(
      `Two-stage CDN warming requires the generated Wrangler config at ${path.relative(root, configPath)}. Rebuild the app before deploying.`,
    );
  }
  return configPath;
}

/**
 * Upload a version-specific manifest from an isolated copy of the built Worker.
 * The application build already imports this stable module asset, so the final
 * upload only replaces its contents and never rewrites generated JavaScript.
 */
export function withCacheabilityManifestArtifact<T>(
  root: string,
  configuredPath: string | undefined,
  manifest: CacheabilityManifest,
  upload: (configPath: string) => T,
): T {
  const configPath = resolveGeneratedServerConfig(root, configuredPath);
  const serverDirectory = path.dirname(configPath);
  const manifestPath = path.join(serverDirectory, CACHEABILITY_MANIFEST_MODULE);
  if (!fs.existsSync(manifestPath) || !fs.lstatSync(manifestPath).isFile()) {
    throw new Error(
      `Two-stage CDN warming requires ${CACHEABILITY_MANIFEST_MODULE} in the generated Worker artifact. Rebuild the app before deploying.`,
    );
  }

  const isolatedDirectory = fs.mkdtempSync(
    path.join(path.dirname(serverDirectory), ".vinext-cache-"),
  );
  try {
    fs.cpSync(serverDirectory, isolatedDirectory, { recursive: true });
    const isolatedManifestPath = path.join(isolatedDirectory, CACHEABILITY_MANIFEST_MODULE);
    if (!fs.lstatSync(isolatedManifestPath).isFile()) {
      throw new Error(
        `Two-stage CDN warming requires ${CACHEABILITY_MANIFEST_MODULE} to be a regular Worker module.`,
      );
    }
    fs.writeFileSync(
      isolatedManifestPath,
      `export default ${JSON.stringify(JSON.stringify(manifest))};\n`,
      "utf8",
    );
    return upload(path.relative(root, path.join(isolatedDirectory, path.basename(configPath))));
  } finally {
    fs.rmSync(isolatedDirectory, { recursive: true, force: true });
  }
}
