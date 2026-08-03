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
import {
  emitPrerenderPathManifest,
  type PrerenderPathManifest,
} from "vinext/internal/build/prerender-paths";
import { resolveRscCacheKeyMode } from "vinext/internal/cache-adapters";
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
import {
  probeWorkerVersion,
  readPrerenderWarmPlan,
  warmCdnCache,
  type CdnWarmOptions,
} from "./cdn-warm.js";
import {
  formatMissingCacheAdapterError,
  formatImageOptimizationHint,
  resolveKvDataAdapterConfig,
  viteConfigHasCacheAdapter,
  viteConfigHasCloudflarePlugin,
  viteConfigHasImageAdapter,
  workerEntryHasCacheHandler,
} from "./deploy-config.js";
import {
  runWranglerDeploymentStatus,
  runWranglerTriggersDeploy,
  runWranglerVersionDeploy,
  runWranglerVersionUpload,
  type WranglerDeploymentStatus,
  type WranglerVersionTraffic,
} from "./version-deploy.js";
import { parseWorkerDeploymentUrl } from "./worker-deployment-url.js";
import { PHASE_PRODUCTION_BUILD } from "vinext/shims/constants";
import { buildPrerenderKVPairs, type KVBulkPair } from "./prerender-kv-populate.js";

function readBuiltPrerenderPathManifest(root: string): PrerenderPathManifest | null {
  try {
    const serverDir = path.join(root, "dist", "server");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(serverDir, "vinext-prerender-paths.json"), "utf-8"),
    ) as PrerenderPathManifest;
    const buildId = fs.readFileSync(path.join(serverDir, "BUILD_ID"), "utf-8").trim();
    if (manifest.buildId !== buildId || !Array.isArray(manifest.paths)) return null;
    return manifest;
  } catch {
    return null;
  }
}

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
  /** Pre-render all discovered routes into the dist output after building */
  prerenderAll?: boolean;
  /** Maximum number of routes to prerender in parallel */
  prerenderConcurrency?: number;
  /** Warm Cloudflare's CDN cache by requesting build-discovered paths for the uploaded version */
  warmCdnCache?: boolean;
  /** Maximum number of CDN warmup requests to issue in parallel */
  warmCdnConcurrency?: number;
  /** Per-request CDN warmup timeout in milliseconds */
  warmCdnTimeout?: number;
  /** Number of CDN warmup retries for transient failures */
  warmCdnRetries?: number;
  /** Fail deployment if any CDN warmup request fails */
  warmCdnStrict?: boolean;
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

export type WranglerCommandOptions = Pick<DeployOptions, "preview" | "env" | "name" | "config">;

type ProjectViteApi = Pick<typeof import("vite"), "createBuilder" | "loadConfigFromFile">;

export type DeployViteConfigMetadata = {
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
  "prerender-all": { type: "boolean", default: false },
  "prerender-concurrency": { type: "string" },
  "experimental-warm-cdn-cache": { type: "boolean", default: false },
  "warm-cdn-concurrency": { type: "string" },
  "warm-cdn-timeout": { type: "string" },
  "warm-cdn-retries": { type: "string" },
  "warm-cdn-strict": { type: "boolean", default: false },
  "warm-cdn-include-fallbacks": { type: "boolean", default: false },
  "experimental-tpr": { type: "boolean", default: false },
  "tpr-coverage": { type: "string" },
  "tpr-limit": { type: "string" },
  "tpr-window": { type: "string" },
} as const;

