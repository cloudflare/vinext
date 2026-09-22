#!/usr/bin/env node

/**
 * vinext CLI — migration and compatibility commands for vinext projects
 *
 *   vinext dev     Start development server (Vite)
 *   vinext build   Build for production
 *   vinext start   Start production server
 *   vinext typegen Generate App Router route helper types
 *   vinext lint    Run linter (delegates to eslint/oxlint)
 *
 * The dev and build commands delegate to the project-local Vite CLI.
 */

import path, { toSlash } from "pathslash";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { detectPackageManager, findViteConfigPath } from "./utils/project.js";
import { runCheck, formatReport } from "./check.js";
import { init as runInit } from "./init.js";
import { resolveInitOptions } from "./init-platform.js";
import { loadDotenv } from "./config/dotenv.js";
import { loadNextConfig, resolveNextConfig, PHASE_PRODUCTION_BUILD } from "./config/next-config.js";
import { parseArgs } from "./cli-args.js";
import { generateRouteTypes } from "./typegen.js";
import { findViteRoot } from "./utils/vite-cli-invocation.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"))
  .version as string;

// ─── CLI Argument Parsing ──────────────────────────────────────────────────────

const command = process.argv[2];
const rawArgs = process.argv.slice(3);

// ─── Commands ─────────────────────────────────────────────────────────────────

type ViteCommand = "dev" | "build";

function configPreflight(command: ViteCommand): string {
  const cwd = process.cwd();
  const { root: positionalRoot, shouldPreflight } = findViteRoot(command, rawArgs);
  const root = positionalRoot ? path.resolve(cwd, positionalRoot) : cwd;
  if (
    !shouldPreflight ||
    rawArgs.some((arg) => ["--help", "-h", "--version", "-v"].includes(arg))
  ) {
    return root;
  }

  let explicitConfig: string | undefined;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg.startsWith("--config=") || arg.startsWith("-c=")) {
      explicitConfig = arg.slice(arg.indexOf("=") + 1) || undefined;
      if (!explicitConfig) return root;
      break;
    }
    if (arg === "--config" || arg === "-c") {
      explicitConfig = rawArgs[index + 1];
      if (!explicitConfig || explicitConfig.startsWith("-")) return root;
      break;
    }
  }

  const configPath = explicitConfig ? path.resolve(cwd, explicitConfig) : findViteConfigPath(root);
  if (configPath && fs.existsSync(configPath)) return root;

  throw new Error(
    `[vinext] No Vite config was found for this project. Run \`vinext init\` to create one, then retry \`vinext ${command}\`.`,
  );
}

function resolveProjectViteCli(root: string): string {
  const require = createRequire(path.join(root, "package.json"));
  let packagePath: string;
  try {
    packagePath = require.resolve("vite/package.json");
  } catch {
    throw new Error(
      "[vinext] Could not resolve the project-local Vite CLI. Run `vinext init` to install it.",
    );
  }

  const packageRoot = path.dirname(packagePath);
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.vite;
  const cliPath = bin
    ? path.resolve(packageRoot, bin)
    : path.join(path.dirname(require.resolve("vite")), "cli.js");
  if (!fs.existsSync(cliPath)) {
    throw new Error(`[vinext] Could not find the project-local Vite CLI at ${cliPath}.`);
  }
  return cliPath;
}

async function proxyVite(command: ViteCommand): Promise<void> {
  const root = configPreflight(command);
  const cliPath = resolveProjectViteCli(root);
  process.argv = [process.execPath, cliPath, command, ...rawArgs];
  await import(/* @vite-ignore */ pathToFileURL(cliPath).href);
}

async function start() {
  const parsed = parseArgs(rawArgs);
  if (parsed.help) return printHelp("start");

  loadDotenv({
    root: process.cwd(),
    mode: "production",
  });

  const port = parsed.port ?? parseInt(process.env.PORT ?? "3000", 10);
  const host = parsed.hostname ?? "0.0.0.0";

  console.log(`\n  vinext start  (port ${port})\n`);

  const { startProdServer } = (await import(/* @vite-ignore */ "./server/prod-server.js")) as {
    startProdServer: (opts: { port: number; host: string; outDir: string }) => Promise<unknown>;
  };

  await startProdServer({
    port,
    host,
    outDir: path.resolve(process.cwd(), "dist"),
  });
}

