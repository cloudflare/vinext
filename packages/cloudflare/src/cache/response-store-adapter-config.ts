import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const RESPONSE_STORE_SERVICE_CONFIG = "vinext-response-store/wrangler.json";

const RESPONSE_STORE_BINDING = "RESPONSE_STORE";
const VERSION_METADATA_BINDING = "CF_VERSION_METADATA";
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

/** Emit the service Worker and connect the application Worker to it. */
export async function finalizeResponseStoreBuildOutput({
  outDir,
  isPrimaryServerOutput,
  serviceName: configuredServiceName,
  r2BucketName,
  deployService = true,
}: {
  outDir: string;
  isPrimaryServerOutput: boolean;
  serviceName?: string;
  r2BucketName?: string;
  deployService?: boolean;
}): Promise<void> {
  if (!isPrimaryServerOutput) return;

  const appConfigPath = path.resolve(outDir, "wrangler.json");
  let appConfig: WranglerOutputConfig;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(appConfigPath, "utf8"));
    if (!isRecord(parsed)) throw new TypeError("the root value must be an object");
    appConfig = parsed;
  } catch (cause) {
    throw new Error(`[vinext] Could not read the generated Wrangler config at ${appConfigPath}.`, {
      cause,
    });
  }

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
  if (deployService) {
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
        { binding: "CACHE_BODIES", ...(r2BucketName ? { bucket_name: r2BucketName } : {}) },
      ],
      durable_objects: {
        bindings: [{ name: "CACHE_METADATA", class_name: "CacheMetadata" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["CacheMetadata"] }],
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
