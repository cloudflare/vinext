import fs from "node:fs/promises";
import path from "node:path";

const RESPONSE_STAGE_EXPORT = "VinextCachedResponse";
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
  [key: string]: unknown;
};

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

  // Workerd rejects enable_ctx_exports once the feature is already enabled by
  // the compatibility date. Add it only for older output configs, and remove
  // a now-redundant flag when an app has advanced its date.
  const requiresCtxExportsFlag =
    config.compatibility_date === undefined || config.compatibility_date < CTX_EXPORTS_DEFAULT_DATE;
  const configuredCompatibilityFlags = requiresCtxExportsFlag
    ? compatibilityFlags.includes("enable_ctx_exports")
      ? compatibilityFlags
      : [...compatibilityFlags, "enable_ctx_exports"]
    : compatibilityFlags.filter((flag) => flag !== "enable_ctx_exports");
  for (const name of ["default", RESPONSE_STAGE_EXPORT]) {
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
      [RESPONSE_STAGE_EXPORT]: {
        ...configuredExports[RESPONSE_STAGE_EXPORT],
        type: "worker",
        cache: { enabled: true },
      },
    },
  };
}

/** Finalize the Cloudflare Vite plugin's generated deployment config. */
export async function finalizeWorkersCacheBuildOutput({
  outDir,
}: {
  outDir: string;
  root: string;
}): Promise<void> {
  const configPath = path.join(outDir, "wrangler.json");
  let source: string;
  try {
    source = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const configured = configureWorkersCacheEntrypoints(JSON.parse(source) as WranglerOutputConfig);
  await fs.writeFile(configPath, `${JSON.stringify(configured)}\n`);
}