async function lint() {
  const parsed = parseArgs(rawArgs);
  if (parsed.help) return printHelp("lint");

  console.log(`\n  vinext lint\n`);

  // Try oxlint first (fast), fall back to eslint
  const cwd = process.cwd();
  const hasOxlint = fs.existsSync(path.join(cwd, "node_modules", ".bin", "oxlint"));
  const hasEslint = fs.existsSync(path.join(cwd, "node_modules", ".bin", "eslint"));

  // Check for next lint config (eslint-config-next)
  const hasNextLintConfig =
    fs.existsSync(path.join(cwd, ".eslintrc.json")) ||
    fs.existsSync(path.join(cwd, ".eslintrc.js")) ||
    fs.existsSync(path.join(cwd, ".eslintrc.cjs")) ||
    fs.existsSync(path.join(cwd, "eslint.config.js")) ||
    fs.existsSync(path.join(cwd, "eslint.config.mjs"));

  try {
    if (hasEslint && hasNextLintConfig) {
      console.log("  Using eslint (with existing config)\n");
      execFileSync("npx", ["eslint", "."], {
        cwd,
        stdio: "inherit",
        shell: process.platform === "win32",
      });
    } else if (hasOxlint) {
      console.log("  Using oxlint\n");
      execFileSync("npx", ["oxlint", "."], {
        cwd,
        stdio: "inherit",
        shell: process.platform === "win32",
      });
    } else if (hasEslint) {
      console.log("  Using eslint\n");
      execFileSync("npx", ["eslint", "."], {
        cwd,
        stdio: "inherit",
        shell: process.platform === "win32",
      });
    } else {
      console.log(
        "  No linter found. Install eslint or oxlint:\n\n" +
          "    " +
          detectPackageManager(process.cwd()) +
          " eslint eslint-config-next\n" +
          "    # or\n" +
          "    " +
          detectPackageManager(process.cwd()) +
          " oxlint\n",
      );
      process.exit(1);
    }
    console.log("\n  Lint passed.\n");
  } catch {
    process.exit(1);
  }
}

function failRemovedDeployCommand(): never {
  console.error(
    "\n  Error: `vinext deploy` has moved to the `@vinext/cloudflare` package.\n\n" +
      "  Run `npx @vinext/cloudflare deploy` or `vp exec vinext-cloudflare deploy` instead.\n",
  );
  process.exit(1);
}

async function check() {
  const parsed = parseArgs(rawArgs);
  if (parsed.help) return printHelp("check");

  console.log(`\n  vinext check\n`);
  console.log("  Scanning project...\n");

  const result = runCheck(toSlash(process.cwd()));
  console.log(formatReport(result));
}

async function typegen() {
  const parsed = parseArgs(rawArgs);
  if (parsed.help) return printHelp("typegen");

  const root = path.resolve(parsed.positionals?.[0] ?? process.cwd());
  loadDotenv({
    root,
    mode: "production",
  });
  const resolvedNextConfig = await resolveNextConfig(
    await loadNextConfig(root, PHASE_PRODUCTION_BUILD),
    root,
  );
  const result = await generateRouteTypes({
    root,
    pageExtensions: resolvedNextConfig.pageExtensions,
  });
  const nextEnvMessage =
    result.nextEnvStatus === "unchanged"
      ? `${path.relative(root, result.nextEnvPath)} is up to date`
      : `${result.nextEnvStatus === "created" ? "Created" : "Updated"} ${path.relative(root, result.nextEnvPath)}`;
  console.log(
    `\n  Generated route types at ${path.relative(root, result.routeTypesPath)}\n  ${nextEnvMessage}\n`,
  );
}

