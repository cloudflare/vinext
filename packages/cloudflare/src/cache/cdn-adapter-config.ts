import fs from "node:fs/promises";
import path from "node:path";

const CACHED_RESPONSE_STAGE_EXPORT = "VinextCachedResponse";
const UNCACHED_RESPONSE_STAGE_EXPORT = "VinextUncachedResponse";
const CTX_EXPORTS_DEFAULT_DATE = "2025-11-17";

type WranglerWorkerExport = {
  cache?: { enabled: boolean };
  type?: string;
  [key: string]: unknown;
};

type WranglerOutputConfig = {
  compatibility_date?: string;
  compatibility_flags?: string[];
  exports?: Record<string, WranglerWorkerExport>;
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
    return { ...config, version_metadata: { binding: options.binding } };
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

  return { ...config, version_metadata: { binding: options.binding } };
}

/** Add the per-entrypoint Workers Cache policy to an emitted Wrangler config. */
export function configureWorkersCacheEntrypoints(
  config: WranglerOutputConfig,
): WranglerOutputConfig {
  const configuredExports = config.exports ?? {};
  const compatibilityFlags = config.compatibility_flags ?? [];
  if (compatibilityFlags.includes("disable_ctx_exports")) {
    throw new Error(
      "[vinext] cdnAdapter() requires ctx.exports, but the generated Wrangler config explicitly disables it with disable_ctx_exports.",
    );
  }

  const requiresCtxExportsFlag =
    config.compatibility_date === undefined || config.compatibility_date < CTX_EXPORTS_DEFAULT_DATE;
  const configuredCompatibilityFlags = requiresCtxExportsFlag
    ? compatibilityFlags.includes("enable_ctx_exports")
      ? compatibilityFlags
      : [...compatibilityFlags, "enable_ctx_exports"]
    : compatibilityFlags.filter((flag) => flag !== "enable_ctx_exports");

  for (const name of ["default", CACHED_RESPONSE_STAGE_EXPORT, UNCACHED_RESPONSE_STAGE_EXPORT]) {
    const existing = configuredExports[name];
    if (existing?.type !== undefined && existing.type !== "worker") {
      throw new Error(
        `[vinext] cdnAdapter() cannot configure the reserved Worker export ${JSON.stringify(name)} because it is already declared as ${JSON.stringify(existing.type)}.`,
      );
    }
  }

  return {
    ...config,
    compatibility_flags: configuredCompatibilityFlags,
    exports: {
      ...configuredExports,
      default: {
        ...configuredExports.default,
        type: "worker",
        cache: { enabled: false },
      },
      [CACHED_RESPONSE_STAGE_EXPORT]: {
        ...configuredExports[CACHED_RESPONSE_STAGE_EXPORT],
        type: "worker",
        cache: { enabled: true },
      },
      [UNCACHED_RESPONSE_STAGE_EXPORT]: {
        ...configuredExports[UNCACHED_RESPONSE_STAGE_EXPORT],
        type: "worker",
        cache: { enabled: false },
      },
    },
  };
}

async function readGeneratedConfig(
  generatedConfigPath: string,
  allowMissing: boolean,
): Promise<WranglerOutputConfig | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(generatedConfigPath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new TypeError("the root value must be an object");
    return parsed;
  } catch (cause) {
    if (
      allowMissing &&
      cause !== null &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return null;
    }
    throw new Error(
      `[vinext] Could not read the generated Wrangler config at ${generatedConfigPath}.`,
      { cause },
    );
  }
}

async function writeGeneratedConfig(
  generatedConfigPath: string,
  config: WranglerOutputConfig,
): Promise<void> {
  await fs.writeFile(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

/** Apply the complete CDN adapter policy to the primary generated config. */
export async function finalizeCdnAdapterBuildOutput({
  outDir,
  isPrimaryServerOutput,
  binding,
  bindingIsExplicit,
}: {
  outDir: string;
  isPrimaryServerOutput: boolean;
  binding: string;
  bindingIsExplicit: boolean;
}): Promise<void> {
  if (!isPrimaryServerOutput) return;

  const generatedConfigPath = path.resolve(outDir, "wrangler.json");
  const generatedConfig = await readGeneratedConfig(generatedConfigPath, false);
  if (!generatedConfig) return;
  const withVersionMetadata = configureCdnVersionMetadata(generatedConfig, {
    binding,
    bindingIsExplicit,
  });
  await writeGeneratedConfig(
    generatedConfigPath,
    configureWorkersCacheEntrypoints(withVersionMetadata),
  );
}
