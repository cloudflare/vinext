#!/usr/bin/env node

/**
 * vinext CLI — drop-in replacement for the `next` command
 *
 *   vinext dev     Start development server (Vite)
 *   vinext build   Build for production
 *   vinext start   Start production server
 *   vinext deploy  Deploy to Cloudflare Workers
 *   vinext typegen Generate App Router route helper types
 *   vinext lint    Run linter (delegates to eslint/oxlint)
 *
 * Automatically configures Vite with the vinext plugin — no vite.config.ts
 * needed for most Next.js apps.
 */

import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { detectPackageManager } from "./utils/project.js";
import { deploy as runDeploy, parseDeployArgs } from "./deploy.js";
import { runCheck, formatReport } from "./check.js";
import { loadDotenv } from "./config/dotenv.js";
import { loadNextConfig, resolveNextConfig, PHASE_PRODUCTION_BUILD } from "./config/next-config.js";
import { parseArgs } from "./cli-args.js";
import { getViteVersion, loadVite } from "./cli/runtime.js";
import { runCommand } from "./cli/command.js";
import { devCommand } from "./cli/commands/dev.js";
import { buildCommand } from "./cli/commands/build.js";
import { startCommand } from "./cli/commands/start.js";
import { initCommand } from "./cli/commands/init.js";
import { generateRouteTypes } from "./typegen.js";

// Vite is resolved from the project root at runtime — see ./cli/runtime.ts for
// the loadVite()/getViteVersion()/buildViteConfig()/applyViteConfigCompatibility()
// helpers shared across the dev, build, start, and deploy commands.

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"))
  .version as string;

// ─── CLI Argument Parsing ──────────────────────────────────────────────────────

const command = process.argv[2];
const rawArgs = process.argv.slice(3);

// ─── Commands ─────────────────────────────────────────────────────────────────

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

async function deployCommand() {
  const parsed = parseDeployArgs(rawArgs);
  if (parsed.help) return printHelp("deploy");

  await loadVite();
  console.log(`\n  vinext deploy  (Vite ${getViteVersion()})\n`);

  await runDeploy({
    root: process.cwd(),
    preview: parsed.preview,
    env: parsed.env,
    skipBuild: parsed.skipBuild,
    dryRun: parsed.dryRun,
    name: parsed.name,
    prerenderAll: parsed.prerenderAll,
    prerenderConcurrency: parsed.prerenderConcurrency,
    experimentalTPR: parsed.experimentalTPR,
    tprCoverage: parsed.tprCoverage,
    tprLimit: parsed.tprLimit,
    tprWindow: parsed.tprWindow,
  });
}

async function check() {
  const parsed = parseArgs(rawArgs);
  if (parsed.help) return printHelp("check");

  const root = process.cwd();
  console.log(`\n  vinext check\n`);
  console.log("  Scanning project...\n");

  const result = runCheck(root);
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
  const outputPath = await generateRouteTypes({
    root,
    pageExtensions: resolvedNextConfig.pageExtensions,
  });
  console.log(`\n  Generated route types at ${path.relative(root, outputPath)}\n`);
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(cmd?: string) {
  if (cmd === "deploy") {
    console.log(`
  vinext deploy - Deploy to Cloudflare Workers

  Usage: vinext deploy [options]

  One-command deployment to Cloudflare Workers. Automatically:
    - Detects App Router or Pages Router
    - Generates wrangler.jsonc, worker/index.ts, vite.config.ts if missing
    - Installs @cloudflare/vite-plugin and wrangler if needed
    - Builds the project with Vite
    - Deploys via wrangler

  Options:
    --preview                Deploy to preview environment (same as --env preview)
    --env <name>             Deploy using wrangler env.<name>
    --name <name>            Custom Worker name (default: from package.json)
    --skip-build             Skip the build step (use existing dist/)
    --dry-run                Generate config files without building or deploying
    --prerender-all          Pre-render discovered routes after building (future
                             releases will auto-populate the remote cache)
    --prerender-concurrency <count>
                             Maximum number of routes to pre-render in parallel
    -h, --help               Show this help

  Experimental:
    --experimental-tpr               Enable Traffic-aware Pre-Rendering
    --tpr-coverage <pct>             Traffic coverage target, 0–100 (default: 90)
    --tpr-limit <count>              Hard cap on pages to pre-render (default: 1000)
    --tpr-window <hours>             Analytics lookback window in hours (default: 24)

  TPR (Traffic-aware Pre-Rendering) uses Cloudflare zone analytics to determine
  which pages get the most traffic and pre-renders them into KV cache during
  deploy. This feature is experimental and must be explicitly enabled. Requires
  a custom domain (zone analytics are unavailable on *.workers.dev) and the
  CLOUDFLARE_API_TOKEN environment variable with Zone.Analytics read permission.

  Examples:
    vinext deploy                              Build and deploy to production
    vinext deploy --preview                    Deploy to a preview URL
    vinext deploy --env staging                Deploy using wrangler env.staging
    vinext deploy --dry-run                    See what files would be generated
    vinext deploy --name my-app                Deploy with a custom Worker name
    vinext deploy --experimental-tpr           Enable TPR during deploy
    vinext deploy --experimental-tpr --tpr-coverage 95   Cover 95% of traffic
    vinext deploy --experimental-tpr --tpr-limit 500     Cap at 500 pages
`);
    return;
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
    deploy   Deploy to Cloudflare Workers
    typegen  Generate App Router route helper types
    init     Migrate a Next.js project to vinext
    check    Scan Next.js app for compatibility
    lint     Run linter

  Options:
    -h, --help     Show this help
    --version      Show version

  Examples:
    vinext dev                  Start dev server on port 3000
    vinext dev -p 4000          Start dev server on port 4000
    vinext build                Build for production
    vinext typegen              Generate route helper types
    vinext start                Start production server
    vinext deploy               Deploy to Cloudflare Workers
    vinext init                 Migrate a Next.js project
    vinext check                Check compatibility
    vinext lint                 Run linter

  vinext is a drop-in replacement for the \`next\` CLI.
  No vite.config.ts needed — just run \`vinext dev\` in your Next.js project.
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
    runCommand(devCommand, rawArgs).catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;

  case "build":
    runCommand(buildCommand, rawArgs).catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;

  case "start":
    runCommand(startCommand, rawArgs).catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;

  case "deploy":
    deployCommand().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;

  case "init":
    runCommand(initCommand, rawArgs).catch((e) => {
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
