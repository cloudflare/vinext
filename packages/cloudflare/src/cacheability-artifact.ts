import fs from "node:fs";
import path from "node:path";
import {
  CACHEABILITY_MANIFEST_MODULE_FILE,
  CACHEABILITY_MANIFEST_PLACEHOLDER,
  type CacheabilityManifest,
} from "vinext/internal/server/cacheability-manifest";

type WranglerArtifactConfig = Record<string, unknown> & {
  base_dir?: unknown;
  main?: unknown;
  rules?: unknown[];
};

type WranglerModuleRule = { globs?: unknown; type?: unknown };

function readGeneratedWranglerConfig(configPath: string): WranglerArtifactConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (error) {
    throw new Error(
      `Two-stage CDN warming requires a generated JSON Wrangler config at ${configPath}. Rebuild the app before deploying.`,
      { cause: error },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Generated Wrangler config at ${configPath} must contain a JSON object.`);
  }
  return parsed as WranglerArtifactConfig;
}

function resolveManifestArtifact(
  configPath: string,
  config: WranglerArtifactConfig,
): { filePath: string; ruleGlob: string } {
  if (typeof config.main !== "string" || config.main.length === 0) {
    throw new Error("Generated Wrangler config must identify its main Worker module.");
  }
  const configDirectory = path.dirname(configPath);
  const mainPath = path.resolve(configDirectory, config.main);
  const filePath = path.join(path.dirname(mainPath), CACHEABILITY_MANIFEST_MODULE_FILE);
  const baseDirectory =
    typeof config.base_dir === "string"
      ? path.resolve(configDirectory, config.base_dir)
      : path.dirname(mainPath);
  const ruleGlob = path.relative(baseDirectory, filePath).split(path.sep).join("/");
  if (ruleGlob.startsWith("../") || path.isAbsolute(ruleGlob)) {
    throw new Error(
      "Generated Wrangler config base_dir must contain the cacheability manifest module.",
    );
  }
  return { filePath, ruleGlob };
}

function isManifestRule(rule: unknown, ruleGlob: string): boolean {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false;
  const candidate = rule as WranglerModuleRule;
  return (
    candidate.type === "Text" &&
    Array.isArray(candidate.globs) &&
    candidate.globs.includes(ruleGlob)
  );
}

/** Verify that the selected build was produced with the manifest-module seam. */
export function assertCacheabilityManifestArtifact(configPath: string): void {
  const config = readGeneratedWranglerConfig(configPath);
  if (!Array.isArray(config.rules)) {
    throw new Error("Generated Wrangler config must contain module rules.");
  }
  const manifestArtifact = resolveManifestArtifact(configPath, config);
  if (!config.rules.some((rule) => isManifestRule(rule, manifestArtifact.ruleGlob))) {
    throw new Error(
      "Generated Wrangler config does not include the cacheability Text module rule.",
    );
  }
  if (
    !fs.existsSync(manifestArtifact.filePath) ||
    fs.readFileSync(manifestArtifact.filePath, "utf-8") !== CACHEABILITY_MANIFEST_PLACEHOLDER
  ) {
    throw new Error("Generated Worker does not include the cacheability manifest placeholder.");
  }
}

/**
 * Attach a version-specific cacheability manifest to an isolated copy of the
 * generated Worker through its reserved imported text module. The probe upload
 * receives the non-manifest placeholder; only the final version receives data.
 */
export function withEmbeddedCacheabilityManifest<T>(
  root: string,
  configuredPath: string | undefined,
  manifest: CacheabilityManifest | null,
  upload: (configPath: string) => T,
): T {
  const distDirectory = path.join(root, "dist");
  const configPath = path.resolve(root, configuredPath ?? "dist/server/wrangler.json");
  const relativeConfigPath = path.relative(distDirectory, configPath);
  if (relativeConfigPath.startsWith("..") || path.isAbsolute(relativeConfigPath)) {
    throw new Error(
      "Two-stage CDN warming requires the generated Wrangler config under dist/. Pass --config dist/server/wrangler.json (or another generated dist config).",
    );
  }
  const serverDirectory = path.dirname(configPath);
  const isolatedParent = serverDirectory === distDirectory ? root : distDirectory;
  const isolatedServerDirectory = fs.mkdtempSync(
    path.join(isolatedParent, ".vinext-cacheability-"),
  );

  try {
    fs.cpSync(serverDirectory, isolatedServerDirectory, { recursive: true });
    const isolatedConfigPath = path.join(isolatedServerDirectory, path.basename(configPath));
    const config = readGeneratedWranglerConfig(isolatedConfigPath);
    if (config.rules !== undefined && !Array.isArray(config.rules)) {
      throw new Error("Generated Wrangler config rules must be an array.");
    }

    const manifestArtifact = resolveManifestArtifact(isolatedConfigPath, config);

    fs.writeFileSync(
      manifestArtifact.filePath,
      manifest === null ? CACHEABILITY_MANIFEST_PLACEHOLDER : JSON.stringify(manifest),
    );
    if (!(config.rules ?? []).some((rule) => isManifestRule(rule, manifestArtifact.ruleGlob))) {
      config.rules = [
        ...(config.rules ?? []),
        { fallthrough: true, globs: [manifestArtifact.ruleGlob], type: "Text" },
      ];
    }
    fs.writeFileSync(isolatedConfigPath, `${JSON.stringify(config, null, 2)}\n`);

    return upload(path.relative(root, isolatedConfigPath));
  } finally {
    fs.rmSync(isolatedServerDirectory, { recursive: true, force: true });
  }
}