export function parseDeployArgs(args: string[]) {
  const { values } = nodeParseArgs({ args, options: deployArgOptions, strict: true });

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
    prerenderAll: values["prerender-all"],
    prerenderConcurrency:
      values["prerender-concurrency"] === undefined
        ? undefined
        : parsePositiveIntegerArg(values["prerender-concurrency"], "--prerender-concurrency"),
    warmCdnCache: values["experimental-warm-cdn-cache"],
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
    warmCdnStrict: values["warm-cdn-strict"],
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

export async function loadDeployViteConfigMetadata(
  root: string,
): Promise<DeployViteConfigMetadata> {
  const vite = await loadProjectViteApi(root);
  const loaded = await vite.loadConfigFromFile(
    { command: "build", mode: "production" },
    undefined,
    root,
  );
  const plugins = loaded?.config.plugins;
  return {
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

export function buildWranglerDeployArgs(options: WranglerCommandOptions): WranglerDeployArgs {
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
  options: WranglerCommandOptions,
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
  options: WranglerCommandOptions,
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

type ResolvedWranglerCommandConfig = {
  commandOptions: WranglerCommandOptions;
  /** Source config for Wrangler commands that do not opt into deploy redirects. */
  controlPlaneCommandOptions?: WranglerCommandOptions;
  inspectionConfig?: string;
};

function readGeneratedWranglerConfigPath(root: string): string | null {
  const redirectPath = path.join(root, ".wrangler", "deploy", "config.json");
  try {
    const redirect = JSON.parse(fs.readFileSync(redirectPath, "utf-8")) as {
      configPath?: unknown;
    };
    if (typeof redirect.configPath !== "string" || redirect.configPath.length === 0) return null;
    const generatedPath = path.resolve(path.dirname(redirectPath), redirect.configPath);
    return fs.existsSync(generatedPath) ? generatedPath : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the config that Wrangler will actually execute after the Cloudflare
 * Vite plugin has emitted its deploy redirect.
 *
 * Passing any config through `--config` disables Wrangler's deploy redirect.
 * If the explicit config selected the generated build, omit `--config` so
 * Wrangler discovers `.wrangler/deploy/config.json` and retains redirected
 * config semantics (target-environment validation and service/environment
 * grouping metadata). Pin the generated environment and final Worker name on
 * the CLI so ambient state cannot retarget it.
 */
export function resolveWranglerCommandConfig(
  root: string,
  options: WranglerCommandOptions,
): ResolvedWranglerCommandConfig {
  const generatedPath = readGeneratedWranglerConfigPath(root);
  const selectedEnv = options.env || (options.preview ? "preview" : undefined);

  if (!generatedPath) {
    const explicitConfig = options.config ? parseWranglerConfig(root, options.config) : null;
    const flattenedEnv = explicitConfig?.targetEnvironment;
    if (flattenedEnv && explicitConfig?.userConfigPath) {
      throw new Error(
        `Generated Wrangler config ${options.config} was built for env ${flattenedEnv}, but its .wrangler/deploy/config.json redirect is missing. Rebuild and deploy from the project root so Wrangler can preserve generated-config environment semantics.`,
      );
    }
    if (flattenedEnv && selectedEnv && flattenedEnv !== selectedEnv) {
      throw new Error(
        `Wrangler config was built for env ${flattenedEnv}, but deploy selected env ${selectedEnv}. Rebuild for the selected environment before deploying.`,
      );
    }
    return {
      commandOptions: {
        ...options,
        env: selectedEnv ?? flattenedEnv,
        ...(flattenedEnv && !options.name && explicitConfig?.name
          ? { name: explicitConfig.name }
          : {}),
      },
      inspectionConfig: options.config,
    };
  }

  const generatedRelativePath = path.relative(root, generatedPath);
  const generatedConfig = parseWranglerConfig(root, generatedRelativePath);
  const explicitPath = options.config ? path.resolve(root, options.config) : null;
  const generatedUserPath = generatedConfig?.userConfigPath
    ? path.resolve(root, generatedConfig.userConfigPath)
    : null;
  const explicitSelectsGeneratedBuild =
    explicitPath !== null &&
    (explicitPath === generatedPath ||
      (generatedUserPath !== null && explicitPath === generatedUserPath));

  if (!options.config) {
    // Leave argv untouched so Wrangler performs and validates its own redirect,
    // but inspect the generated config because that is the deployed artifact.
    // Pin its build-selected environment on the CLI so an unrelated ambient
    // CLOUDFLARE_ENV cannot retarget the command.
    return {
      commandOptions: { ...options, env: selectedEnv ?? generatedConfig?.targetEnvironment },
      inspectionConfig: generatedRelativePath,
    };
  }

  if (!explicitSelectsGeneratedBuild) {
    const explicitConfig = parseWranglerConfig(root, options.config);
    const flattenedEnv = explicitConfig?.targetEnvironment;
    if (flattenedEnv && selectedEnv && flattenedEnv !== selectedEnv) {
      throw new Error(
        `Wrangler config was built for env ${flattenedEnv}, but deploy selected env ${selectedEnv}. Rebuild for the selected environment before deploying.`,
      );
    }
    return {
      commandOptions: {
        ...options,
        env: selectedEnv ?? flattenedEnv,
        ...(flattenedEnv && !options.name && explicitConfig?.name
          ? { name: explicitConfig.name }
          : {}),
      },
      inspectionConfig: options.config,
    };
  }

  const flattenedEnv = generatedConfig?.targetEnvironment;
  if (flattenedEnv && selectedEnv && flattenedEnv !== selectedEnv) {
    throw new Error(
      `Generated Wrangler config was built for env ${flattenedEnv}, but deploy selected env ${selectedEnv}. Rebuild for the selected environment before deploying.`,
    );
  }
  const commandOptions = { ...options };
  delete commandOptions.config;
  const controlPlaneConfig = generatedUserPath ? path.relative(root, generatedUserPath) : undefined;
  return {
    commandOptions: {
      ...commandOptions,
      config: undefined,
      env: selectedEnv ?? flattenedEnv,
      ...(flattenedEnv && !options.name && generatedConfig?.name
        ? { name: generatedConfig.name }
        : {}),
    },
    controlPlaneCommandOptions: {
      ...options,
      config: controlPlaneConfig,
      env: selectedEnv ?? flattenedEnv,
      ...(flattenedEnv && !options.name && generatedConfig?.name
        ? { name: generatedConfig.name }
        : {}),
    },
    inspectionConfig: generatedRelativePath,
  };
}

export async function deployWithCdnWarmup(
  root: string,
  paths: readonly string[],
  options: Pick<
    DeployOptions,
    | "preview"
    | "env"
    | "name"
    | "config"
    | "warmCdnConcurrency"
    | "warmCdnTimeout"
    | "warmCdnRetries"
    | "warmCdnStrict"
  > &
    Pick<CdnWarmOptions, "deploymentId" | "rscCacheKeyMode" | "rscPaths">,
): Promise<string> {
  const resolvedWrangler = resolveWranglerCommandConfig(root, options);
  const wranglerOptions = { ...options, ...resolvedWrangler.commandOptions };
  const controlPlaneWranglerOptions = {
    ...options,
    ...(resolvedWrangler.controlPlaneCommandOptions ?? resolvedWrangler.commandOptions),
  };
  const targetResolutionOptions = {
    ...wranglerOptions,
    config: resolvedWrangler.inspectionConfig,
  };
  const wranglerConfig = parseWranglerConfig(root, resolvedWrangler.inspectionConfig);
  const targetEnv = getWranglerTargetEnv(wranglerOptions);
  const isFlattenedTargetConfig =
    targetEnv !== undefined && wranglerConfig?.targetEnvironment === targetEnv;
  // Wrangler does not inherit version_metadata into named environments.
  // Inspect only the selected scope so an unrelated root binding cannot make
  // an environment deploy fail validation (or appear to have the binding).
  // Generated deploy configs are already flattened to targetEnvironment, so
  // their root is the selected scope and must not be looked up under env again.
  const versionMetadataBinding =
    targetEnv && !isFlattenedTargetConfig
      ? wranglerConfig?.env?.[targetEnv]?.versionMetadataBinding
      : wranglerConfig?.versionMetadataBinding;
  if (versionMetadataBinding && versionMetadataBinding !== "VINEXT_VERSION_METADATA") {
    throw new Error(
      `CDN warming requires the version metadata binding to be named "VINEXT_VERSION_METADATA", but Wrangler config uses "${versionMetadataBinding}"${targetEnv ? ` for env ${targetEnv}` : ""}. Run vinext init and update the binding before deploying.`,
    );
  }
  // Wrangler inherits cache as a whole object, unlike version_metadata. An
  // environment-local cache object replaces the root cache object.
  const effectiveCache =
    targetEnv && !isFlattenedTargetConfig
      ? (wranglerConfig?.env?.[targetEnv]?.cache ?? wranglerConfig?.cache)
      : wranglerConfig?.cache;
  const crossVersionCache = effectiveCache?.crossVersionCache === true;
  if (crossVersionCache && options.warmCdnStrict) {
    throw new Error(
      "CDN warmup cannot safely refresh cache.cross_version_cache entries without purging the previous version. Disable cross-version caching or rerun without --warm-cdn-strict.",
    );
  }

  // Wrangler's Versions API commands address script versions and do not
  // support named service environments (`legacy_env = false`). Keep ordinary
  // deploy semantics for those environments instead of staging the wrong
  // Worker. Strict mode fails closed because it cannot provide pre-traffic
  // warming for that target.
  if (targetEnv && wranglerConfig?.legacyEnv === false) {
    const message = `CDN warmup cannot stage named service environment ${targetEnv}; Wrangler versions commands do not support service-environment deployments.`;
    if (options.warmCdnStrict) throw new Error(message);
    console.warn(`  ${message} Falling back to ordinary deployment without CDN warming.`);
    return runWranglerDeploy(root, wranglerOptions);
  }

  const upload = runWranglerVersionUpload(root, wranglerOptions);
  const deploymentStatus = readWranglerDeploymentStatus(root, controlPlaneWranglerOptions);
  const stagingTraffic = getZeroPercentStagingTraffic(deploymentStatus, upload.versionId);
  let staged: ReturnType<typeof runWranglerVersionDeploy> | null = null;
  let triggersDeployedUrl: string | null = null;
  let warmedBeforePromotion = false;
  let triggersApplied = false;

  function applyTriggers(): void {
    if (triggersApplied) return;
    triggersDeployedUrl = runWranglerTriggersDeploy(root, controlPlaneWranglerOptions).deployedUrl;
    triggersApplied = true;
  }

  if (crossVersionCache) {
    console.warn(
      "  CDN warmup skipped: cache.cross_version_cache may serve the previous version's entry, and warming cannot safely replace it without a purge.",
    );
  } else if (stagingTraffic) {
    staged = runWranglerVersionDeploy(root, stagingTraffic, wranglerOptions, "stage");
    const targetUrl = resolveCdnWarmupTargetUrl(root, staged.deployedUrl, targetResolutionOptions);
    const workerName = resolveWorkerNameForVersionOverride(wranglerConfig, wranglerOptions);
    const headers = buildVersionOverrideHeaders(workerName, upload.versionId);
    if (targetUrl && headers) {
      const probePath = paths[0] ?? options.rscPaths?.[0];
      const probe = probePath
        ? await probeWorkerVersion({
            targetUrl,
            pathname: probePath,
            versionId: upload.versionId,
            headers,
            timeoutMs: options.warmCdnTimeout,
          })
        : { verified: false as const, reason: "not-ready" as const };
      if (probe.verified) {
        try {
          await warmCdnCache({
            targetUrl,
            paths,
            headers,
            deploymentId: options.deploymentId,
            concurrency: options.warmCdnConcurrency,
            timeoutMs: options.warmCdnTimeout,
            retries: options.warmCdnRetries,
            rscCacheKeyMode: options.rscCacheKeyMode,
            rscPaths: options.rscPaths,
            strict: options.warmCdnStrict,
          });
        } catch (error) {
          throw withStagedVersionCleanupNote(error);
        }
        warmedBeforePromotion = true;
      } else if (probe.reason === "binding-unavailable") {
        if (options.warmCdnStrict) {
          throw withStagedVersionCleanupNote(
            new Error(
              "CDN warmup failed: staged version could not be verified because VINEXT_VERSION_METADATA is unavailable. No cacheable requests were sent.",
            ),
          );
        }
        console.warn(
          "  CDN warmup: staged version could not be verified because VINEXT_VERSION_METADATA is unavailable; promoting before warming.",
        );
      } else {
        console.warn(
          "  CDN warmup: staged version override did not become verifiable in time; promoting before warming.",
        );
      }
    } else {
      console.warn(
        "  CDN warmup: pre-traffic warmup needs a production URL and Worker name for version overrides; promoting before warming.",
      );
    }
  } else {
    console.warn(
      "  CDN warmup: pre-traffic version override skipped because the current deployment is not a single 100% version.",
    );
  }

  const deployed = runWranglerVersionDeploy(
    root,
    [{ versionId: upload.versionId, percentage: 100 }],
    wranglerOptions,
    warmedBeforePromotion ? "promote-warmed" : "promote-uploaded",
  );
  try {
    // Full trigger deployment also mutates crons, queue consumers, workflows,
    // routes, and workers.dev state. Apply it only after promotion so new
    // triggers can never invoke the previous 100%-traffic version, and a
    // failed strict prewarm leaves triggers untouched.
    applyTriggers();
  } catch (error) {
    throw withPromotedVersionTriggerNote(error);
  }
  if (!warmedBeforePromotion && !crossVersionCache) {
    const targetUrl = resolveCdnWarmupTargetUrl(
      root,
      deployed.deployedUrl ?? triggersDeployedUrl,
      targetResolutionOptions,
    );
    if (targetUrl) {
      const probePath = paths[0] ?? options.rscPaths?.[0];
      const probe = probePath
        ? await probeWorkerVersion({
            targetUrl,
            pathname: probePath,
            versionId: upload.versionId,
            timeoutMs: options.warmCdnTimeout,
          })
        : { verified: true as const };
      if (probe.verified) {
        await warmCdnCache({
          targetUrl,
          paths,
          deploymentId: options.deploymentId,
          concurrency: options.warmCdnConcurrency,
          timeoutMs: options.warmCdnTimeout,
          retries: options.warmCdnRetries,
          rscCacheKeyMode: options.rscCacheKeyMode,
          rscPaths: options.rscPaths,
          strict: options.warmCdnStrict,
        });
      } else {
        const reason =
          probe.reason === "binding-unavailable"
            ? "VINEXT_VERSION_METADATA is unavailable"
            : "the promoted version did not become verifiable in time";
        const message =
          `CDN warmup skipped after Worker version ${upload.versionId} was promoted to 100%: ${reason}. ` +
          "No cacheable requests were sent.";
        if (options.warmCdnStrict) throw new Error(message);
        console.warn(`  ${message}`);
      }
    } else if (options.warmCdnStrict) {
      throw new Error(
        "CDN warmup failed: no production URL could be inferred from wrangler config or output. " +
          "Configure a route/custom domain, ensure Wrangler prints a workers.dev URL, or rerun without --warm-cdn-strict.",
      );
    } else {
      console.warn(
        "  CDN warmup skipped: no production URL could be inferred from wrangler config or output.",
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

export function resolveCdnWarmupTargetUrl(root: string, deployedUrl: string | null): string | null;
export function resolveCdnWarmupTargetUrl(
  root: string,
  deployedUrl: string | null,
  options: Pick<DeployOptions, "preview" | "env" | "config">,
): string | null;
export function resolveCdnWarmupTargetUrl(
  root: string,
  deployedUrl: string | null,
  options?: Pick<DeployOptions, "preview" | "env" | "config">,
): string | null {
  const config = parseWranglerConfig(root, options?.config);
  const env = getWranglerTargetEnv(options ?? {});
  const customDomain = (env ? config?.env?.[env]?.customDomain : undefined) ?? config?.customDomain;
  if (customDomain) {
    return `https://${customDomain}`;
  }
  return deployedUrl;
}

function readWranglerDeploymentStatus(
  root: string,
  options: Pick<DeployOptions, "preview" | "env" | "name" | "config">,
): WranglerDeploymentStatus | null {
  try {
    return runWranglerDeploymentStatus(root, options);
  } catch {
    return null;
  }
}

export function getZeroPercentStagingTraffic(
  deployment: WranglerDeploymentStatus | null,
  versionId: string,
): WranglerVersionTraffic[] | null {
  const current = deployment?.versions ?? [];
  if (current.length !== 1 || current[0].percentage !== 100) return null;
  if (current[0].versionId === versionId) return null;
  return [current[0], { versionId, percentage: 0 }];
}

function getWranglerTargetEnv(options: Pick<DeployOptions, "preview" | "env">): string | undefined {
  return options.env || (options.preview ? "preview" : undefined);
}

type ParsedWranglerConfig = NonNullable<ReturnType<typeof parseWranglerConfig>>;

export function resolveWorkerNameForVersionOverride(
  config: ParsedWranglerConfig | null,
  options: Pick<DeployOptions, "preview" | "env" | "name">,
): string | undefined {
  if (options.name) return options.name;
  const env = getWranglerTargetEnv(options);
  if (!env) return config?.name;
  if (config?.targetEnvironment === env) return config.name;
  if (config?.legacyEnv === false) return config.name;
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
  };
}

function withStagedVersionCleanupNote(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message} ${getStagedVersionCleanupNote()}`, { cause: error });
}

function getStagedVersionCleanupNote(): string {
  return (
    "The uploaded version may remain staged at 0% with the previous version still serving 100% traffic; " +
    "rerun deploy to promote it or use `wrangler versions deploy` to choose the desired version split."
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

// ─── Main Entry ──────────────────────────────────────────────────────────────

export async function deploy(options: DeployOptions): Promise<void> {
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

  const buildEnv = deployEnv === "production" && !options.env ? undefined : deployEnv;
  // This load is intentionally eager: inline `vinext({ nextConfig })` can decide
  // export/prerender behavior and non-literal cache config cannot be validated
  // from source text, so deploy cannot safely short-circuit before reading it.
  const viteConfigMetadata = await withCloudflareEnv(buildEnv, () =>
    loadDeployViteConfigMetadata(info.root),
  );

  // Fail if the app uses ISR/caching but no cache adapter is configured. Prefer
  // the loaded plugin metadata so descriptors referenced through variables or
  // functions are recognized; retain the source check as a lenient fallback
  // for older/custom plugin configurations. Imperative Worker registration is
  // also supported for backwards compatibility.
  const hasLoadedCacheAdapter = Boolean(
    viteConfigMetadata.cacheConfig?.cdn?.adapter || viteConfigMetadata.cacheConfig?.data?.adapter,
  );
  if (
    info.hasISR &&
    !hasLoadedCacheAdapter &&
    !viteConfigHasCacheAdapter(root) &&
    !workerEntryHasCacheHandler(root)
  ) {
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
  const shouldEmitPrerenderPathManifest =
    options.warmCdnCache || (!options.skipBuild && prerenderDecision);

  // Step 5: Build
  if (!options.skipBuild) {
    await runBuild(info, buildEnv);
  } else {
    console.log("\n  Skipping build (--skip-build)");
  }

  const builtPrerenderPathManifest = options.skipBuild
    ? readBuiltPrerenderPathManifest(info.root)
    : null;
  const builtRscCacheKeyMode = builtPrerenderPathManifest
    ? (builtPrerenderPathManifest.rscCacheKeyMode ?? "header-digest")
    : undefined;
  const resolvedRscCacheKeyMode =
    builtRscCacheKeyMode ?? resolveRscCacheKeyMode(viteConfigMetadata.cacheConfig);
  let prerenderPathManifest: Awaited<ReturnType<typeof emitPrerenderPathManifest>> =
    builtPrerenderPathManifest;
  if (shouldEmitPrerenderPathManifest && !builtPrerenderPathManifest) {
    prerenderPathManifest = await emitPrerenderPathManifest({
      root: info.root,
      nextConfig,
      preserveBuildMetadata: options.skipBuild,
      rscCacheKeyMode: resolvedRscCacheKeyMode,
      routeRootConfig: viteConfigMetadata.routeRootConfig,
    });
  }

  // Step 6a: prerender — render every discovered route into dist.
  // Triggered by --prerender-all, vinext({ prerender: true }), or automatically
  // when next.config.js sets `output: 'export'` (every route must be statically
  // exportable). The CLI flag wins when more than one trigger is present.
  let ranPrerender = false;
  if (prerenderDecision || options.warmCdnCache) {
    console.log(
      `\n  ${
        prerenderDecision
          ? formatVinextPrerenderLabel(prerenderDecision)
          : "Pre-rendering cacheable routes for CDN warmup..."
      }`,
    );
    if (nextConfig.enablePrerenderSourceMaps) {
      process.setSourceMapsEnabled(true);
      Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 50);
    }
    await runPrerender({
      root: info.root,
      concurrency: options.prerenderConcurrency,
      injectPregeneratedPaths: Boolean(prerenderDecision),
      nextConfig,
      rscCacheKeyMode: prerenderPathManifest?.rscCacheKeyMode ?? resolvedRscCacheKeyMode,
    });
    ranPrerender = true;
  }

  if (ranPrerender && prerenderDecision) {
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
  };
  let url: string;

  if (options.warmCdnCache) {
    const warmPlan = readPrerenderWarmPlan(root, {
      includeFallbackShells: options.warmCdnIncludeFallbacks,
      strict: options.warmCdnStrict,
    });
    if (warmPlan.paths.length > 0) {
      url = await deployWithCdnWarmup(root, warmPlan.paths, {
        ...wranglerOptions,
        deploymentId: warmPlan.deploymentId,
        rscCacheKeyMode: warmPlan.rscCacheKeyMode,
        rscPaths: warmPlan.rscPaths,
        warmCdnConcurrency: options.warmCdnConcurrency,
        warmCdnTimeout: options.warmCdnTimeout,
        warmCdnRetries: options.warmCdnRetries,
        warmCdnStrict: options.warmCdnStrict,
      });
    } else {
      console.log("\n  CDN warmup skipped: no build-discovered paths found.");
      url = await runWranglerDeploy(
        root,
        resolveWranglerCommandConfig(root, wranglerOptions).commandOptions,
      );
    }
  } else {
    url = await runWranglerDeploy(
      root,
      resolveWranglerCommandConfig(root, wranglerOptions).commandOptions,
    );
  }

  console.log("\n  ─────────────────────────────────────────");
  console.log(`  Deployed to: ${url}`);
  console.log("  ─────────────────────────────────────────\n");
}
