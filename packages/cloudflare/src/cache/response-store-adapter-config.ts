import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const RESPONSE_STORE_SERVICE_CONFIG = "vinext-response-store/wrangler.json";

const RESPONSE_STORE_BINDING = "RESPONSE_STORE";
const VERSION_METADATA_BINDING = "CF_VERSION_METADATA";
const CACHE_BODIES_BINDING = "CACHE_BODIES";
const CACHE_METADATA_BINDING = "CACHE_METADATA";
const CACHE_METADATA_CLASS = "CacheMetadata";
const CTX_EXPORTS_DEFAULT_DATE = "2025-11-17";

type WranglerOutputConfig = Record<string, unknown> & {
  compatibility_date?: string;
  compatibility_flags?: string[];
  exports?: Record<string, Record<string, unknown>>;
  name?: string;
  services?: Array<Record<string, unknown>>;
  version_metadata?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withCtxExports(config: WranglerOutputConfig): WranglerOutputConfig {
  const flags = config.compatibility_flags ?? [];
  if (flags.includes("disable_ctx_exports")) {
    throw new Error(
      "[vinext] responseStoreAdapter() requires ctx.exports, but the generated Wrangler config explicitly disables it.",
    );
  }
  if (
    config.compatibility_date !== undefined &&
    config.compatibility_date >= CTX_EXPORTS_DEFAULT_DATE
  ) {
    return config;
  }
  return {
    ...config,
    compatibility_flags: flags.includes("enable_ctx_exports")
      ? flags
      : [...flags, "enable_ctx_exports"],
  };
}

async function readAppConfig(outDir: string): Promise<{
  appConfig: WranglerOutputConfig;
  appConfigPath: string;
}> {
  const appConfigPath = path.resolve(outDir, "wrangler.json");
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(appConfigPath, "utf8"));
    if (!isRecord(parsed)) throw new TypeError("the root value must be an object");
    return { appConfig: parsed, appConfigPath };
  } catch (cause) {
    throw new Error(`[vinext] Could not read the generated Wrangler config at ${appConfigPath}.`, {
      cause,
    });
  }
}

function assertResponseStoreAppConfig(
  appConfig: WranglerOutputConfig,
): asserts appConfig is WranglerOutputConfig & { name: string; compatibility_date: string } {
  if (!appConfig.name || !appConfig.compatibility_date) {
    throw new Error(
      "[vinext] responseStoreAdapter() requires the generated Wrangler config to contain a Worker name and compatibility date.",
    );
  }
  if (
    appConfig.version_metadata !== undefined &&
    (!isRecord(appConfig.version_metadata) ||
      appConfig.version_metadata.binding !== VERSION_METADATA_BINDING)
  ) {
    throw new Error(
      `[vinext] responseStoreAdapter() requires version_metadata.binding to be ${JSON.stringify(VERSION_METADATA_BINDING)}.`,
    );
  }
}

/** Emit the service Worker and connect the application Worker to it. */
export async function finalizeResponseStoreBuildOutput({
  outDir,
  isPrimaryServerOutput,
  serviceName: configuredServiceName,
  r2BucketName,
  shouldDeployService = true,
}: {
  outDir: string;
  isPrimaryServerOutput: boolean;
  serviceName?: string;
  r2BucketName?: string;
  shouldDeployService?: boolean;
}): Promise<void> {
  if (!isPrimaryServerOutput) return;

  const { appConfig, appConfigPath } = await readAppConfig(outDir);
  assertResponseStoreAppConfig(appConfig);
  if (appConfig.services !== undefined && !Array.isArray(appConfig.services)) {
    throw new Error("[vinext] The generated Wrangler config has an invalid services value.");
  }

  const serviceSuffix = "-response-store";
  const fullServiceName = `${appConfig.name}${serviceSuffix}`;
  const serviceName =
    configuredServiceName ??
    (fullServiceName.length <= 49
      ? fullServiceName
      : `${appConfig.name.slice(0, 25)}-${createHash("sha256").update(appConfig.name).digest("hex").slice(0, 8)}${serviceSuffix}`);
  const serviceDir = path.resolve(outDir, path.dirname(RESPONSE_STORE_SERVICE_CONFIG));
  if (shouldDeployService) {
    if (!r2BucketName && serviceName.length > 49) {
      throw new Error(
        "[vinext] A Response Store serviceName longer than 49 characters requires an explicit r2BucketName.",
      );
    }
    const packageDir = path.dirname(
      fileURLToPath(import.meta.resolve("@cloudflare/workers-response-store/service")),
    );
    await fs.rm(serviceDir, { recursive: true, force: true });
    await fs.mkdir(serviceDir, { recursive: true });
    for (const file of await fs.readdir(packageDir)) {
      if (file.endsWith(".js")) {
        await fs.copyFile(path.join(packageDir, file), path.join(serviceDir, file));
      }
    }

    const serviceConfig = withCtxExports({
      $schema:
        "https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/wrangler/config-schema.json",
      name: serviceName,
      main: "service.js",
      compatibility_date: appConfig.compatibility_date,
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      preview_urls: false,
      cache: { enabled: true },
      exports: {
        default: { type: "worker", cache: { enabled: false } },
        ResponseStoreBinding: { type: "worker", cache: { enabled: true } },
      },
      r2_buckets: [
        { binding: CACHE_BODIES_BINDING, ...(r2BucketName ? { bucket_name: r2BucketName } : {}) },
      ],
      durable_objects: {
        bindings: [{ name: CACHE_METADATA_BINDING, class_name: CACHE_METADATA_CLASS }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: [CACHE_METADATA_CLASS] }],
      ...(typeof appConfig.account_id === "string" ? { account_id: appConfig.account_id } : {}),
    });
    await fs.writeFile(
      path.resolve(outDir, RESPONSE_STORE_SERVICE_CONFIG),
      `${JSON.stringify(serviceConfig, null, 2)}\n`,
    );
  } else {
    await fs.rm(serviceDir, { recursive: true, force: true });
  }

  const existingCache = appConfig.cache;
  if (existingCache !== undefined && !isRecord(existingCache)) {
    throw new Error("[vinext] The generated Wrangler config has an invalid cache value.");
  }
  const configuredApp = withCtxExports({
    ...appConfig,
    cache: { ...existingCache, enabled: false },
    version_metadata: { binding: VERSION_METADATA_BINDING },
    services: [
      ...(appConfig.services ?? []).filter((service) => service.binding !== RESPONSE_STORE_BINDING),
      {
        binding: RESPONSE_STORE_BINDING,
        service: serviceName,
        entrypoint: "ResponseStoreService",
      },
    ],
    exports: {
      ...appConfig.exports,
      default: { ...appConfig.exports?.default, type: "worker", cache: { enabled: false } },
    },
  });
  await fs.writeFile(appConfigPath, `${JSON.stringify(configuredApp, null, 2)}\n`);
}

