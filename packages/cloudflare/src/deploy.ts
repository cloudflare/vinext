/**
 * vinext-cloudflare deploy — one-command Cloudflare Workers deployment.
 *
 * Takes any Next.js app and deploys it to Cloudflare Workers:
 *
 *   1. Validates the project was prepared by `vinext init --platform=cloudflare`
 *   2. Runs the Vite build
 *   3. Deploys to Cloudflare Workers via Wrangler
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, type SpawnOptions } from "node:child_process";
import { parseArgs as nodeParseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_REMOTE_PATH_DISCOVERY_PHASE_TIMEOUT_MS,
  DEFAULT_REMOTE_PATH_DISCOVERY_RETRY_DELAY_MS,
  emitPrerenderPathManifest,
} from "vinext/internal/build/prerender-paths";
import { runPrerender } from "vinext/internal/build/run-prerender";
import { loadDotenv } from "vinext/internal/config/dotenv";
import {
  findVinextNextConfigInPlugins,
  loadNextConfig,
  resolveNextConfig,
  resolveNextConfigInput,
  type NextConfigInput,
} from "vinext/internal/config/next-config";
import {
  findVinextCacheConfigInPlugins,
  findVinextPrerenderConfigInPlugins,
  findVinextRouteRootConfigInPlugins,
  formatVinextPrerenderLabel,
  hasBuildIdentityResponseHeader,
  hasVerbatimResponseVary,
  requiresRouteCacheabilityProbeManifest,
  resolveVinextPrerenderDecision,
  type ResolvedVinextPrerenderConfig,
  type VinextCacheConfig,
  type VinextRouteRootConfig,
} from "vinext/internal/config/prerender";
import {
  detectProject,
  findInNodeModules,
  formatMissingCloudflarePluginError,
  getMissingDeps,
  type ProjectInfo,
} from "vinext/internal/utils/project";
import { parseWranglerConfig, runTPR } from "./tpr.js";
import { VINEXT_EXPECTED_WORKER_VERSION_HEADER } from "./version-headers.js";
import {
  createCdnWarmTargets,
  CdnOperationProgress,
  readPrerenderWarmPlan,
  waitForCdnWarmTargetReadiness,
  warmCdnCache,
  type CdnWarmOptions,
  type CdnWarmRequestPlan,
  type CdnWarmTarget,
  type PrerenderWarmPlan,
} from "./cdn-warm.js";
import {
  formatMissingCacheAdapterError,
  formatImageOptimizationHint,
  resolveCdnAdapterConfig,
  resolveKvDataAdapterConfig,
  viteConfigHasCacheAdapter,
  viteConfigHasCloudflarePlugin,
  viteConfigHasImageAdapter,
  workerEntryHasCacheHandler,
} from "./deploy-config.js";
import { assertCdnVersionMetadataConfig } from "./wrangler-version-metadata.js";
import {
  runWranglerDeploymentStatus,
  runWranglerTriggersDeploy,
  runWranglerVersionDeploy,
  runWranglerVersionUpload,
  type WranglerDeploymentStatus,
  type WranglerVersionUploadResult,
  type WranglerVersionTraffic,
} from "./version-deploy.js";
import { parseWorkerDeploymentUrl } from "./worker-deployment-url.js";
import { PHASE_PRODUCTION_BUILD } from "vinext/shims/constants";
import { cacheabilityRoutePathname } from "vinext/internal/server/cacheability-manifest";
import { buildPrerenderKVPairs, type KVBulkPair } from "./prerender-kv-populate.js";
import { writeCacheabilityManifestArtifact } from "./cacheability-artifact.js";
import {
  DEFAULT_CACHEABILITY_PROBE_PHASE_TIMEOUT_MS,
  DEFAULT_CACHEABILITY_PROBE_RETRIES,
  DEFAULT_CACHEABILITY_PROBE_RETRY_DELAY_MS,
  probeStagedWorkerCacheability,
  readPrerenderSecret,
} from "./cacheability-probe.js";

export const DEFAULT_CDN_WARM_PROMOTION_DELAY_MS = 15_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export type DeployOptions = {
  /** Project root directory */
  root: string;
  /** Deploy to preview environment (default: production) */
  preview?: boolean;
  /** Wrangler environment name from wrangler.jsonc env.<name> */
  env?: string;
  /** Custom project name for the Worker */
  name?: string;
  /** Wrangler config path, relative to root unless absolute */
  config?: string;
  /** Skip the build step (assume already built) */
  skipBuild?: boolean;
  /** Dry run — validate setup but don't build or deploy */
  dryRun?: boolean;
  /** Print raw output from internal Wrangler commands. */
  verbose?: boolean;
  /** Pre-render all discovered routes into the dist output after building */
  prerenderAll?: boolean;
  /** Maximum number of routes to prerender in parallel */
  prerenderConcurrency?: number;
  /** Warm Cloudflare's CDN cache by requesting build-discovered paths for the uploaded version */
  warmCdnCache?: boolean;
  /** Explicit production origin to use for CDN discovery, probing, and warming */
  warmCdnTarget?: string;
  /** Maximum number of CDN warmup requests to issue in parallel */
  warmCdnConcurrency?: number;
  /** Per-request CDN warmup timeout in milliseconds */
  warmCdnTimeout?: number;
  /** Number of CDN warmup retries for transient failures */
  warmCdnRetries?: number;
  /** Maximum duration of staged Worker path discovery */
  warmCdnDiscoveryTimeout?: number;
  /** Number of transient staged Worker path discovery retries */
  warmCdnDiscoveryRetries?: number;
  /** Abort after this duration without a completed cacheability probe */
  warmCdnProbeTimeout?: number;
  /** Number of transient staged Worker cacheability probe retries */
  warmCdnProbeRetries?: number;
  /** Re-request warmed identities and require reusable CDN hits before promotion */
  warmCdnCertify?: boolean;
  /** Maximum duration of staged Worker readiness verification */
  warmCdnReadinessTimeout?: number;
  /** Number of staged Worker readiness retries */
  warmCdnReadinessRetries?: number;
  /** Consecutive successful probes required before warming the staged Worker */
  warmCdnReadinessProbes?: number;
  /** Delay between staged Worker readiness probes in milliseconds */
  warmCdnReadinessProbeDelay?: number;
  /** Promote even when staged CDN warmup cannot be completed */
  dangerouslyPromoteOnCdnWarmError?: boolean;
  /** Promote the warmed Worker version to 100% traffic (default: true) */
  warmCdnPromote?: boolean;
  /** Delay between successful warmup and promotion in milliseconds */
  warmCdnPromotionDelay?: number;
  /** Include PPR fallback-shell placeholder paths during CDN warmup */
  warmCdnIncludeFallbacks?: boolean;
  /** Enable experimental TPR (Traffic-aware Pre-Rendering) */
  experimentalTPR?: boolean;
  /** TPR: traffic coverage percentage target (0–100, default: 90) */
  tprCoverage?: number;
  /** TPR: hard cap on number of pages to pre-render (default: 1000) */
  tprLimit?: number;
  /** TPR: analytics lookback window in hours (default: 24) */
  tprWindow?: number;
};

type ProjectViteApi = Pick<typeof import("vite"), "createBuilder" | "loadConfigFromFile">;

type ProjectWranglerApi = {
  unstable_readConfig(
    args: { config?: string; env?: string },
    options: {
      hideWarnings: true;
      preserveOriginalMain: true;
      useRedirectIfAvailable: true;
    },
  ): {
    configPath?: string;
    version_metadata?: { binding: string };
  };
};

type DeployViteConfigMetadata = {
  cacheConfig: VinextCacheConfig | null;
  nextConfig: NextConfigInput | null;
  prerenderConfig: ResolvedVinextPrerenderConfig | null;
  routeRootConfig: VinextRouteRootConfig | null;
};

function parsePositiveIntegerArg(raw: string, flag: string): number {
  if (raw === "") {
    throw new Error(`${flag} requires a value, but none was provided.`);
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer, but got "${raw}".`);
  }
  return parsed;
}

function parseNonNegativeIntegerArg(raw: string, flag: string): number {
  if (raw === "") {
    throw new Error(`${flag} requires a value, but none was provided.`);
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} expects a non-negative integer, but got "${raw}".`);
  }
  return parsed;
}

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

function validateTimerDelay(value: number, flag: string, raw = String(value)): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} expects a non-negative integer, but got "${raw}".`);
  }
  if (value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(
      `${flag} must not exceed ${MAX_NODE_TIMER_DELAY_MS} milliseconds, but got "${raw}".`,
    );
  }
  return value;
}

function validatePromotionDelay(value: number, raw = String(value)): number {
  return validateTimerDelay(value, "--warm-cdn-promotion-delay", raw);
}

function validateCdnWarmTarget(raw: string): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--warm-cdn-target expects an HTTPS origin, but got "${raw}".`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `--warm-cdn-target expects an HTTPS origin without a path, query, credentials, or port, but got "${raw}".`,
    );
  }
  return url.origin;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

// ─── CLI arg parsing (uses Node.js util.parseArgs) ──────────────────────────

