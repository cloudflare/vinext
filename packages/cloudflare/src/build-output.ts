import fs from "node:fs";
import path from "node:path";

// Matches the version directories @cloudflare/build-output-utils detects.
const VERSION_DIRECTORY_PATTERN = /^v(0|[1-9]\d*)$/;

/**
 * Resolve the versioned Build Output directory in `.cloudflare/output/`, such
 * as `v0` or `v1`. Falls back to `v0` when none exists so callers keep
 * reporting their own missing-build errors. Like cf's Build Output reader,
 * output in more than one version is rejected rather than guessed between.
 */
export function resolveBuildOutputDir(root: string): string {
  const outputDir = path.join(root, ".cloudflare", "output");
  const versions = fs.existsSync(outputDir)
    ? fs
        .readdirSync(outputDir, { withFileTypes: true })
        .filter(
          (entry) =>
            (entry.isDirectory() || entry.isSymbolicLink()) &&
            VERSION_DIRECTORY_PATTERN.test(entry.name),
        )
        .map((entry) => entry.name)
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    : [];
  if (versions.length > 1) {
    throw new Error(
      `Found Cloudflare Build Output in more than one format (${versions.join(", ")}) in ${outputDir}. Delete ${outputDir} and rebuild.`,
    );
  }
  return path.join(outputDir, versions[0] ?? "v0");
}

export function resolveBuildOutputDefaultWorkerDir(root: string): string {
  return path.join(resolveBuildOutputDir(root), "workers", "default");
}

export function resolveBuildOutputDefaultWorkerConfigPath(root: string): string {
  return path.join(resolveBuildOutputDefaultWorkerDir(root), "worker.config.json");
}
