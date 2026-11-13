import fs from "node:fs";
import path from "node:path";

// Matches the version directories @cloudflare/build-output-utils detects.
const VERSION_DIRECTORY_PATTERN = /^v(0|[1-9]\d*)$/;
const SUPPORTED_VERSIONS = ["v0", "v1"];

/**
 * Resolve the versioned Build Output directory in `.cloudflare/output/`, such
 * as `v0` or `v1`. Falls back to `v0` when none exists so callers keep
 * reporting their own missing-build errors. Like cf's Build Output reader,
 * output in more than one version, an unsupported version, or linked output is
 * rejected, so deploys never read or write through it.
 */
export function resolveBuildOutputDir(root: string): string {
  const outputDir = path.join(root, ".cloudflare", "output");
  for (const directory of [path.dirname(outputDir), outputDir]) {
    if (fs.lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Cloudflare Build Output must not be linked, but ${directory} is a symlink.`);
    }
  }
  const versions = fs.statSync(outputDir, { throwIfNoEntry: false })?.isDirectory()
    ? fs
        .readdirSync(outputDir, { withFileTypes: true })
        .filter(
          (entry) =>
            (entry.isDirectory() || entry.isSymbolicLink()) &&
            VERSION_DIRECTORY_PATTERN.test(entry.name),
        )
        .sort((a, b) => Number(a.name.slice(1)) - Number(b.name.slice(1)))
    : [];
  if (versions.length > 1) {
    throw new Error(
      `Found Cloudflare Build Output in more than one format (${versions.map((entry) => entry.name).join(", ")}) in ${outputDir}. Delete ${outputDir} and rebuild.`,
    );
  }
  const version = versions[0];
  if (!version) return path.join(outputDir, "v0");
  const versionDir = path.join(outputDir, version.name);
  if (version.isSymbolicLink()) {
    throw new Error(`Cloudflare Build Output must not be linked, but ${versionDir} is a symlink.`);
  }
  if (!SUPPORTED_VERSIONS.includes(version.name)) {
    throw new Error(
      `This Cloudflare Build Output uses format ${version.name}, but vinext supports ${SUPPORTED_VERSIONS.join(" and ")}. Upgrade @vinext/cloudflare.`,
    );
  }
  return versionDir;
}

export function resolveBuildOutputDefaultWorkerDir(root: string): string {
  return path.join(resolveBuildOutputDir(root), "workers", "default");
}

export function resolveBuildOutputDefaultWorkerConfigPath(root: string): string {
  return path.join(resolveBuildOutputDefaultWorkerDir(root), "worker.config.json");
}