/** Deploy command flag definitions for util.parseArgs. */
const deployArgOptions = {
  help: { type: "boolean", short: "h", default: false },
  preview: { type: "boolean", default: false },
  env: { type: "string" },
  name: { type: "string" },
  config: { type: "string" },
  "skip-build": { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  verbose: { type: "boolean", default: false },
  "prerender-all": { type: "boolean", default: false },
  "prerender-concurrency": { type: "string" },
  "experimental-warm-cdn-cache": { type: "boolean", default: false },
  "warm-cdn-target": { type: "string" },
  "warm-cdn-concurrency": { type: "string" },
  "warm-cdn-timeout": { type: "string" },
  "warm-cdn-retries": { type: "string" },
  "warm-cdn-discovery-timeout": { type: "string" },
  "warm-cdn-discovery-retries": { type: "string" },
  "warm-cdn-probe-timeout": { type: "string" },
  "warm-cdn-probe-retries": { type: "string" },
  "warm-cdn-certify": { type: "boolean", default: false },
  "warm-cdn-readiness-timeout": { type: "string" },
  "warm-cdn-readiness-retries": { type: "string" },
  "warm-cdn-readiness-probes": { type: "string" },
  "warm-cdn-readiness-probe-delay": { type: "string" },
  "dangerously-promote-on-cdn-warm-error": { type: "boolean", default: false },
  "warm-cdn-no-promote": { type: "boolean", default: false },
  "warm-cdn-promotion-delay": { type: "string" },
  "warm-cdn-include-fallbacks": { type: "boolean", default: false },
  "experimental-tpr": { type: "boolean", default: false },
  "tpr-coverage": { type: "string" },
  "tpr-limit": { type: "string" },
  "tpr-window": { type: "string" },
} as const;

export function parseDeployArgs(args: string[]) {
  const { values } = nodeParseArgs({ args, options: deployArgOptions, strict: true });

  if (values["warm-cdn-certify"] && !values["experimental-warm-cdn-cache"]) {
    throw new Error("--warm-cdn-certify requires --experimental-warm-cdn-cache.");
  }
  if (values["warm-cdn-target"] && !values["experimental-warm-cdn-cache"]) {
    throw new Error("--warm-cdn-target requires --experimental-warm-cdn-cache.");
  }

  function parseIntArg(name: string, raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const n = parseInt(raw, 10);
    if (isNaN(n)) {
      console.error(`  --${name} must be a number (got: ${raw})`);
      process.exit(1);
    }
    return n;
  }

  return {
    help: values.help,
    preview: values.preview,
    env: values.env?.trim() || undefined,
    name: values.name?.trim() || undefined,
    config: values.config?.trim() || undefined,
    skipBuild: values["skip-build"],
    dryRun: values["dry-run"],
    verbose: values.verbose,
    prerenderAll: values["prerender-all"],
    prerenderConcurrency:
      values["prerender-concurrency"] === undefined
        ? undefined
        : parsePositiveIntegerArg(values["prerender-concurrency"], "--prerender-concurrency"),
    warmCdnCache: values["experimental-warm-cdn-cache"],
    warmCdnTarget:
      values["warm-cdn-target"] === undefined
        ? undefined
        : validateCdnWarmTarget(values["warm-cdn-target"]),
    warmCdnConcurrency:
      values["warm-cdn-concurrency"] === undefined
        ? undefined
        : parsePositiveIntegerArg(values["warm-cdn-concurrency"], "--warm-cdn-concurrency"),
    warmCdnTimeout:
      values["warm-cdn-timeout"] === undefined
        ? undefined
        : parsePositiveIntegerArg(values["warm-cdn-timeout"], "--warm-cdn-timeout"),
    warmCdnRetries:
      values["warm-cdn-retries"] === undefined
        ? undefined
        : parseNonNegativeIntegerArg(values["warm-cdn-retries"], "--warm-cdn-retries"),
    warmCdnDiscoveryTimeout:
      values["warm-cdn-discovery-timeout"] === undefined
        ? undefined
        : parsePositiveIntegerArg(
            values["warm-cdn-discovery-timeout"],
            "--warm-cdn-discovery-timeout",
          ),
    warmCdnDiscoveryRetries:
      values["warm-cdn-discovery-retries"] === undefined
        ? undefined
        : parseNonNegativeIntegerArg(
            values["warm-cdn-discovery-retries"],
            "--warm-cdn-discovery-retries",
          ),
    warmCdnProbeTimeout:
      values["warm-cdn-probe-timeout"] === undefined
        ? undefined
        : parsePositiveIntegerArg(values["warm-cdn-probe-timeout"], "--warm-cdn-probe-timeout"),
    warmCdnProbeRetries:
      values["warm-cdn-probe-retries"] === undefined
        ? undefined
        : parseNonNegativeIntegerArg(values["warm-cdn-probe-retries"], "--warm-cdn-probe-retries"),
    warmCdnCertify: values["warm-cdn-certify"],
    warmCdnReadinessTimeout:
      values["warm-cdn-readiness-timeout"] === undefined
        ? undefined
        : parsePositiveIntegerArg(
            values["warm-cdn-readiness-timeout"],
            "--warm-cdn-readiness-timeout",
          ),
    warmCdnReadinessRetries:
      values["warm-cdn-readiness-retries"] === undefined
        ? undefined
        : parseNonNegativeIntegerArg(
            values["warm-cdn-readiness-retries"],
            "--warm-cdn-readiness-retries",
          ),
    warmCdnReadinessProbes:
      values["warm-cdn-readiness-probes"] === undefined
        ? undefined
        : parsePositiveIntegerArg(
            values["warm-cdn-readiness-probes"],
            "--warm-cdn-readiness-probes",
          ),
    warmCdnReadinessProbeDelay:
      values["warm-cdn-readiness-probe-delay"] === undefined
        ? undefined
        : validateTimerDelay(
            parseNonNegativeIntegerArg(
              values["warm-cdn-readiness-probe-delay"],
              "--warm-cdn-readiness-probe-delay",
            ),
            "--warm-cdn-readiness-probe-delay",
            values["warm-cdn-readiness-probe-delay"],
          ),
    dangerouslyPromoteOnCdnWarmError: values["dangerously-promote-on-cdn-warm-error"],
    warmCdnPromote: !values["warm-cdn-no-promote"],
    warmCdnPromotionDelay:
      values["warm-cdn-promotion-delay"] === undefined
        ? undefined
        : validatePromotionDelay(
            parseNonNegativeIntegerArg(
              values["warm-cdn-promotion-delay"],
              "--warm-cdn-promotion-delay",
            ),
            values["warm-cdn-promotion-delay"],
          ),
    warmCdnIncludeFallbacks: values["warm-cdn-include-fallbacks"],
    experimentalTPR: values["experimental-tpr"],
    tprCoverage: parseIntArg("tpr-coverage", values["tpr-coverage"]),
    tprLimit: parseIntArg("tpr-limit", values["tpr-limit"]),
    tprWindow: parseIntArg("tpr-window", values["tpr-window"]),
  };
}

// ─── Project Detection ──────────────────────────────────────────────────────

/**
 * Run a function with `process.env.CLOUDFLARE_ENV` set to the given value,
 * restoring the previous state (whether set or absent) after the function
 * resolves or throws.
 *
 * The `@cloudflare/vite-plugin` reads `CLOUDFLARE_ENV` from `process.env` to
 * drive the multi-environment merge applied to the emitted `wrangler.json`.
 * Without this propagation the `--env <name>` CLI flag is silently ignored at
 * build time and the top-level config is emitted regardless. See issue #1210.
 *
 * Passing `undefined` is a no-op; the callback runs with `process.env` untouched.
 */
export async function withCloudflareEnv<T>(
  env: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (env === undefined || env === "") {
    return fn();
  }
  const hadPrev = "CLOUDFLARE_ENV" in process.env;
  const prev = process.env.CLOUDFLARE_ENV;
  process.env.CLOUDFLARE_ENV = env;
  try {
    return await fn();
  } finally {
    if (hadPrev) {
      process.env.CLOUDFLARE_ENV = prev;
    } else {
      delete process.env.CLOUDFLARE_ENV;
    }
  }
}

async function loadProjectViteApi(root: string): Promise<ProjectViteApi> {
  // Resolve Vite from the project root so that symlinked vinext installs
  // (bun link / npm link) use the project's Vite, not the monorepo copy.
  // This mirrors the loadVite() pattern in cli.ts.
  let vitePath: string;
  try {
    const req = createRequire(path.join(root, "package.json"));
    vitePath = req.resolve("vite");
  } catch {
    vitePath = "vite";
  }
  const viteUrl = vitePath === "vite" ? vitePath : pathToFileURL(vitePath).href;
  return (await import(/* @vite-ignore */ viteUrl)) as ProjectViteApi;
}

async function loadProjectWranglerApi(root: string): Promise<ProjectWranglerApi> {
  const req = createRequire(path.join(root, "package.json"));
  let wranglerPath: string;
  try {
    wranglerPath = req.resolve("wrangler");
  } catch {
    const cloudflarePluginPath = req.resolve("@cloudflare/vite-plugin");
    wranglerPath = createRequire(cloudflarePluginPath).resolve("wrangler");
  }
  return (await import(/* @vite-ignore */ pathToFileURL(wranglerPath).href)) as ProjectWranglerApi;
}

async function loadDeployViteConfigMetadata(root: string): Promise<DeployViteConfigMetadata> {
  const vite = await loadProjectViteApi(root);
  const loaded = await vite.loadConfigFromFile(
    { command: "build", mode: "production" },
    undefined,
    root,
  );
  const plugins = loaded?.config.plugins;
  return {
    // The executed Vite config is authoritative. Source scans cannot see
    // imported or composed cache objects and must not suppress valid metadata.
    cacheConfig: await findVinextCacheConfigInPlugins(plugins),
    nextConfig: await findVinextNextConfigInPlugins(plugins),
    prerenderConfig: await findVinextPrerenderConfigInPlugins(plugins),
    routeRootConfig: await findVinextRouteRootConfigInPlugins(plugins),
  };
}

async function runBuild(info: ProjectInfo, env: string | undefined): Promise<void> {
  console.log("\n  Building for Cloudflare Workers...\n");

  const { createBuilder } = await loadProjectViteApi(info.root);

  // Use Vite's JS API for the build. The Vite config prepared by `vinext init`
  // has the cloudflare() plugin which handles the Worker output format.
  //
  // Both App Router and Pages Router use createBuilder + buildApp() so that
  // cloudflare() runs in its intended multi-environment mode and writes
  // .wrangler/deploy/config.json. A plain build() call bypasses cloudflare()'s
  // config() hook's builder.buildApp override, so writeBundle never fires on
  // the correct environment name.
  await withCloudflareEnv(env, async () => {
    const builder = await createBuilder({ root: info.root });
    await builder.buildApp();
  });
}

async function populateKVCacheFromPrerenderedArtifacts(
  root: string,
  wranglerEnv: string | undefined,
  cacheConfig: VinextCacheConfig | null,
): Promise<void> {
  // `loadDeployViteConfigMetadata` returns null unless a cache adapter is declared.
  const kvConfig = resolveKvDataAdapterConfig(cacheConfig);
  if (!kvConfig) return;

  const { routeCount, pairs } = buildPrerenderKVPairs(path.join(root, "dist", "server"), {
    appPrefix: kvConfig.appPrefix,
    ttlSeconds: kvConfig.ttlSeconds,
  });

  if (pairs.length === 0) {
    console.log(
      "  KV cache: Skipping prerender upload (no App Router prerendered cache entries found).",
    );
    return;
  }

  await runWranglerKVBulkPut(root, {
    binding: kvConfig.binding,
    env: wranglerEnv,
    pairs,
  });

  console.log(
    `  KV cache: Uploaded ${pairs.length} entr${pairs.length === 1 ? "y" : "ies"} for ${routeCount} prerendered route${routeCount === 1 ? "" : "s"}.`,
  );
}

// ─── Deploy ──────────────────────────────────────────────────────────────────

type WranglerDeployArgs = {
  args: string[];
  env: string | undefined;
};

type WranglerKVBulkPutArgs = {
  args: string[];
  env: string | undefined;
};

const KV_BULK_PUT_CHUNK_SIZE = 25;

export function validateWranglerEnvName(env: string): string {
  if (env.includes("\0")) {
    throw new Error("Wrangler environment names cannot contain null bytes.");
  }
  return env;
}

export function buildWranglerDeployArgs(
  options: Pick<DeployOptions, "preview" | "env" | "name" | "config">,
): WranglerDeployArgs {
  const args = ["deploy"];
  const env = options.env || (options.preview ? "preview" : undefined);
  if (options.config) {
    args.push("--config", options.config);
  }
  if (options.name) {
    args.push("--name", options.name);
  }
  if (env) {
    args.push("--env", validateWranglerEnvName(env));
  }
  return { args, env };
}

export function buildWranglerKVBulkPutArgs(options: {
  binding: string;
  env?: string;
  filePath: string;
}): WranglerKVBulkPutArgs {
  const env = options.env || undefined;
  const args = ["kv", "bulk", "put", options.filePath, "--binding", options.binding, "--remote"];
  if (env) {
    args.push("--env", validateWranglerEnvName(env));
  }
  return { args, env };
}

/**
 * Resolve Wrangler's JavaScript CLI entrypoint in node_modules.
 *
 * Invoking the JavaScript file through `process.execPath` avoids the `.cmd`
 * shim and command shell that package managers create on Windows.
 */
export function resolveWranglerBin(
  root: string,
  resolvePackageJson: (root: string) => string | null = (projectRoot) => {
    try {
      return createRequire(path.join(projectRoot, "package.json")).resolve("wrangler/package.json");
    } catch {
      return findInNodeModules(projectRoot, "wrangler/package.json");
    }
  },
): string {
  const packageJsonPath = resolvePackageJson(root);
  if (packageJsonPath) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
      bin?: string | Record<string, string>;
    };
    const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.wrangler;
    if (bin) return path.resolve(path.dirname(packageJsonPath), bin);
  }

  return path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
}

