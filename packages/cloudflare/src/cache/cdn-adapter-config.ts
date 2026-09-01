import fs from "node:fs/promises";
import path from "node:path";

type WranglerOutputConfig = {
  version_metadata?: unknown;
  [key: string]: unknown;
};

type VersionMetadataOptions = {
  binding: string;
  bindingIsExplicit: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function configureCdnVersionMetadata(
  config: WranglerOutputConfig,
  options: VersionMetadataOptions,
): WranglerOutputConfig {
  if (!Object.hasOwn(config, "version_metadata")) {
    return {
      ...config,
      version_metadata: { binding: options.binding },
    };
  }

  if (!isRecord(config.version_metadata)) {
    throw new Error(
      "[vinext] The generated Wrangler config has an invalid version_metadata value.",
    );
  }

  const existingBinding = config.version_metadata.binding;
  if (typeof existingBinding !== "string" || existingBinding.length === 0) {
    throw new Error(
      "[vinext] The generated Wrangler config has an invalid version_metadata.binding value.",
    );
  }
  if (existingBinding === options.binding) return config;

  if (!options.bindingIsExplicit) {
    throw new Error(
      `[vinext] cdnAdapter() uses the default version metadata binding ${JSON.stringify(options.binding)}, but the generated Wrangler config already declares ${JSON.stringify(existingBinding)}. Align the Wrangler binding or configure cdnAdapter({ versionMetadataBinding: ${JSON.stringify(existingBinding)} }).`,
    );
  }

  return {
    ...config,
    version_metadata: { binding: options.binding },
  };
}

type DeployRedirect = {
  configPath?: unknown;
};

/**
 * Add the CDN adapter's version metadata binding to the Cloudflare Vite
 * plugin's primary generated deployment config.
 */
export async function finalizeCdnAdapterBuildOutput({
  root,
  outDir,
  binding,
  bindingIsExplicit,
}: {
  root: string;
  outDir: string;
  binding: string;
  bindingIsExplicit: boolean;
}): Promise<void> {
  const redirectPath = path.join(root, ".wrangler", "deploy", "config.json");
  let redirectSource: string;
  try {
    redirectSource = await fs.readFile(redirectPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  let redirect: DeployRedirect;
  try {
    redirect = JSON.parse(redirectSource) as DeployRedirect;
  } catch (cause) {
    throw new Error(`[vinext] Could not parse ${redirectPath}.`, { cause });
  }
  if (typeof redirect.configPath !== "string" || redirect.configPath.length === 0) {
    throw new Error(`[vinext] ${redirectPath} does not identify a generated Wrangler config.`);
  }

  const generatedConfigPath = path.resolve(path.dirname(redirectPath), redirect.configPath);
  const currentOutputConfigPath = path.resolve(outDir, "wrangler.json");
  if (generatedConfigPath !== currentOutputConfigPath) return;

  let generatedConfig: WranglerOutputConfig;
  try {
    const parsed = JSON.parse(await fs.readFile(generatedConfigPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new TypeError("the root value must be an object");
    }
    generatedConfig = parsed;
  } catch (cause) {
    throw new Error(
      `[vinext] Could not read the generated Wrangler config at ${generatedConfigPath}.`,
      { cause },
    );
  }

  const configured = configureCdnVersionMetadata(generatedConfig, {
    binding,
    bindingIsExplicit,
  });
  if (configured === generatedConfig) return;
  await fs.writeFile(generatedConfigPath, `${JSON.stringify(configured, null, 2)}\n`);
}