/** Add Response Store resources to a self-contained application Worker. */
export async function finalizeSelfContainedResponseStoreBuildOutput({
  outDir,
  isPrimaryServerOutput,
}: {
  outDir: string;
  isPrimaryServerOutput: boolean;
}): Promise<void> {
  if (!isPrimaryServerOutput) return;

  const { appConfig, appConfigPath } = await readAppConfig(outDir);
  assertResponseStoreAppConfig(appConfig);

  const cache = appConfig.cache;
  const r2Buckets = appConfig.r2_buckets;
  const durableObjects = appConfig.durable_objects;
  const migrations = appConfig.migrations;
  if (cache !== undefined && !isRecord(cache)) {
    throw new Error("[vinext] The generated Wrangler config has an invalid cache value.");
  }
  if (r2Buckets !== undefined && !Array.isArray(r2Buckets)) {
    throw new Error("[vinext] The generated Wrangler config has an invalid r2_buckets value.");
  }
  if (durableObjects !== undefined && !isRecord(durableObjects)) {
    throw new Error("[vinext] The generated Wrangler config has an invalid durable_objects value.");
  }
  const durableBindings = durableObjects?.bindings;
  if (durableBindings !== undefined && !Array.isArray(durableBindings)) {
    throw new Error(
      "[vinext] The generated Wrangler config has an invalid durable_objects.bindings value.",
    );
  }
  if (migrations !== undefined && !Array.isArray(migrations)) {
    throw new Error("[vinext] The generated Wrangler config has an invalid migrations value.");
  }

  if (
    (r2Buckets ?? []).some((value) => !isRecord(value)) ||
    (durableBindings ?? []).some((value) => !isRecord(value)) ||
    (migrations ?? []).some((value) => !isRecord(value))
  ) {
    throw new Error("[vinext] The generated Wrangler config contains an invalid binding.");
  }
  const existingR2Buckets = (r2Buckets ?? []) as Record<string, unknown>[];
  const existingDurableBindings = (durableBindings ?? []) as Record<string, unknown>[];
  const existingCacheMetadataBinding = existingDurableBindings.find(
    (binding) => binding.name === CACHE_METADATA_BINDING,
  );
  if (
    existingCacheMetadataBinding &&
    (existingCacheMetadataBinding.class_name !== CACHE_METADATA_CLASS ||
      existingCacheMetadataBinding.script_name !== undefined)
  ) {
    throw new Error(
      `[vinext] responseStoreAdapter() cannot use the existing ${CACHE_METADATA_BINDING} Durable Object binding.`,
    );
  }
  const existingMigrations = (migrations ?? []) as Record<string, unknown>[];
  const hasCacheMetadataMigration = existingMigrations.some(
    (migration) =>
      Array.isArray(migration.new_sqlite_classes) &&
      migration.new_sqlite_classes.includes(CACHE_METADATA_CLASS),
  );
  let migrationNumber = existingMigrations.length + 1;
  while (
    existingMigrations.some(
      (migration) => migration.tag === `vinext-response-store-v${migrationNumber}`,
    )
  ) {
    migrationNumber++;
  }
  const configuredApp = withCtxExports({
    ...appConfig,
    cache: { ...cache, enabled: true },
    version_metadata: { binding: VERSION_METADATA_BINDING },
    r2_buckets: existingR2Buckets.some((binding) => binding.binding === CACHE_BODIES_BINDING)
      ? existingR2Buckets
      : [...existingR2Buckets, { binding: CACHE_BODIES_BINDING }],
    durable_objects: {
      ...durableObjects,
      bindings: existingCacheMetadataBinding
        ? existingDurableBindings
        : [
            ...existingDurableBindings,
            { name: CACHE_METADATA_BINDING, class_name: CACHE_METADATA_CLASS },
          ],
    },
    migrations: hasCacheMetadataMigration
      ? existingMigrations
      : [
          ...existingMigrations,
          {
            tag: `vinext-response-store-v${migrationNumber}`,
            new_sqlite_classes: [CACHE_METADATA_CLASS],
          },
        ],
    exports: {
      ...appConfig.exports,
      default: { ...appConfig.exports?.default, type: "worker", cache: { enabled: false } },
      ResponseStoreBinding: {
        ...appConfig.exports?.ResponseStoreBinding,
        type: "worker",
        cache: { enabled: true },
      },
    },
  });
  await fs.writeFile(appConfigPath, `${JSON.stringify(configuredApp, null, 2)}\n`);
}
