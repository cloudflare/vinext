/**
 * Resolves the Worker name, production hosts, and version metadata binding
 * that CDN warmup needs to target a deploy, on top of the raw fields
 * `parseWranglerConfig` reads out of wrangler.jsonc/.toml.
 *
 * The env fallback and legacy_env Worker-name suffixing here are CDN-warmup
 * resolution rules, not generic Wrangler config fields — they layer on the
 * raw projection `wrangler-config.ts` owns.
 */

import type { WranglerTargetOptions } from "./wrangler-cli.js";
import {
  parseWranglerConfig,
  type WranglerCacheConfig,
  type WranglerConfig,
} from "./wrangler-config.js";

export type WranglerDeploymentTarget = {
  cacheEnabled?: boolean;
  crossVersionCache?: boolean;
  hasProductionRoute: boolean;
  workerName?: string;
  /**
   * Every host-wide origin (route or Custom Domain) attached to the Worker.
   * The hostname is part of Cloudflare's cache key, so each entry is its own
   * cache partition and warmup must cover all of them.
   */
  productionHosts: readonly string[];
  /** Whether the production `<name>.<subdomain>.workers.dev` origin is enabled. */
  workersDevEnabled: boolean;
  /**
   * True when some enabled route could not be reduced to a concrete host-wide
   * origin (path-scoped or wildcard-host patterns). Its cache partition is
   * unreachable to warmup, so `productionHosts` is an incomplete picture of
   * the production cache surface and no "confirmed warm" claim may be made.
   */
  hasUnwarmableProductionRoute: boolean;
  versionMetadataBinding?: string;
};

export function getWranglerTargetEnv(
  options: Pick<WranglerTargetOptions, "preview" | "env">,
): string | undefined {
  return options.env || (options.preview ? "preview" : undefined);
}

export function resolveWranglerDeploymentTarget(
  root: string,
  options: WranglerTargetOptions,
): WranglerDeploymentTarget | null {
  const config = parseWranglerConfig(root, options.config);
  if (!config) return null;
  const envName = getWranglerTargetEnv(options);
  const flattenedEnvConfig = Boolean(
    envName && !config.env?.[envName] && config.targetEnvironment === envName,
  );
  const envConfig = envName ? config.env?.[envName] : undefined;
  const selected = envConfig ?? (!envName || flattenedEnvConfig ? config : undefined);
  // Wrangler resolves `route`/`routes` as inheritable keys: an environment
  // block that defines no routing key deploys with the top-level attachments.
  // Warmup must target those inherited hosts — treating the env as route-less
  // would fall back to the staged workers.dev URL, a different cache key, and
  // could confirm a warmup for a partition production traffic never reads.
  const routing = envConfig && !envConfig.definesRoutes ? config : selected;
  const cache = resolveCacheConfig(config, envName, flattenedEnvConfig);
  const workersDev = selected?.workersDev ?? (envName ? config.workersDev : undefined);
  const hasProductionRoute = Boolean(routing?.customDomain);
  return {
    cacheEnabled: cache?.enabled,
    crossVersionCache: cache?.crossVersionCache,
    hasProductionRoute,
    workerName: resolveWorkerName(config, envName, flattenedEnvConfig, options.name),
    productionHosts: routing?.warmupHosts ?? [],
    // Wrangler enables workers.dev by default only when no routes are
    // configured. An explicit true keeps it enabled alongside custom routes,
    // giving that hostname its own cache partition that warmup must cover.
    workersDevEnabled: workersDev ?? !hasProductionRoute,
    hasUnwarmableProductionRoute: Boolean(routing?.hasUnwarmableRoute),
    versionMetadataBinding: selected?.versionMetadataBinding,
  };
}

/** Wrangler inherits the whole cache object only when an env omits it. */
function resolveCacheConfig(
  config: WranglerConfig,
  envName: string | undefined,
  flattenedEnvConfig: boolean,
): WranglerCacheConfig | undefined {
  if (!envName || flattenedEnvConfig) return config.cache;
  return config.env?.[envName]?.cache ?? config.cache;
}

function resolveWorkerName(
  config: WranglerConfig,
  envName: string | undefined,
  flattenedEnvConfig: boolean,
  explicitName: string | undefined,
): string | undefined {
  if (explicitName) return explicitName;
  if (!envName) return config.name;
  // Service environments (legacy_env: false) address the top-level service
  // name. Wrangler resolves `name` through inheritableInWranglerEnvironments,
  // which rejects an env-local `name` there and returns the top-level one
  // anyway — so the version override must target that name, not the env's.
  if (config.legacyEnv === false) return config.name;
  const explicitEnvName = config.env?.[envName]?.name;
  if (explicitEnvName) return explicitEnvName;
  if (flattenedEnvConfig) return config.name;
  if (!config.name) return undefined;
  return `${config.name}-${envName}`;
}
