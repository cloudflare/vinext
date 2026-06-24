/**
 * vinext deploy — one-command Cloudflare Workers deployment.
 *
 * Takes any Next.js app and deploys it to Cloudflare Workers:
 *
 *   1. Validates the project was prepared by `vinext init --platform=cloudflare`
 *   2. Runs the Vite build
 *   3. Deploys to Cloudflare Workers via Wrangler
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { parseArgs as nodeParseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { findInNodeModules as _findInNodeModules } from "./utils/project.js";
import { runTPR } from "./cloudflare/tpr.js";
import { runPrerender } from "./build/run-prerender.js";
import { loadDotenv } from "./config/dotenv.js";
import { loadNextConfig, resolveNextConfig } from "./config/next-config.js";
import { parsePositiveIntegerArg } from "./cli-args.js";
import { detectProject, getMissingDeps, type ProjectInfo } from "./cloudflare/project.js";
import {
  formatMissingCacheAdapterError,
  formatMissingCloudflarePluginError,
  formatImageOptimizationHint,
  viteConfigHasCacheAdapter,
  viteConfigHasCloudflarePlugin,
  viteConfigHasImageAdapter,
  workerEntryHasCacheHandler,
} from "./cloudflare/deploy-config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type DeployOptions = {
  /** Project root directory */
  root: string;
  /** Deploy to preview environment (default: production) */
  preview?: boolean;
  /** Wrangler environment name from wrangler.jsonc env.<name> */
  env?: string;
  /** Custom project name for the Worker */
  name?: string;
  /** Skip the build step (assume already built) */
  skipBuild?: boolean;
  /** Dry run — validate setup but don't build or deploy */
  dryRun?: boolean;
  /** Pre-render all discovered routes into the dist output after building */
  prerenderAll?: boolean;
  /** Maximum number of routes to prerender in parallel */
  prerenderConcurrency?: number;
  /** Enable experimental TPR (Traffic-aware Pre-Rendering) */
  experimentalTPR?: boolean;
  /** TPR: traffic coverage percentage target (0–100, default: 90) */
  tprCoverage?: number;
  /** TPR: hard cap on number of pages to pre-render (default: 1000) */
  tprLimit?: number;
  /** TPR: analytics lookback window in hours (default: 24) */
  tprWindow?: number;
};

// ─── CLI arg parsing (uses Node.js util.parseArgs) ──────────────────────────

