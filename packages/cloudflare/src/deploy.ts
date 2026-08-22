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
import { emitPrerenderPathManifest } from "vinext/internal/build/prerender-paths";
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
  formatMissingCloudflarePluginError,
  getMissingDeps,
  type ProjectInfo,
} from "vinext/internal/utils/project";
import { runTPR } from "./tpr.js";
import { readPrerenderWarmPaths } from "./cdn-warm.js";
import { deployWithCdnWarmup, type CdnWarmupOptions } from "./cdn-warm-deployment.js";
import { formatUnknownError } from "./utils/format-unknown-error.js";
import {
  buildNodeCliInvocation,
  resolveWranglerBin,
  validateWranglerEnvName,
  type WranglerTargetOptions,
} from "./wrangler-cli.js";
import {
  formatMissingCacheAdapterError,
  formatImageOptimizationHint,
  resolveKvDataAdapterConfig,
  viteConfigHasCacheAdapter,
  viteConfigHasCloudflarePlugin,
  viteConfigHasImageAdapter,
  workerEntryHasCacheHandler,
} from "./deploy-config.js";
import { parseWorkerDeploymentUrl } from "./worker-deployment-url.js";
import { PHASE_PRODUCTION_BUILD } from "vinext/shims/constants";
import { buildPrerenderKVPairs, type KVBulkPair } from "./prerender-kv-populate.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type DeployOptions = WranglerTargetOptions &
  CdnWarmupOptions & {
    /** Project root directory */
    root: string;
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

async function loadDeployViteConfigMetadata(root: string): Promise<DeployViteConfigMetadata> {
  const vite = await loadProjectViteApi(root);
  const loaded = await vite.loadConfigFromFile(
    { command: "build", mode: "production" },
    undefined,
    root,
  );
  const plugins = loaded?.config.plugins;
  return {
    cacheConfig: viteConfigHasCacheAdapter(root)
      ? await findVinextCacheConfigInPlugins(plugins)
      : null,
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
  const canVerifyCdnWarmup = nextConfig.output !== "export";
  const shouldEmitPrerenderPathManifest =
    (options.warmCdnCache && canVerifyCdnWarmup) || (!options.skipBuild && prerenderDecision);

  // Step 5: Build
  if (!options.skipBuild) {
    await runBuild(info, buildEnv);
  } else {
    console.log("\n  Skipping build (--skip-build)");
  }

  if (shouldEmitPrerenderPathManifest) {
    await emitPrerenderPathManifest({
      root: info.root,
      nextConfig,
      routeRootConfig: viteConfigMetadata.routeRootConfig,
    });
  }

  // Step 6a: prerender — render every discovered route into dist.
  // Triggered by --prerender-all, vinext({ prerender: true }), or automatically
  // when next.config.js sets `output: 'export'` (every route must be statically
  // exportable). The CLI flag wins when more than one trigger is present.
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
  };
  let url: string;
  // Non-null only on the CDN-warmup path, so the closing summary can say
  // plainly whether the promoted version's cache is actually pre-warmed —
  // a bare "Deployed to" line reads as success even when non-strict mode
  // fell back to promoting an unconfirmed version.
  let warmupStatus: string | null = null;

  if (options.warmCdnCache && !canVerifyCdnWarmup) {
    console.log(
      "\n  CDN warmup skipped: static exports are served by Cloudflare Assets without invoking the Worker, so Worker version metadata cannot verify them.",
    );
    url = await runWranglerDeploy(root, wranglerOptions);
  } else if (options.warmCdnCache) {
    const warmPaths = readPrerenderWarmPaths(root, {
      includeFallbackShells: options.warmCdnIncludeFallbacks,
      strict: options.warmCdnStrict,
    });
    if (warmPaths.length > 0) {
      const result = await deployWithCdnWarmup(root, warmPaths, {
        ...wranglerOptions,
        warmCdnConcurrency: options.warmCdnConcurrency,
        warmCdnTimeout: options.warmCdnTimeout,
        warmCdnRetries: options.warmCdnRetries,
        warmCdnStrict: options.warmCdnStrict,
      });
      url = result.url;
      warmupStatus = result.warmed
        ? "CDN cache: pre-warmed and confirmed before this version took traffic."
        : "CDN cache: NOT confirmed pre-warmed — promoted without a verified warm-up.";
    } else {
      console.log("\n  CDN warmup skipped: no build-discovered paths found.");
      url = await runWranglerDeploy(root, wranglerOptions);
    }
  } else {
    url = await runWranglerDeploy(root, wranglerOptions);
  }

  console.log("\n  ─────────────────────────────────────────");
  console.log(`  Deployed to: ${url}`);
  if (warmupStatus) console.log(`  ${warmupStatus}`);
  console.log("  ─────────────────────────────────────────\n");
}