export function buildNodeCliInvocation(
  scriptPath: string,
  args: string[],
  nodeExecutable: string = process.execPath,
): { file: string; args: string[] } {
  return { file: nodeExecutable, args: [scriptPath, ...args] };
}

export function buildWranglerInvocation(
  root: string,
  options: Pick<DeployOptions, "preview" | "env" | "name" | "config">,
  nodeExecutable: string = process.execPath,
): { file: string; args: string[]; env: string | undefined } {
  const wranglerBin = resolveWranglerBin(root);
  const { args, env } = buildWranglerDeployArgs(options);
  return { ...buildNodeCliInvocation(wranglerBin, args, nodeExecutable), env };
}

export async function runWranglerKVBulkPut(
  root: string,
  options: {
    binding: string;
    env?: string;
    pairs: KVBulkPair[];
    tempDir?: string;
  },
  execute: typeof spawn = spawn,
  nodeExecutable: string = process.execPath,
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(options.tempDir ?? os.tmpdir(), "vinext-kv-bulk-"));

  try {
    const wranglerBin = resolveWranglerBin(root);
    const totalChunks = Math.ceil(options.pairs.length / KV_BULK_PUT_CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      const filePath = path.join(tempDir, `prerender-kv-${i}.json`);
      const chunk = options.pairs.slice(
        i * KV_BULK_PUT_CHUNK_SIZE,
        (i + 1) * KV_BULK_PUT_CHUNK_SIZE,
      );
      fs.writeFileSync(filePath, JSON.stringify(chunk), "utf-8");
      const { args } = buildWranglerKVBulkPutArgs({
        binding: options.binding,
        env: options.env,
        filePath,
      });
      const invocation = buildNodeCliInvocation(wranglerBin, args, nodeExecutable);
      const child = execute(invocation.file, invocation.args, {
        cwd: root,
        stdio: "inherit",
        shell: false,
      });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          if (code === 0) {
            resolve();
            return;
          }

          const exitReason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
          reject(new Error(`Wrangler KV bulk put failed with ${exitReason}.`));
        });
      });
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function runWranglerDeploy(
  root: string,
  options: Pick<DeployOptions, "preview" | "env" | "name" | "config">,
  execute: typeof spawn = spawn,
): Promise<string> {
  const spawnOptions: SpawnOptions = {
    cwd: root,
    stdio: ["inherit", "pipe", "pipe"],
    shell: false,
  };

  const { file, args, env } = buildWranglerInvocation(root, options);

  if (env) {
    console.log(`\n  Deploying to env: ${env}...`);
  } else {
    console.log("\n  Deploying to production...");
  }

  const child = execute(file, args, spawnOptions);
  let output = "";

  child.stdout?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const exitReason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(new Error(`Wrangler deploy failed with ${exitReason}.`));
    });
  });

  const deployedUrl = parseWorkerDeploymentUrl(output);

  return deployedUrl ?? "(URL not detected in wrangler output)";
}

export function hasCdnWarmRequests(
  plan: Omit<CdnWarmRequestPlan, "pagesDataPaths"> & { pagesDataPaths?: readonly string[] },
): boolean {
  return (
    plan.paths.length +
      (plan.pagesDataPaths?.length ?? 0) +
      (plan.routeHandlerPaths?.length ?? 0) +
      plan.rscPaths.length +
      plan.loadingShellPaths.length >
    0
  );
}

export function projectRequiresRouteCacheabilityProbeManifest(
  project: Pick<ProjectInfo, "isAppRouter" | "isPagesRouter">,
  cacheConfig: VinextCacheConfig | null,
): boolean {
  return (
    (project.isAppRouter || project.isPagesRouter) &&
    requiresRouteCacheabilityProbeManifest(cacheConfig)
  );
}

type CdnWarmDeployOptions = Pick<
  DeployOptions,
  | "preview"
  | "env"
  | "name"
  | "config"
  | "verbose"
  | "warmCdnTarget"
  | "warmCdnConcurrency"
  | "warmCdnTimeout"
  | "warmCdnRetries"
  | "warmCdnDiscoveryTimeout"
  | "warmCdnDiscoveryRetries"
  | "warmCdnProbeTimeout"
  | "warmCdnProbeRetries"
  | "warmCdnCertify"
  | "warmCdnReadinessTimeout"
  | "warmCdnReadinessRetries"
  | "warmCdnReadinessProbes"
  | "warmCdnReadinessProbeDelay"
  | "dangerouslyPromoteOnCdnWarmError"
  | "warmCdnPromote"
  | "warmCdnPromotionDelay"
> &
  Pick<
    CdnWarmOptions,
    | "deploymentId"
    | "expectedBuildId"
    | "expectedRscBuildId"
    | "loadingShellPaths"
    | "pagesDataPaths"
    | "routeHandlerPaths"
    | "routePatterns"
    | "rscPaths"
  > & {
    /** Probe a staged Worker and upload the resulting manifest as a second version. */
    cacheabilityProbe?: boolean;
    discoverWarmPlan?: (target: {
      headers?: HeadersInit;
      targetUrl: string;
    }) => Promise<PrerenderWarmPlan>;
  };

type PreparedCdnWarmDeployOptions = CdnWarmDeployOptions & {
  expectedDeploymentState?: WranglerDeploymentStatus;
  optionalWarmTargetKeys?: ReadonlySet<string>;
  prerenderSecret?: string;
  triggersAlreadyApplied?: boolean;
  triggersDeployedUrl?: string | null;
  uploadedVersion?: WranglerVersionUploadResult;
};

function cdnWarmTargetKey(target: Pick<CdnWarmTarget, "kind" | "sourcePathname">): string {
  return `${target.kind}\0${target.sourcePathname}`;
}

export async function deployWithCdnWarmup(
  root: string,
  paths: readonly string[],
  options: CdnWarmDeployOptions,
): Promise<string> {
  if (options.warmCdnTarget !== undefined) {
    options = { ...options, warmCdnTarget: validateCdnWarmTarget(options.warmCdnTarget) };
  }
  if (options.warmCdnDiscoveryTimeout !== undefined) {
    parsePositiveIntegerArg(
      String(options.warmCdnDiscoveryTimeout),
      "--warm-cdn-discovery-timeout",
    );
  }
  if (options.warmCdnDiscoveryRetries !== undefined) {
    parseNonNegativeIntegerArg(
      String(options.warmCdnDiscoveryRetries),
      "--warm-cdn-discovery-retries",
    );
  }
  if (options.warmCdnProbeTimeout !== undefined) {
    parsePositiveIntegerArg(String(options.warmCdnProbeTimeout), "--warm-cdn-probe-timeout");
  }
  if (options.warmCdnProbeRetries !== undefined) {
    parseNonNegativeIntegerArg(String(options.warmCdnProbeRetries), "--warm-cdn-probe-retries");
  }
  if (options.warmCdnReadinessTimeout !== undefined) {
    parsePositiveIntegerArg(
      String(options.warmCdnReadinessTimeout),
      "--warm-cdn-readiness-timeout",
    );
  }
  if (options.warmCdnReadinessRetries !== undefined) {
    parseNonNegativeIntegerArg(
      String(options.warmCdnReadinessRetries),
      "--warm-cdn-readiness-retries",
    );
  }
  if (options.warmCdnReadinessProbes !== undefined) {
    parsePositiveIntegerArg(String(options.warmCdnReadinessProbes), "--warm-cdn-readiness-probes");
  }
  if (options.warmCdnReadinessProbeDelay !== undefined) {
    validateTimerDelay(options.warmCdnReadinessProbeDelay, "--warm-cdn-readiness-probe-delay");
  }
  if (options.warmCdnPromotionDelay !== undefined) {
    validatePromotionDelay(options.warmCdnPromotionDelay);
  }
  if (options.cacheabilityProbe) {
    return deployWithCacheabilityProbe(root, options);
  }
  return deployUploadedVersionWithCdnWarmup(root, paths, options);
}

