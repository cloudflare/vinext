import fs from "node:fs";
import path from "node:path";

/** Build Output versions the typed cf Vite plugin may emit, newest first. */
const BUILD_OUTPUT_VERSIONS = ["v1", "v0"];

/**
 * Resolve the versioned Build Output directory in `.cloudflare/output/`.
 * Returns the newest version that has a default Worker config, falling back to
 * `v0` when none does so callers keep reporting their own missing-build errors.
 */
export function resolveBuildOutputDir(root: string): string {
  const outputDir = path.join(root, ".cloudflare", "output");
  for (const version of BUILD_OUTPUT_VERSIONS) {
    const versionDir = path.join(outputDir, version);
    if (fs.existsSync(path.join(versionDir, "workers", "default", "worker.config.json"))) {
      return versionDir;
    }
  }
  return path.join(outputDir, "v0");
}

export function resolveBuildOutputDefaultWorkerDir(root: string): string {
  return path.join(resolveBuildOutputDir(root), "workers", "default");
}

export function resolveBuildOutputDefaultWorkerConfigPath(root: string): string {
  return path.join(resolveBuildOutputDefaultWorkerDir(root), "worker.config.json");
}