async function initCommand() {
  const parsed = parseArgs(rawArgs);
  if (parsed.help) return printHelp("init");

  console.log(`\n  vinext init\n`);

  // Parse init-specific flags
  const port = parsed.port ?? 3001;
  const skipCheck = rawArgs.includes("--skip-check");
  const force = rawArgs.includes("--force");
  const initOptions = await resolveInitOptions(rawArgs);

  await runInit({
    root: process.cwd(),
    port,
    skipCheck,
    force,
    ...initOptions,
  });
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(cmd?: string) {
  if (cmd === "start") {
    console.log(`
  vinext start - Start production server

  Usage: vinext start [options]

  Serves the output from \`vinext build\`. Supports SSR, static files,
  compression, and all middleware.
  For output: "standalone", you can also run: node dist/standalone/server.js

  Options:
    -p, --port <port>        Port to listen on (default: 3000, or PORT env)
    -H, --hostname <host>    Hostname to bind to (default: 0.0.0.0)
    -h, --help               Show this help
`);
    return;
  }

  if (cmd === "deploy") {
    failRemovedDeployCommand();
  }

  if (cmd === "check") {
    console.log(`
  vinext check - Scan Next.js app for compatibility

  Usage: vinext check [options]

  Scans your Next.js project and produces a compatibility report showing
  which imports, config options, libraries, and conventions are supported,
  partially supported, or unsupported by vinext.

  Options:
    -h, --help    Show this help
`);
    return;
  }

  if (cmd === "init") {
    console.log(`
  vinext init - Migrate a Next.js project to run under vinext

  Usage: vinext init [options]

  One-command migration: installs dependencies, configures ESM,
  generates vite.config.ts, and adds npm scripts. Your Next.js
  setup continues to work alongside vinext.

  Options:
    -p, --port <port>    Dev server port for the vinext script (default: 3001)
    --skip-check         Skip the compatibility check step
    --force              Overwrite existing vite.config.ts
    --platform <target>  Deployment target: cloudflare or node
    --prerender          Configure vinext build to pre-render all static routes
                         (default: prompt, with No selected by default)
    --experimental-warm-cdn-cache
                         Add experimental CDN pre-warming to the Cloudflare deploy script
                         (Response Store or Workers Cache, default: prompt with No)
    --cdn-cache <type>   Cloudflare CDN cache: none, response-store, workers-cache, or data-cache
                         (default: none; response-store is the default cache choice)
    --response-store-mode <type>
                         Workers Response Store mode: service-binding or self-contained
    --data-cache <type>  Cloudflare data cache: kv or none
    --image-optimization <type>
                         Cloudflare image optimization: cloudflare-images or none
    -h, --help           Show this help

  Examples:
    vinext init                   Prompt for a deployment platform
    vinext init --platform=cloudflare  Configure Cloudflare Workers (default)
    vinext init --platform=cloudflare --cdn-cache=response-store
                                Configure Workers Response Store (recommended)
    vinext init --platform=cloudflare --cdn-cache=data-cache
                                Fall through CDN caching to the data cache
    vinext init --platform=cloudflare --data-cache=kv
                                Configure the default Cloudflare cache handlers
    vinext init --platform=cloudflare --image-optimization=none
                                Do not configure Cloudflare Images
    vinext init --prerender     Add prerender: { routes: "*" } to vite.config.ts
    vinext init --experimental-warm-cdn-cache
                                Add experimental CDN pre-warming to deploy:vinext
    vinext init --platform=node   Configure a Node deployment
    vinext init -p 4000           Use port 4000 for dev:vinext
    vinext init --force           Overwrite existing vite.config.ts
    vinext init --skip-check      Skip the compatibility report
`);
    return;
  }

  if (cmd === "typegen") {
    console.log(`
  vinext typegen - Generate App Router route helper types

  Usage: vinext typegen [directory] [options]

  Generates Next-compatible global route helpers for App Router projects:
  PageProps, LayoutProps, and RouteContext. Output is written to
  .next/types/routes.d.ts under the target directory.

  Options:
    -h, --help    Show this help
`);
    return;
  }

  if (cmd === "lint") {
    console.log(`
  vinext lint - Run linter

  Usage: vinext lint [options]

  Delegates to your project's eslint (with eslint-config-next) or oxlint.
  If neither is installed, suggests how to add one.

  Options:
    -h, --help    Show this help
`);
    return;
  }

  console.log(`
  vinext v${VERSION} - Run Next.js apps on Vite

  Usage: vinext <command> [options]

  Commands:
    dev      Start development server
    build    Build for production
    start    Start production server
    typegen  Generate App Router route helper types
    init     Migrate a Next.js project to vinext
    check    Scan Next.js app for compatibility
    lint     Run linter

  Options:
    -h, --help     Show this help
    --version      Show version

  Examples:
    vinext dev                         Start dev server on port 3000
    vinext dev --port 4000             Start dev server on port 4000
    vinext build                       Build for production
    vinext typegen                     Generate route helper types
    vinext start                       Start production server
    vinext init                        Migrate a Next.js project
    vinext check                       Check compatibility
    vinext lint                        Run linter
    npx @vinext/cloudflare deploy      Deploy to Cloudflare Workers
    vp exec vinext-cloudflare deploy   Deploy to Cloudflare Workers with Vite+

  The dev and build commands are thin proxies to the project-local Vite CLI.
  Run \`vinext init\` first if the project does not have a Vite config.
`);
}

// ─── Entry ────────────────────────────────────────────────────────────────────

if (command === "--version" || command === "-v") {
  console.log(`vinext v${VERSION}`);
  process.exit(0);
}

if (command === "--help" || command === "-h" || !command) {
  printHelp();
  process.exit(0);
}

switch (command) {
  case "dev":
    proxyVite("dev").catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
    break;

  case "build":
    proxyVite("build").catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
    break;

  case "start":
    start().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;

  case "deploy":
    failRemovedDeployCommand();
    break;

  case "init":
    initCommand().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;

  case "check":
    check().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;

  case "typegen":
    typegen().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;

  case "lint":
    lint().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;

  default:
    console.error(`\n  Unknown command: ${command}\n`);
    printHelp();
    process.exit(1);
}