async function deployUploadedVersionWithCdnWarmup(
  root: string,
  paths: readonly string[],
  options: PreparedCdnWarmDeployOptions,
): Promise<string> {
  // Certification is an explicit request to prove every planned cache entry
  // reusable before promotion. The dangerous override may relax ordinary
  // warming, but it must never bypass that stronger contract.
  const allowUnverifiedPromotion =
    options.dangerouslyPromoteOnCdnWarmError === true && options.warmCdnCertify !== true;
  let deploymentId = options.deploymentId;
  let expectedBuildId = options.expectedBuildId;
  let expectedRscBuildId = options.expectedRscBuildId;
  const hasPreparedWarmPlan = options.uploadedVersion !== undefined;
  let warmPlanDiscovered = hasPreparedWarmPlan || options.discoverWarmPlan === undefined;
  let remainingWarmPlan: CdnWarmRequestPlan = {
    loadingShellPaths: [...(options.loadingShellPaths ?? [])],
    pagesDataPaths: [...(options.pagesDataPaths ?? [])],
    paths: [...paths],
    routeHandlerPaths: [...(options.routeHandlerPaths ?? [])],
    routePatterns: options.routePatterns ? { ...options.routePatterns } : undefined,
    rscPaths: [...(options.rscPaths ?? [])],
  };
  let discoveredWarmRequests =
    remainingWarmPlan.paths.length +
    remainingWarmPlan.pagesDataPaths.length +
    (remainingWarmPlan.routeHandlerPaths?.length ?? 0) +
    remainingWarmPlan.rscPaths.length +
    remainingWarmPlan.loadingShellPaths.length;

  const prepareWarmPlan = (plan: CdnWarmRequestPlan): CdnWarmRequestPlan => {
    if (
      (plan.paths.length === 0 &&
        plan.pagesDataPaths.length === 0 &&
        (plan.routeHandlerPaths?.length ?? 0) === 0) ||
      expectedBuildId !== undefined
    ) {
      return plan;
    }
    if (!allowUnverifiedPromotion) {
      const warmupKind =
        plan.paths.length > 0
          ? "CDN HTML warmup"
          : plan.pagesDataPaths.length > 0
            ? "CDN Pages data warmup"
            : "CDN Route Handler warmup";
      throw new Error(
        `${warmupKind} requires a CDN adapter that declares build-identity response headers. ` +
          "Configure that adapter capability or deploy without --experimental-warm-cdn-cache.",
      );
    }
    console.warn(
      `  CDN warmup: skipping ${plan.paths.length} HTML, ${plan.pagesDataPaths.length} Pages data, and ${plan.routeHandlerPaths?.length ?? 0} Route Handler request(s) because the CDN adapter does not declare build-identity response headers.`,
    );
    return { ...plan, pagesDataPaths: [], paths: [], routeHandlerPaths: [] };
  };

  const discoverWarmPlan = async (targetUrl: string, headers?: HeadersInit): Promise<void> => {
    if (!options.discoverWarmPlan) return;
    const plan = await options.discoverWarmPlan({ headers, targetUrl });
    deploymentId = plan.deploymentId;
    expectedBuildId = plan.buildIdentity;
    expectedRscBuildId = plan.rscBuildId;
    remainingWarmPlan = {
      loadingShellPaths: [...plan.loadingShellPaths],
      pagesDataPaths: [...(plan.pagesDataPaths ?? [])],
      paths: [...plan.paths],
      routeHandlerPaths: [...(plan.routeHandlerPaths ?? [])],
      routePatterns: plan.routePatterns ? { ...plan.routePatterns } : undefined,
      rscPaths: [...plan.rscPaths],
    };
    discoveredWarmRequests =
      remainingWarmPlan.paths.length +
      remainingWarmPlan.pagesDataPaths.length +
      (remainingWarmPlan.routeHandlerPaths?.length ?? 0) +
      remainingWarmPlan.rscPaths.length +
      remainingWarmPlan.loadingShellPaths.length;
    warmPlanDiscovered = true;
  };

  if (!options.discoverWarmPlan || hasPreparedWarmPlan) {
    remainingWarmPlan = prepareWarmPlan(remainingWarmPlan);
  }

  const upload = options.uploadedVersion ?? runWranglerVersionUpload(root, options);
  const warmUploadedVersion = (
    targetUrl: string,
    headers?: HeadersInit,
    propagatingTarget = false,
    plan: CdnWarmRequestPlan = {
      loadingShellPaths: remainingWarmPlan.loadingShellPaths,
      pagesDataPaths: remainingWarmPlan.pagesDataPaths,
      paths: remainingWarmPlan.paths,
      routeHandlerPaths: remainingWarmPlan.routeHandlerPaths,
      routePatterns: remainingWarmPlan.routePatterns,
      rscPaths: remainingWarmPlan.rscPaths,
    },
    requireCacheHit = false,
  ) =>
    warmCdnCache({
      targetUrl,
      paths: plan.paths,
      headers,
      propagatingTarget,
      deploymentId,
      expectedBuildId,
      expectedRscBuildId,
      loadingShellPaths: plan.loadingShellPaths,
      pagesDataPaths: plan.pagesDataPaths,
      routeHandlerPaths: plan.routeHandlerPaths,
      routePatterns: plan.routePatterns,
      rscPaths: plan.rscPaths,
      concurrency: options.warmCdnConcurrency,
      timeoutMs: options.warmCdnTimeout,
      retries: options.warmCdnRetries,
      requireCacheHit,
      strict: requireCacheHit || !allowUnverifiedPromotion,
    });

  const wranglerConfig = parseWranglerConfig(root, options.config);
  const deploymentStatus = runWranglerDeploymentStatus(root, options);
  if (
    options.expectedDeploymentState &&
    !deploymentStateEquals(deploymentStatus, options.expectedDeploymentState)
  ) {
    throw new Error(
      "Two-stage CDN warming stopped because Worker deployment traffic or deployment identity changed before the final version could be staged. No final version was promoted.",
    );
  }
  const stagingTraffic = getZeroPercentStagingTraffic(deploymentStatus, upload.versionId);
  if (hasPreparedWarmPlan && !stagingTraffic) {
    throw new Error(
      "Two-stage CDN warming stopped because Worker deployment traffic changed before the final version could be staged. No final version was promoted.",
    );
  }
  let staged: ReturnType<typeof runWranglerVersionDeploy> | null = null;
  let triggersDeployedUrl: string | null = options.triggersDeployedUrl ?? null;
  let stagedCacheFilled = false;
  let stagedDeploymentState: WranglerDeploymentStatus | null = null;
  const initialWarmRequests =
    options.discoverWarmPlan === undefined || hasPreparedWarmPlan
      ? remainingWarmPlan.paths.length +
        remainingWarmPlan.pagesDataPaths.length +
        (remainingWarmPlan.routeHandlerPaths?.length ?? 0) +
        remainingWarmPlan.rscPaths.length +
        remainingWarmPlan.loadingShellPaths.length
      : 1;
  let triggersApplied = options.triggersAlreadyApplied === true;

  function applyTriggers(): void {
    if (triggersApplied) return;
    triggersDeployedUrl = runWranglerTriggersDeploy(root, options).deployedUrl;
    triggersApplied = true;
  }

  if (stagingTraffic) {
    try {
      staged = runWranglerVersionDeploy(root, stagingTraffic, options, "stage");
    } catch (error) {
      throw reconcileVersionDeployFailure(root, options, error, {
        desiredTraffic: stagingTraffic,
        desiredDescription:
          "The uploaded version is staged at 0% with the previous version still serving 100% traffic; Worker triggers/routes were not changed.",
        priorState: deploymentStatus,
        priorDescription:
          "Worker deployment traffic was not changed and Worker triggers/routes were not changed.",
      });
    }
    try {
      if (hasPreparedWarmPlan) {
        stagedDeploymentState = runWranglerDeploymentStatus(root, options);
        if (!deploymentTrafficEquals(stagedDeploymentState.versions, stagingTraffic)) {
          throw new Error(
            "Two-stage CDN warming stopped because Worker deployment traffic changed before production triggers could be applied. No final version was promoted.",
          );
        }
      }
      applyTriggers();
    } catch (error) {
      throw withStagedVersionCleanupNote(error);
    }
    const targetUrl =
      resolveCdnWarmupTargetUrl(root, triggersDeployedUrl, options) ?? staged.deployedUrl;
    const workerName =
      options.name ??
      upload.workerName ??
      resolveWorkerNameForVersionOverride(wranglerConfig, options);
    const headers = buildVersionOverrideHeaders(workerName, upload.versionId);
    if (targetUrl && headers) {
      try {
        if (!warmPlanDiscovered) {
          console.log("  CDN warmup: discovering paths from the staged Worker version...");
          await discoverWarmPlan(targetUrl, headers);
          remainingWarmPlan = prepareWarmPlan(remainingWarmPlan);
          console.log(
            `  CDN warmup: discovered ${remainingWarmPlan.paths.length} HTML, ${remainingWarmPlan.pagesDataPaths.length} Pages data, ${remainingWarmPlan.routeHandlerPaths?.length ?? 0} Route Handler, ${remainingWarmPlan.rscPaths.length} RSC, and ${remainingWarmPlan.loadingShellPaths.length} loading-shell request(s).`,
          );
        }
        const stagedWarmPlan: CdnWarmRequestPlan = {
          loadingShellPaths: remainingWarmPlan.loadingShellPaths,
          pagesDataPaths: remainingWarmPlan.pagesDataPaths,
          paths: remainingWarmPlan.paths,
          routeHandlerPaths: remainingWarmPlan.routeHandlerPaths,
          routePatterns: remainingWarmPlan.routePatterns,
          rscPaths: remainingWarmPlan.rscPaths,
        };
        const stagedWarmRequests =
          stagedWarmPlan.paths.length +
          stagedWarmPlan.pagesDataPaths.length +
          (stagedWarmPlan.routeHandlerPaths?.length ?? 0) +
          stagedWarmPlan.rscPaths.length +
          stagedWarmPlan.loadingShellPaths.length;
        if (stagedWarmRequests > 0) {
          console.log("  CDN warmup: waiting for the staged Worker version to become stable...");
          const readiness = await waitForCdnWarmTargetReadiness({
            targetUrl,
            headers,
            plan: stagedWarmPlan,
            prerenderSecret: options.prerenderSecret,
            deploymentId,
            expectedBuildId,
            expectedRscBuildId,
            phaseTimeoutMs: options.warmCdnReadinessTimeout,
            probeIntervalMs: options.warmCdnReadinessProbeDelay,
            requiredConsecutiveSuccesses: options.warmCdnReadinessProbes,
            // Preserve the existing --warm-cdn-retries behavior while allowing
            // readiness to be tuned independently by the dedicated option.
            retries: options.warmCdnReadinessRetries ?? options.warmCdnRetries,
            timeoutMs: options.warmCdnTimeout,
          });
          if (!readiness.ready) {
            const message = `CDN warmup could not verify staged Worker readiness: ${readiness.error}.`;
            const noPromoteNote =
              options.warmCdnPromote === false
                ? " CDN warmup cannot continue because promotion is disabled and the staged version was not warmed."
                : "";
            if (!allowUnverifiedPromotion || options.warmCdnPromote === false) {
              throw new Error(`${message}${noPromoteNote}`);
            }
            console.warn(`  ${message} Promoting because the dangerous override is enabled.`);
          } else {
            console.log("  CDN warmup: staged Worker version is stable.");
            const warmResult = await warmUploadedVersion(targetUrl, headers, true, stagedWarmPlan);
            const optionalSkipped = options.optionalWarmTargetKeys
              ? warmResult.skippedTargets.filter((target) =>
                  options.optionalWarmTargetKeys!.has(cdnWarmTargetKey(target)),
                ).length
              : 0;
            if (hasPreparedWarmPlan && options.warmCdnCertify) {
              if (warmResult.warmed + optionalSkipped !== stagedWarmRequests) {
                throw new Error(
                  `CDN warmup cannot certify the staged cache because only ${warmResult.warmed}/${stagedWarmRequests - optionalSkipped} cacheable entries completed their initial fill.`,
                );
              }
            }
            const requiredSkipped = warmResult.skipped - optionalSkipped;
            if (hasPreparedWarmPlan && requiredSkipped > 0) {
              const message =
                `Two-stage CDN warming could not fill ${requiredSkipped}/${warmResult.total} ` +
                "planned cache entries because Cloudflare refused cache admission.";
              if (!allowUnverifiedPromotion) {
                throw new Error(message);
              }
              console.warn(`  ${message} Promoting because the dangerous override is enabled.`);
            }
            if (optionalSkipped > 0) {
              console.log(
                `  CDN warmup: ${optionalSkipped} paired representation${optionalSkipped === 1 ? " remained" : "s remained"} private after ${optionalSkipped === 1 ? "its" : "their"} final render and will not be cached.`,
              );
            }
            remainingWarmPlan = {
              loadingShellPaths: warmResult.retryPlan.loadingShellPaths,
              pagesDataPaths: warmResult.retryPlan.pagesDataPaths,
              paths: warmResult.retryPlan.paths,
              routeHandlerPaths: warmResult.retryPlan.routeHandlerPaths,
              rscPaths: warmResult.retryPlan.rscPaths,
            };
            if (hasPreparedWarmPlan && options.warmCdnCertify && warmResult.warmed > 0) {
              console.log(
                `  CDN warmup: certifying ${warmResult.warmed} staged cache entr${warmResult.warmed === 1 ? "y" : "ies"} before promotion...`,
              );
              const certification = await warmUploadedVersion(
                targetUrl,
                headers,
                true,
                warmResult.warmedPlan,
                true,
              );
              if (certification.warmed !== warmResult.warmed) {
                throw new Error(
                  `CDN warmup certified ${certification.warmed}/${warmResult.warmed} staged cache entries as reusable.`,
                );
              }
              stagedCacheFilled = true;
            } else {
              stagedCacheFilled = warmResult.warmed > 0;
            }
          }
        }
      } catch (error) {
        throw withStagedVersionCleanupNote(error);
      }
    } else if (initialWarmRequests > 0) {
      const message =
        "CDN warmup failed: pre-traffic warmup needs a production URL and Worker name for version overrides. " +
        "Configure a route/custom domain and Worker name, or deploy without --experimental-warm-cdn-cache.";
      if (!allowUnverifiedPromotion) {
        throw new Error(`${message} ${getStagedVersionCleanupNote()}`);
      }
      console.warn(`  ${message} Promoting because the dangerous override is enabled.`);
    }
  } else {
    if (initialWarmRequests > 0) {
      const message =
        "CDN warmup cannot stage the uploaded Worker at 0% because the current deployment is not exactly one version serving 100% traffic.";
      if (!allowUnverifiedPromotion) {
        throw new Error(`${message} No traffic or triggers were changed.`);
      }
      console.warn(`  ${message} Promoting because the dangerous override is enabled.`);
    }
    console.warn(
      "  CDN warmup: pre-traffic version override skipped because the current deployment is not one version serving 100% traffic.",
    );
  }

  const countRemainingWarmRequests = (): number =>
    remainingWarmPlan.paths.length +
    remainingWarmPlan.pagesDataPaths.length +
    (remainingWarmPlan.routeHandlerPaths?.length ?? 0) +
    remainingWarmPlan.rscPaths.length +
    remainingWarmPlan.loadingShellPaths.length;

  if (options.warmCdnPromote === false) {
    if (!staged) {
      throw new Error(
        "CDN warmup cannot skip promotion because the uploaded Worker version could not be staged at 0% traffic. " +
          "The current deployment must have exactly one version serving 100% traffic.",
      );
    }
    const remainingWarmRequests = countRemainingWarmRequests();
    if (!hasPreparedWarmPlan && options.discoverWarmPlan && discoveredWarmRequests === 0) {
      throw withStagedVersionCleanupNote(
        new Error(
          "CDN warmup cannot skip promotion because no build-discovered requests were found to warm.",
        ),
      );
    }
    if (remainingWarmRequests > 0) {
      throw withStagedVersionCleanupNote(
        new Error(
          `CDN warmup cannot skip promotion because ${remainingWarmRequests} request(s) remain unwarmed.`,
        ),
      );
    }
    if (hasPreparedWarmPlan && stagedDeploymentState) {
      let currentDeployment: WranglerDeploymentStatus;
      try {
        currentDeployment = runWranglerDeploymentStatus(root, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${message} CDN warmup cannot confirm that the uploaded Worker remains staged at 0% traffic; ` +
            "production Worker triggers/routes remain applied. Inspect `wrangler deployments status` before continuing.",
          { cause: error },
        );
      }
      if (!deploymentStateEquals(currentDeployment, stagedDeploymentState)) {
        throw new Error(
          "Two-stage CDN warming stopped because Worker deployment traffic or deployment identity changed before the no-promote handoff. " +
            "The uploaded Worker is not confirmed staged at 0% traffic; production Worker triggers/routes remain applied.",
        );
      }
    }
    console.log(
      "  CDN warmup: promotion disabled; uploaded Worker version remains staged at 0% traffic and production Worker triggers/routes remain applied.",
    );
    return (
      staged.deployedUrl ??
      triggersDeployedUrl ??
      upload.previewUrl ??
      "(URL not detected in wrangler output)"
    );
  }

  let deployed: ReturnType<typeof runWranglerVersionDeploy>;
  let prePromotionState: WranglerDeploymentStatus | null = null;
  const promotionTraffic = [{ versionId: upload.versionId, percentage: 100 }];
  let promotionAttempted = false;
  try {
    if (stagedCacheFilled) {
      const promotionDelay = options.warmCdnPromotionDelay ?? DEFAULT_CDN_WARM_PROMOTION_DELAY_MS;
      if (promotionDelay > 0) {
        console.log(
          `  CDN warmup: waiting ${promotionDelay / 1_000} seconds for cache propagation before promotion...`,
        );
        await delay(promotionDelay);
      }
    }
    if (hasPreparedWarmPlan && stagingTraffic) {
      prePromotionState = runWranglerDeploymentStatus(root, options);
      if (
        !deploymentTrafficEquals(prePromotionState.versions, stagingTraffic) ||
        (stagedDeploymentState && !deploymentStateEquals(prePromotionState, stagedDeploymentState))
      ) {
        throw new Error(
          "Two-stage CDN warming stopped because Worker deployment traffic or deployment identity changed before the final version could be promoted. No final version was promoted.",
        );
      }
    }
    promotionAttempted = true;
    deployed = runWranglerVersionDeploy(
      root,
      promotionTraffic,
      options,
      stagedCacheFilled ? "promote-warmed" : "promote-uploaded",
    );
  } catch (error) {
    if (promotionAttempted) {
      throw reconcileVersionDeployFailure(root, options, error, {
        desiredTraffic: promotionTraffic,
        desiredDescription:
          "The uploaded version is already promoted to 100%; Worker triggers/routes may already have changed.",
        priorState:
          prePromotionState ??
          (stagingTraffic
            ? { deploymentId: null, output: "", versions: stagingTraffic }
            : deploymentStatus),
        priorDescription:
          "The uploaded version remains staged at 0% with the previous version still serving 100% traffic; Worker triggers/routes may already have changed.",
      });
    }
    throw staged ? withStagedVersionCleanupNote(error) : error;
  }
  try {
    applyTriggers();
  } catch (error) {
    throw withPromotedVersionTriggerNote(error);
  }
  let postPromotionTargetUrl =
    resolveCdnWarmupTargetUrl(root, triggersDeployedUrl, options) ?? deployed.deployedUrl;
  if (!warmPlanDiscovered && postPromotionTargetUrl) {
    try {
      console.log("  CDN warmup: discovering paths from the promoted Worker version...");
      await discoverWarmPlan(postPromotionTargetUrl);
      remainingWarmPlan = prepareWarmPlan(remainingWarmPlan);
    } catch (error) {
      throw withPromotedVersionWarmupNote(error);
    }
  }
  const remainingWarmRequests = countRemainingWarmRequests();
  if (remainingWarmRequests > 0) {
    const targetUrl = postPromotionTargetUrl;
    if (targetUrl) {
      try {
        await warmUploadedVersion(targetUrl, undefined, true, remainingWarmPlan);
      } catch (error) {
        throw withPromotedVersionWarmupNote(error);
      }
    } else if (!allowUnverifiedPromotion) {
      throw withPromotedVersionWarmupNote(
        new Error(
          "CDN warmup failed: no production URL could be inferred from wrangler config or output. " +
            "Configure a route/custom domain, ensure Wrangler prints a workers.dev URL, or deploy without --experimental-warm-cdn-cache.",
        ),
      );
    } else {
      console.warn(
        "  CDN warmup skipped: no production URL could be inferred after promotion; the dangerous override was enabled.",
      );
    }
  }
  return (
    deployed.deployedUrl ??
    triggersDeployedUrl ??
    staged?.deployedUrl ??
    upload.previewUrl ??
    "(URL not detected in wrangler output)"
  );
}

function deploymentTrafficEquals(
  actual: readonly WranglerVersionTraffic[],
  expected: readonly WranglerVersionTraffic[],
): boolean {
  const normalize = (traffic: readonly WranglerVersionTraffic[]) =>
    [...traffic].sort((a, b) => a.versionId.localeCompare(b.versionId));
  const normalizedActual = normalize(actual);
  const normalizedExpected = normalize(expected);
  return (
    normalizedActual.length === normalizedExpected.length &&
    normalizedActual.every(
      (version, index) =>
        version.versionId === normalizedExpected[index]?.versionId &&
        version.percentage === normalizedExpected[index]?.percentage,
    )
  );
}

function deploymentStateEquals(
  actual: WranglerDeploymentStatus,
  expected: WranglerDeploymentStatus,
): boolean {
  if (expected.deploymentId !== null && actual.deploymentId !== expected.deploymentId) {
    return false;
  }
  return deploymentTrafficEquals(actual.versions, expected.versions);
}

function reconcileVersionDeployFailure(
  root: string,
  options: CdnWarmDeployOptions,
  error: unknown,
  expected: {
    desiredTraffic: readonly WranglerVersionTraffic[];
    desiredDescription: string;
    priorState: WranglerDeploymentStatus;
    priorDescription: string;
  },
): Error {
  const message = error instanceof Error ? error.message : String(error);
  let reconciliation: string;
  try {
    const current = runWranglerDeploymentStatus(root, options);
    if (deploymentTrafficEquals(current.versions, expected.desiredTraffic)) {
      reconciliation = expected.desiredDescription;
    } else if (deploymentStateEquals(current, expected.priorState)) {
      reconciliation = expected.priorDescription;
    } else {
      reconciliation =
        "Worker deployment state differs from both the requested and prior state, so the deployment outcome is unknown or another deployment changed it.";
    }
  } catch (reconciliationError) {
    const detail =
      reconciliationError instanceof Error
        ? reconciliationError.message
        : String(reconciliationError);
    reconciliation = `Worker deployment status could not be read after the command failed, so the deployment outcome is unknown (${detail}).`;
  }
  return new Error(`${message} ${reconciliation}`, { cause: error });
}

function assertDeploymentStateUnchanged(
  root: string,
  options: CdnWarmDeployOptions,
  expected: WranglerDeploymentStatus,
  message: string,
): void {
  const current = runWranglerDeploymentStatus(root, options);
  if (!deploymentStateEquals(current, expected)) {
    throw new Error(message);
  }
}

async function deployWithCacheabilityProbe(
  root: string,
  options: CdnWarmDeployOptions,
): Promise<string> {
  if (!options.discoverWarmPlan) {
    throw new Error(
      "Two-stage CDN warming requires staged Worker route discovery before cacheability probing.",
    );
  }

  const prerenderSecret = readPrerenderSecret(root);

  const probeUpload = runWranglerVersionUpload(root, options);
  const initialDeployment = runWranglerDeploymentStatus(root, options);
  const probeTraffic = getZeroPercentStagingTraffic(initialDeployment, probeUpload.versionId);
  if (!probeTraffic) {
    throw new Error(
      "Two-stage CDN warming cannot stage the probe Worker at 0% because the current deployment is not exactly one version serving 100% traffic. No traffic or triggers were changed.",
    );
  }

  let stagedProbe: ReturnType<typeof runWranglerVersionDeploy>;
  try {
    stagedProbe = runWranglerVersionDeploy(root, probeTraffic, options, "stage");
  } catch (error) {
    throw reconcileVersionDeployFailure(root, options, error, {
      desiredTraffic: probeTraffic,
      desiredDescription:
        "The probe version is staged at 0% with the previous version still serving 100% traffic; production Worker triggers/routes were not changed.",
      priorState: initialDeployment,
      priorDescription:
        "Worker deployment traffic was not changed and production Worker triggers/routes were not changed.",
    });
  }
  let stagedProbeDeployment: WranglerDeploymentStatus;
  try {
    stagedProbeDeployment = runWranglerDeploymentStatus(root, options);
    if (!deploymentTrafficEquals(stagedProbeDeployment.versions, probeTraffic)) {
      throw new Error(
        "Two-stage CDN warming stopped because Worker deployment traffic changed immediately after the probe version was staged.",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message} The probe staging command completed, but its current deployment state could not be confirmed; ` +
        "production Worker triggers/routes were not changed. Inspect `wrangler deployments status` and remove the staged probe version if necessary.",
      { cause: error },
    );
  }
  let prepared:
    | {
        optionalWarmTargetKeys: ReadonlySet<string>;
        plan: PrerenderWarmPlan;
        prerenderSecret: string;
        upload: WranglerVersionUploadResult;
      }
    | undefined;
  try {
    // Probe through a URL returned by the non-traffic upload/staging commands.
    // Production triggers stay untouched until the manifest-bearing upload succeeds.
    const targetUrl = resolveCdnWarmupTargetUrl(
      root,
      stagedProbe.deployedUrl ?? probeUpload.previewUrl,
      options,
    );
    const wranglerConfig = parseWranglerConfig(root, options.config);
    const workerName =
      options.name ??
      probeUpload.workerName ??
      resolveWorkerNameForVersionOverride(wranglerConfig, options);
    const headers = buildVersionOverrideHeaders(workerName, probeUpload.versionId);
    if (!targetUrl || !headers) {
      throw new Error(
        "Two-stage CDN warming needs a production URL and Worker name for version-overridden cacheability probes.",
      );
    }

    console.log("  CDN warmup: discovering paths from the staged probe Worker...");
    const discovered = await options.discoverWarmPlan({ headers, targetUrl });
    if (!discovered.buildId) {
      throw new Error(
        "Two-stage CDN warming requires the staged discovery result to match dist/server/BUILD_ID.",
      );
    }
    if (!discovered.buildIdentity) {
      throw new Error(
        "Two-stage CDN warming requires a CDN adapter that exposes the application build identity.",
      );
    }
    const plan: PrerenderWarmPlan & CdnWarmRequestPlan = {
      ...discovered,
      appPaths: discovered.appPaths ? [...discovered.appPaths] : undefined,
      fallbackRoutePatterns: discovered.fallbackRoutePatterns
        ? [...discovered.fallbackRoutePatterns]
        : undefined,
      loadingShellPaths: [...discovered.loadingShellPaths],
      pagesDataPaths: [...(discovered.pagesDataPaths ?? [])],
      pagesPaths: discovered.pagesPaths ? [...discovered.pagesPaths] : undefined,
      paths: [...discovered.paths],
      routeHandlerPaths: [...(discovered.routeHandlerPaths ?? [])],
      routePatterns: discovered.routePatterns ? { ...discovered.routePatterns } : undefined,
      rscPaths: [...discovered.rscPaths],
    };
    if (!plan.appPaths && !plan.pagesPaths) {
      throw new Error(
        "Two-stage CDN warming requires staged discovery to report App or Pages route ownership.",
      );
    }
    const ownedHtmlPaths = new Set([...(plan.appPaths ?? []), ...(plan.pagesPaths ?? [])]);
    plan.paths = plan.paths.filter((pathname) => ownedHtmlPaths.has(pathname));
    const targets = await createCdnWarmTargets({
      deploymentId: plan.deploymentId,
      headers,
      loadingShellPaths: plan.loadingShellPaths,
      pagesDataPaths: plan.pagesDataPaths,
      paths: plan.paths,
      routeHandlerPaths: plan.routeHandlerPaths,
      routePatterns: plan.routePatterns,
      rscPaths: plan.rscPaths,
    });
    const routePatternCount = new Set(
      targets.flatMap((target) =>
        target.route ? [`${target.route.kind}\0${target.route.pattern}`] : [],
      ),
    ).size;
    const concreteRoutePathCount = new Set(
      targets.flatMap((target) =>
        target.route
          ? [
              `${target.route.kind}\0${target.route.pattern}\0${
                target.route.cacheabilityProbe?.concretePathname ??
                cacheabilityRoutePathname(target.pathname, target.kind)
              }`,
            ]
          : [],
      ),
    ).size;
    if (targets.length > 0) {
      console.log("  CDN warmup: waiting for the staged probe Worker to become stable...");
      const readiness = await waitForCdnWarmTargetReadiness({
        targetUrl,
        headers,
        plan,
        prerenderSecret,
        deploymentId: plan.deploymentId,
        expectedBuildId: plan.buildIdentity,
        expectedRscBuildId: plan.rscBuildId,
        phaseTimeoutMs: options.warmCdnReadinessTimeout,
        probeIntervalMs: options.warmCdnReadinessProbeDelay,
        requiredConsecutiveSuccesses: options.warmCdnReadinessProbes,
        retries: options.warmCdnReadinessRetries ?? options.warmCdnRetries,
        timeoutMs: options.warmCdnTimeout,
      });
      if (!readiness.ready) {
        throw new Error(
          `Two-stage CDN warming could not verify staged probe Worker readiness: ${readiness.error}.`,
        );
      }

      console.log(
        `  CDN warmup: probing ${concreteRoutePathCount} concrete route path${concreteRoutePathCount === 1 ? "" : "s"} once across ${routePatternCount} pattern${routePatternCount === 1 ? "" : "s"}; filtering ${targets.length} candidate warm request identit${targets.length === 1 ? "y" : "ies"}...`,
      );
    } else {
      const fallbackPatternCount = plan.fallbackRoutePatterns?.length ?? 0;
      console.log(
        fallbackPatternCount > 0
          ? `  CDN warmup: embedding ${fallbackPatternCount} on-demand static route pattern${fallbackPatternCount === 1 ? "" : "s"} without a speculative render.`
          : "  CDN warmup: no page request identities were discovered; embedding an empty fail-closed cacheability manifest.",
      );
    }
    const probeProgress = new CdnOperationProgress();
    let probe: Awaited<ReturnType<typeof probeStagedWorkerCacheability>>;
    try {
      probe = await probeStagedWorkerCacheability({
        buildId: discovered.buildId,
        concurrency: options.warmCdnConcurrency,
        expectedResponseBuildId: plan.buildIdentity,
        fallbackRoutePatterns: plan.fallbackRoutePatterns,
        phaseTimeoutMs: options.warmCdnProbeTimeout ?? DEFAULT_CACHEABILITY_PROBE_PHASE_TIMEOUT_MS,
        retries:
          options.warmCdnProbeRetries ??
          options.warmCdnRetries ??
          DEFAULT_CACHEABILITY_PROBE_RETRIES,
        retryDelayMs: DEFAULT_CACHEABILITY_PROBE_RETRY_DELAY_MS,
        root,
        targets,
        targetUrl,
        timeoutMs: options.warmCdnTimeout,
        onProgress(progress) {
          probeProgress.update(
            progress.completed,
            progress.total,
            `${progress.static} static, ${progress.dynamic} dynamic, ${progress.skipped} skipped`,
            "Probing route cacheability",
          );
        },
      });
    } finally {
      probeProgress.finish();
    }
    console.log(
      `  CDN warmup: classified ${probe.classified} route pattern${probe.classified === 1 ? "" : "s"} with ${probe.probed} render probe${probe.probed === 1 ? "" : "s"}; ${probe.dynamic} observed dynamic and ${probe.skipped} excluded by pattern-wide proof.`,
    );
    if (probe.failures.length > 0) {
      throw new Error(
        `Two-stage CDN warming failed to classify ${probe.failures.length}/${concreteRoutePathCount} concrete route paths after ${probe.probed} render probe(s). First failure: ${probe.failures[0]}`,
      );
    }
    const finalPlan: PrerenderWarmPlan & CdnWarmRequestPlan = {
      ...plan,
      loadingShellPaths: probe.cacheableTargets
        .filter((target) => target.kind === "rsc-loading-shell")
        .map((target) => target.sourcePathname),
      pagesDataPaths: probe.cacheableTargets
        .filter((target) => target.kind === "pages-data")
        .map((target) => target.sourcePathname),
      paths: probe.cacheableTargets
        .filter((target) => target.kind === "html")
        .map((target) => target.sourcePathname),
      routeHandlerPaths: probe.cacheableTargets
        .filter((target) => target.kind === "app-route")
        .map((target) => target.sourcePathname),
      rscPaths: probe.cacheableTargets
        .filter((target) => target.kind === "rsc-full")
        .map((target) => target.sourcePathname),
    };
    // A concurrent deployment invalidates the probe. Avoid creating an orphan
    // final version when the probe is already stale. The final deployment path
    // checks this state again immediately before it stages the uploaded version.
    assertDeploymentStateUnchanged(
      root,
      options,
      stagedProbeDeployment,
      "Two-stage CDN warming stopped because Worker deployment traffic or deployment identity changed while cacheability was being probed. No final version was promoted.",
    );
    const finalConfig = writeCacheabilityManifestArtifact(root, options.config, probe.manifest);
    const finalUpload = runWranglerVersionUpload(root, {
      config: finalConfig,
      env: options.env,
      name: options.name,
      preview: options.preview,
      verbose: options.verbose,
    });
    prepared = {
      optionalWarmTargetKeys: new Set(probe.speculativeTargets.map(cdnWarmTargetKey)),
      prerenderSecret,
      plan: finalPlan,
      upload: finalUpload,
    };
  } catch (error) {
    throw withStagedProbeVersionCleanupNote(error);
  }

  return deployUploadedVersionWithCdnWarmup(root, prepared.plan.paths, {
    ...options,
    deploymentId: prepared.plan.deploymentId,
    expectedBuildId: prepared.plan.buildIdentity,
    expectedRscBuildId: prepared.plan.rscBuildId,
    expectedDeploymentState: stagedProbeDeployment,
    loadingShellPaths: prepared.plan.loadingShellPaths,
    optionalWarmTargetKeys: prepared.optionalWarmTargetKeys,
    pagesDataPaths: prepared.plan.pagesDataPaths,
    prerenderSecret: prepared.prerenderSecret,
    routeHandlerPaths: prepared.plan.routeHandlerPaths,
    routePatterns: prepared.plan.routePatterns,
    rscPaths: prepared.plan.rscPaths,
    uploadedVersion: prepared.upload,
  });
}

export function resolveCdnWarmupTargetUrl(root: string, deployedUrl: string | null): string | null;
export function resolveCdnWarmupTargetUrl(
  root: string,
  deployedUrl: string | null,
  options: Pick<DeployOptions, "preview" | "env" | "config" | "warmCdnTarget">,
): string | null;
export function resolveCdnWarmupTargetUrl(
  _root: string,
  deployedUrl: string | null,
  options?: Pick<DeployOptions, "preview" | "env" | "config" | "warmCdnTarget">,
): string | null {
  return options?.warmCdnTarget ?? deployedUrl;
}

export function getZeroPercentStagingTraffic(
  deployment: WranglerDeploymentStatus | null,
  versionId: string,
): WranglerVersionTraffic[] | null {
  const current = deployment?.versions ?? [];
  const serving = current.filter((version) => version.percentage > 0);
  if (serving.length !== 1 || serving[0].percentage !== 100) {
    return null;
  }
  if (serving[0].versionId === versionId) {
    return null;
  }
  return [serving[0], { versionId, percentage: 0 }];
}

function getWranglerTargetEnv(options: Pick<DeployOptions, "preview" | "env">): string | undefined {
  return options.env || (options.preview ? "preview" : undefined);
}

type ParsedWranglerConfig = NonNullable<ReturnType<typeof parseWranglerConfig>>;

export function resolveWorkerNameForVersionOverride(
  config: ParsedWranglerConfig | null,
  options: Pick<DeployOptions, "preview" | "env" | "name">,
): string | undefined {
  if (options.name) {
    return options.name;
  }

  const env = getWranglerTargetEnv(options);
  if (!env) {
    return config?.name;
  }

  if (config?.legacyEnv === false) {
    return config.name;
  }

  return config?.env?.[env]?.name ?? (config?.name ? `${config.name}-${env}` : undefined);
}

function quoteStructuredHeaderString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildVersionOverrideHeaders(
  workerName: string | undefined,
  versionId: string,
): HeadersInit | undefined {
  if (!workerName) return undefined;
  return {
    "Cloudflare-Workers-Version-Overrides": `${workerName}=${quoteStructuredHeaderString(versionId)}`,
    [VINEXT_EXPECTED_WORKER_VERSION_HEADER]: versionId,
  };
}

function withStagedVersionCleanupNote(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message} ${getStagedVersionCleanupNote()}`, {
    cause: error,
  });
}

function withStagedProbeVersionCleanupNote(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `${message} The probe version may remain staged at 0% with the previous version still serving 100% traffic; ` +
      "production Worker triggers/routes were not changed.",
    { cause: error },
  );
}

function getStagedVersionCleanupNote(): string {
  return (
    "The uploaded version may remain staged at 0% with the previous version still serving 100% traffic; " +
    "Worker triggers/routes may also have changed because trigger deployment runs before warming. " +
    "Rerun deploy to promote it or use `wrangler versions deploy` to choose the desired version split."
  );
}

function withPromotedVersionTriggerNote(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `${message} The uploaded version may already be promoted to 100%, but Worker triggers/routes may not be updated; ` +
      "rerun deploy or `wrangler triggers deploy` after fixing the trigger error.",
    {
      cause: error,
    },
  );
}

function withPromotedVersionWarmupNote(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `${message} The uploaded version is already promoted to 100% and its Worker triggers/routes were updated; ` +
      "rerun deploy to retry cache warming or roll back with `wrangler versions deploy`.",
    { cause: error },
  );
}

// ─── Main Entry ──────────────────────────────────────────────────────────────

export async function deploy(options: DeployOptions): Promise<void> {
  if (options.warmCdnTarget !== undefined && !options.warmCdnCache) {
    throw new Error("--warm-cdn-target requires --experimental-warm-cdn-cache.");
  }
  const warmCdnTarget =
    options.warmCdnTarget === undefined ? undefined : validateCdnWarmTarget(options.warmCdnTarget);
  const deployEnv = validateWranglerEnvName(
    options.env || (options.preview ? "preview" : "production"),
  );
  const root = path.resolve(options.root);
  loadDotenv({ root, mode: "production" });

  console.log("\n  vinext-cloudflare deploy\n");

  // Step 1: Detect project structure
  const info = detectProject(root);

  if (!info.isAppRouter && !info.isPagesRouter) {
    console.error("  Error: No app/ or pages/ directory found.");
    console.error(
      "  vinext-cloudflare deploy requires a Next.js project with an app/ or pages/ directory",
    );
    console.error("  (also checks src/app/ and src/pages/).\n");
    process.exit(1);
  }

  if (options.name) {
    info.projectName = options.name;
  }

  console.log(`  Project: ${info.projectName}`);
  console.log(`  Router:  ${info.isAppRouter ? "App Router" : "Pages Router"}`);
  console.log(`  ISR:     ${info.hasISR ? "detected" : "none"}`);

  // Step 2: Validate init-owned dependencies and deployment scaffolding.
  const missingScaffolding = [
    !info.hasViteConfig && "Vite config",
    !info.hasWranglerConfig && "Wrangler config",
  ].filter((value): value is string => Boolean(value));
  if (missingScaffolding.length > 0) {
    throw new Error(
      `Missing Cloudflare deployment setup: ${missingScaffolding.join(", ")}. Run \`vinext init --platform=cloudflare\` first.`,
    );
  }
  const missingDeps = getMissingDeps(info);
  if (missingDeps.length > 0) {
    throw new Error(
      `Missing deployment dependencies: ${missingDeps.map((dependency) => dependency.name).join(", ")}. Run \`vinext init --platform=cloudflare\` first.`,
    );
  }

  // Fail if an existing Vite config is missing the Cloudflare plugin.
  // This is the most common cause of "could not resolve virtual:vinext-rsc-entry"
  // errors — `vinext init --platform=cloudflare` adds it via an AST update.
  if (info.hasViteConfig && !viteConfigHasCloudflarePlugin(root)) {
    throw new Error(formatMissingCloudflarePluginError({ isAppRouter: info.isAppRouter }));
  }

  // Fail if the app uses ISR/caching but no cache adapter is configured. vinext
  // no longer scaffolds a KV cache handler into the Worker entry — the backend
  // must be declared via `vinext({ cache })` so deploys don't silently fall
  // back to the in-memory handler (which loses all cached data per isolate).
  //
  // For backwards compat, older apps that wired a cache backend imperatively in
  // their Worker entry (setCacheHandler / setDataCacheHandler / setCdnCacheAdapter)
  // are still considered configured and must not be blocked.
  if (info.hasISR && !viteConfigHasCacheAdapter(root) && !workerEntryHasCacheHandler(root)) {
    throw new Error(formatMissingCacheAdapterError({}));
  }

  if (!viteConfigHasImageAdapter(root)) {
    console.log();
    console.log(formatImageOptimizationHint());
  }

  if (options.dryRun) {
    console.log("\n  Dry run complete. No build or deploy performed.\n");
    return;
  }

  const buildEnv = deployEnv === "production" && !options.env ? undefined : deployEnv;
  // This load is intentionally eager: inline `vinext({ nextConfig })` can decide
  // export/prerender behavior, so deploy cannot safely short-circuit before reading it.
  const viteConfigMetadata = await withCloudflareEnv(buildEnv, () =>
    loadDeployViteConfigMetadata(info.root),
  );
  const cdnAdapterConfig = resolveCdnAdapterConfig(viteConfigMetadata.cacheConfig);
  const nextConfig = await withCloudflareEnv(buildEnv, async () => {
    const inlineNextConfig = viteConfigMetadata.nextConfig;
    const rawNextConfig = inlineNextConfig
      ? await resolveNextConfigInput(inlineNextConfig, PHASE_PRODUCTION_BUILD)
      : await loadNextConfig(info.root, PHASE_PRODUCTION_BUILD);
    return resolveNextConfig(rawNextConfig, info.root);
  });

  const shouldLoadVinextPrerenderConfig = !options.prerenderAll && nextConfig.output !== "export";
  const vinextPrerenderConfig = shouldLoadVinextPrerenderConfig
    ? viteConfigMetadata.prerenderConfig
    : null;
  const prerenderDecision = resolveVinextPrerenderDecision({
    prerenderAllFlag: options.prerenderAll,
    vinextPrerenderConfig,
    nextOutput: nextConfig.output,
  });
  const hasStrictResponseVary = hasVerbatimResponseVary(viteConfigMetadata.cacheConfig);
  const hasBuildIdentityHeader = hasBuildIdentityResponseHeader(viteConfigMetadata.cacheConfig);
  const needsCacheabilityProbeManifest = projectRequiresRouteCacheabilityProbeManifest(
    info,
    viteConfigMetadata.cacheConfig,
  );
  const shouldEmitPrerenderPathManifest = !options.skipBuild && prerenderDecision;
  // Step 5: Build
  if (!options.skipBuild) {
    await runBuild(info, buildEnv);
  } else {
    console.log("\n  Skipping build (--skip-build)");
  }

  if (options.warmCdnCache && cdnAdapterConfig) {
    const wrangler = await loadProjectWranglerApi(info.root);
    const previousCwd = process.cwd();
    try {
      // Wrangler resolves its generated deploy redirect relative to cwd.
      process.chdir(info.root);
      const config = wrangler.unstable_readConfig(
        { config: options.config, env: buildEnv },
        {
          hideWarnings: true,
          preserveOriginalMain: true,
          useRedirectIfAvailable: true,
        },
      );
      assertCdnVersionMetadataConfig({
        binding: cdnAdapterConfig.versionMetadataBinding,
        configuredBinding: config.version_metadata?.binding,
        configPath: config.configPath,
      });
    } finally {
      process.chdir(previousCwd);
    }
  }

  if (shouldEmitPrerenderPathManifest) {
    await emitPrerenderPathManifest({
      root: info.root,
      nextConfig,
      buildIdentity: hasBuildIdentityHeader ? "response-header" : undefined,
      responseVary: hasStrictResponseVary ? "verbatim" : undefined,
      routeRootConfig: viteConfigMetadata.routeRootConfig,
    });
  }

  // Step 6a: prerender — render every discovered route into dist.
  // Triggered only by --prerender-all, vinext({ prerender: true }), or
  // output: 'export'. CDN warmup performs path discovery above, but relies on
  // the deployed Worker to render and classify each response.
  let ranPrerender = false;
  if (prerenderDecision) {
    console.log(`\n  ${formatVinextPrerenderLabel(prerenderDecision)}`);
    if (nextConfig.enablePrerenderSourceMaps) {
      process.setSourceMapsEnabled(true);
      Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 50);
    }
    await runPrerender({
      root: info.root,
      concurrency: options.prerenderConcurrency,
      nextConfig,
    });
    ranPrerender = true;
  }

  if (ranPrerender) {
    try {
      await populateKVCacheFromPrerenderedArtifacts(
        root,
        deployEnv === "production" && !options.env ? undefined : deployEnv,
        viteConfigMetadata.cacheConfig,
      );
    } catch (error) {
      console.log(
        `  KV cache: Skipping prerender upload (${formatUnknownError(error)}). Continuing with deploy.`,
      );
    }
  }

  // Step 6b: TPR — pre-render hot pages into KV cache (experimental, opt-in)
  if (options.experimentalTPR) {
    console.log();
    const tprResult = await runTPR({
      root,
      config: options.config,
      coverage: Math.max(1, Math.min(100, options.tprCoverage ?? 90)),
      limit: Math.max(1, options.tprLimit ?? 1000),
      window: Math.max(1, options.tprWindow ?? 24),
    });

    if (tprResult.skipped) {
      console.log(`  TPR: Skipped (${tprResult.skipped})`);
    }
  }

  // Step 7: Deploy via wrangler
  const wranglerOptions = {
    env: deployEnv === "production" && !options.env ? undefined : deployEnv,
    name: options.name,
    config: options.config,
    verbose: options.verbose,
  };
  let url: string;

  if (options.warmCdnCache) {
    url = await deployWithCdnWarmup(root, [], {
      ...wranglerOptions,
      cacheabilityProbe: needsCacheabilityProbeManifest,
      discoverWarmPlan: async ({ headers, targetUrl }) => {
        await emitPrerenderPathManifest({
          root: info.root,
          nextConfig,
          buildIdentity: hasBuildIdentityHeader ? "response-header" : undefined,
          responseVary: hasStrictResponseVary ? "verbatim" : undefined,
          routeRootConfig: viteConfigMetadata.routeRootConfig,
          pathDiscoveryTarget: {
            baseUrl: targetUrl,
            headers,
            phaseTimeoutMs:
              options.warmCdnDiscoveryTimeout ?? DEFAULT_REMOTE_PATH_DISCOVERY_PHASE_TIMEOUT_MS,
            retries: options.warmCdnDiscoveryRetries,
            retryDelayMs: DEFAULT_REMOTE_PATH_DISCOVERY_RETRY_DELAY_MS,
          },
        });
        return readPrerenderWarmPlan(root, {
          includeFallbackShells: options.warmCdnIncludeFallbacks,
          strict: options.warmCdnCertify === true || !options.dangerouslyPromoteOnCdnWarmError,
        });
      },
      warmCdnConcurrency: options.warmCdnConcurrency,
      warmCdnTarget,
      warmCdnTimeout: options.warmCdnTimeout,
      warmCdnRetries: options.warmCdnRetries,
      warmCdnDiscoveryTimeout: options.warmCdnDiscoveryTimeout,
      warmCdnDiscoveryRetries: options.warmCdnDiscoveryRetries,
      warmCdnProbeTimeout: options.warmCdnProbeTimeout,
      warmCdnProbeRetries: options.warmCdnProbeRetries,
      warmCdnCertify: options.warmCdnCertify,
      warmCdnReadinessTimeout: options.warmCdnReadinessTimeout,
      warmCdnReadinessRetries: options.warmCdnReadinessRetries,
      warmCdnReadinessProbes: options.warmCdnReadinessProbes,
      warmCdnReadinessProbeDelay: options.warmCdnReadinessProbeDelay,
      dangerouslyPromoteOnCdnWarmError: options.dangerouslyPromoteOnCdnWarmError,
      warmCdnPromote: options.warmCdnPromote,
      warmCdnPromotionDelay: options.warmCdnPromotionDelay,
    });
  } else {
    url = await runWranglerDeploy(root, wranglerOptions);
  }

  console.log("\n  ─────────────────────────────────────────");
  console.log(`  Deployed to: ${url}`);
  console.log("  ─────────────────────────────────────────\n");
}
