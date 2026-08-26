import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import {
  CACHEABILITY_MANIFEST_MODULE,
  type CacheabilityManifest,
} from "vinext/internal/server/cacheability-manifest";

export const MAX_CACHEABILITY_MANIFEST_BYTES = 1024 * 1024;
export const MAX_CACHEABILITY_MANIFEST_ROUTES = 10_000;

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

function assertManifestModuleReachable(configPath: string): void {
  const serverDirectory = path.dirname(configPath);
  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (cause) {
    throw new Error("Two-stage CDN warming could not parse the generated Wrangler config.", {
      cause,
    });
  }
  const main =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>).main
      : undefined;
  if (typeof main !== "string" || main.length === 0) {
    throw new Error("Two-stage CDN warming requires a generated Wrangler main module.");
  }
  const mainPath = path.resolve(serverDirectory, main);
  if (!fs.existsSync(mainPath) || !fs.lstatSync(mainPath).isFile()) {
    throw new Error("Two-stage CDN warming could not find the generated Wrangler main module.");
  }
  if (!fs.readFileSync(mainPath, "utf8").includes(CACHEABILITY_MANIFEST_MODULE)) {
    throw new Error(
      `Two-stage CDN warming requires the generated Worker main module to import ${CACHEABILITY_MANIFEST_MODULE}.`,
    );
  }
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
  assertManifestModuleReachable(configPath);
  const serverDirectory = path.dirname(configPath);
  const manifestPath = path.join(serverDirectory, CACHEABILITY_MANIFEST_MODULE);
  if (!fs.existsSync(manifestPath) || !fs.lstatSync(manifestPath).isFile()) {
    throw new Error(
      `Two-stage CDN warming requires ${CACHEABILITY_MANIFEST_MODULE} in the generated Worker artifact. Rebuild the app before deploying.`,
    );
  }
  const routeCount = Object.keys(manifest.routes).length;
  if (routeCount > MAX_CACHEABILITY_MANIFEST_ROUTES) {
    throw new Error(
      `Two-stage CDN warming produced ${routeCount} cacheable identities; the limit is ${MAX_CACHEABILITY_MANIFEST_ROUTES}. Narrow prerender discovery or split the deployment before retrying.`,
    );
  }
  const serializedManifest = JSON.stringify(manifest);
  const manifestBytes = Buffer.byteLength(serializedManifest);
  if (manifestBytes > MAX_CACHEABILITY_MANIFEST_BYTES) {
    throw new Error(
      `Two-stage CDN warming produced a ${manifestBytes}-byte cacheability manifest; the limit is ${MAX_CACHEABILITY_MANIFEST_BYTES} bytes. Narrow prerender discovery or split the deployment before retrying.`,
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
      `export default ${JSON.stringify(serializedManifest)};\n`,
      "utf8",
    );
    return upload(path.relative(root, path.join(isolatedDirectory, path.basename(configPath))));
  } finally {
    fs.rmSync(isolatedDirectory, { recursive: true, force: true });
  }
}