/** Deploy command flag definitions for util.parseArgs. */
const deployArgOptions = {
  help: { type: "boolean", short: "h", default: false },
  preview: { type: "boolean", default: false },
  env: { type: "string" },
  name: { type: "string" },
  "skip-build": { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  "prerender-all": { type: "boolean", default: false },
  "prerender-concurrency": { type: "string" },
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
    skipBuild: values["skip-build"],
    dryRun: values["dry-run"],
    prerenderAll: values["prerender-all"],
    prerenderConcurrency:
      values["prerender-concurrency"] === undefined
        ? undefined
        : parsePositiveIntegerArg(values["prerender-concurrency"], "--prerender-concurrency"),
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

async function runBuild(info: ProjectInfo, env: string | undefined): Promise<void> {
  console.log("\n  Building for Cloudflare Workers...\n");

  // Resolve Vite from the project root so that symlinked vinext installs
  // (bun link / npm link) use the project's Vite, not the monorepo copy.
  // This mirrors the loadVite() pattern in cli.ts.
  let vitePath: string;
  try {
    const req = createRequire(path.join(info.root, "package.json"));
    vitePath = req.resolve("vite");
  } catch {
    vitePath = "vite";
  }
  const viteUrl = vitePath === "vite" ? vitePath : pathToFileURL(vitePath).href;
  const { createBuilder } = (await import(/* @vite-ignore */ viteUrl)) as {
    createBuilder: typeof import("vite").createBuilder;
  };

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

// ─── Deploy ──────────────────────────────────────────────────────────────────

type WranglerDeployArgs = {
  args: string[];
  env: string | undefined;
};

export function validateWranglerEnvName(env: string): string {
  if (env.includes("\0")) {
    throw new Error("Wrangler environment names cannot contain null bytes.");
  }
  return env;
}

export function buildWranglerDeployArgs(
  options: Pick<DeployOptions, "preview" | "env">,
): WranglerDeployArgs {
  const args = ["deploy"];
  const env = options.env || (options.preview ? "preview" : undefined);
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
      return _findInNodeModules(projectRoot, "wrangler/package.json");
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
  options: Pick<DeployOptions, "preview" | "env">,
  nodeExecutable: string = process.execPath,
): { file: string; args: string[]; env: string | undefined } {
  const wranglerBin = resolveWranglerBin(root);
  const { args, env } = buildWranglerDeployArgs(options);
  return { ...buildNodeCliInvocation(wranglerBin, args, nodeExecutable), env };
}

export function runWranglerDeploy(
  root: string,
  options: Pick<DeployOptions, "preview" | "env">,
  execute: typeof execFileSync = execFileSync,
): string {
  const execOpts: ExecFileSyncOptions = {
    cwd: root,
    stdio: "pipe",
    encoding: "utf-8",
    shell: false,
  };

  const { file, args, env } = buildWranglerInvocation(root, options);

  if (env) {
    console.log(`\n  Deploying to env: ${env}...`);
  } else {
    console.log("\n  Deploying to production...");
  }

  const output = execute(file, args, execOpts) as string;

  // Parse the deployed URL from wrangler output
  // Wrangler prints: "Published <name> (version_id)\n  https://<name>.<subdomain>.workers.dev"
  const urlMatch = output.match(/https:\/\/[^\s]+\.workers\.dev[^\s]*/);
  const deployedUrl = urlMatch ? urlMatch[0] : null;

  // Also print raw output for transparency
  if (output.trim()) {
    for (const line of output.trim().split("\n")) {
      console.log(`  ${line}`);
    }
  }

  return deployedUrl ?? "(URL not detected in wrangler output)";
}

// ─── Main Entry ──────────────────────────────────────────────────────────────

export async function deploy(options: DeployOptions): Promise<void> {
  const deployEnv = validateWranglerEnvName(
    options.env || (options.preview ? "preview" : "production"),
  );
  const root = path.resolve(options.root);
  loadDotenv({ root, mode: "production" });

  console.log("\n  vinext deploy\n");

  // Step 1: Detect project structure
  const info = detectProject(root);

  if (!info.isAppRouter && !info.isPagesRouter) {
    console.error("  Error: No app/ or pages/ directory found.");
    console.error("  vinext deploy requires a Next.js project with an app/ or pages/ directory");
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
    info.isPagesRouter && !info.hasWorkerEntry && "Worker entry",
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

  // Step 5: Build
  if (!options.skipBuild) {
    await runBuild(info, deployEnv === "production" && !options.env ? undefined : deployEnv);
  } else {
    console.log("\n  Skipping build (--skip-build)");
  }

  // Step 6a: prerender — render every discovered route into dist.
  // Triggered by --prerender-all, or automatically when next.config.js
  // sets `output: 'export'` (every route must be statically exportable).
  {
    const rawNextConfig = await loadNextConfig(info.root);
    const nextConfig = await resolveNextConfig(rawNextConfig, info.root);
    const isStaticExport = nextConfig.output === "export";

    if (options.prerenderAll || isStaticExport) {
      const label =
        isStaticExport && !options.prerenderAll
          ? "Pre-rendering all routes (output: 'export')..."
          : "Pre-rendering all routes...";
      console.log(`\n  ${label}`);
      if (nextConfig.enablePrerenderSourceMaps) {
        process.setSourceMapsEnabled(true);
        Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 50);
      }
      await runPrerender({ root: info.root, concurrency: options.prerenderConcurrency });
    }
  }

  // Step 6b: TPR — pre-render hot pages into KV cache (experimental, opt-in)
  if (options.experimentalTPR) {
    console.log();
    const tprResult = await runTPR({
      root,
      coverage: Math.max(1, Math.min(100, options.tprCoverage ?? 90)),
      limit: Math.max(1, options.tprLimit ?? 1000),
      window: Math.max(1, options.tprWindow ?? 24),
    });

    if (tprResult.skipped) {
      console.log(`  TPR: Skipped (${tprResult.skipped})`);
    }
  }

  // Step 7: Deploy via wrangler
  const url = runWranglerDeploy(root, {
    env: deployEnv === "production" && !options.env ? undefined : deployEnv,
  });

  console.log("\n  ─────────────────────────────────────────");
  console.log(`  Deployed to: ${url}`);
  console.log("  ─────────────────────────────────────────\n");
}
