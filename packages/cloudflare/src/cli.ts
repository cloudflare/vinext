#!/usr/bin/env node

import fs from "node:fs";
import { deploy, parseDeployArgs } from "./deploy.js";
import { printDeployHelp, printPreviewsDeployHelp } from "./deploy-help.js";
import { parsePreviewsDeployArgs } from "./previews-deploy.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"))
  .version as string;
const command = process.argv[2];
const rawArgs = process.argv.slice(3);

function printHelp(commandName?: string): void {
  if (commandName === "deploy") {
    printDeployHelp();
    return;
  }
  if (commandName === "previews") {
    printPreviewsDeployHelp();
    return;
  }

  console.log(`
  vinext-cloudflare v${VERSION}

  Usage: vinext-cloudflare <command> [options]

  Vite+:
    vpx @vinext/cloudflare <command>       Run by package name
    vp exec vinext-cloudflare <command>    Run the locally installed bin

  Commands:
    deploy                          Deploy to Cloudflare Workers
    previews deploy [preview-name]  Deploy a Cloudflare Worker Preview

  Options:
    -h, --help     Show this help
    --version      Show version
`);
}

async function deployCommand(): Promise<void> {
  const parsed = parseDeployArgs(rawArgs);
  if (parsed.help) {
    printHelp("deploy");
    return;
  }

  await deploy({
    root: process.cwd(),
    preview: parsed.preview,
    env: parsed.env,
    config: parsed.config,
    skipBuild: parsed.skipBuild,
    dryRun: parsed.dryRun,
    verbose: parsed.verbose,
    name: parsed.name,
    prerenderAll: parsed.prerenderAll,
    prerenderConcurrency: parsed.prerenderConcurrency,
    warmCdnCache: parsed.warmCdnCache,
    warmCdnTarget: parsed.warmCdnTarget,
    warmCdnConcurrency: parsed.warmCdnConcurrency,
    warmCdnTimeout: parsed.warmCdnTimeout,
    warmCdnRetries: parsed.warmCdnRetries,
    warmCdnDiscoveryTimeout: parsed.warmCdnDiscoveryTimeout,
    warmCdnDiscoveryRetries: parsed.warmCdnDiscoveryRetries,
    warmCdnProbeTimeout: parsed.warmCdnProbeTimeout,
    warmCdnProbeRetries: parsed.warmCdnProbeRetries,
    warmCdnCertify: parsed.warmCdnCertify,
    warmCdnReadinessTimeout: parsed.warmCdnReadinessTimeout,
    warmCdnReadinessRetries: parsed.warmCdnReadinessRetries,
    warmCdnReadinessProbes: parsed.warmCdnReadinessProbes,
    warmCdnReadinessProbeDelay: parsed.warmCdnReadinessProbeDelay,
    dangerouslyPromoteOnCdnWarmError: parsed.dangerouslyPromoteOnCdnWarmError,
    warmCdnPromote: parsed.warmCdnPromote,
    warmCdnPromotionDelay: parsed.warmCdnPromotionDelay,
    experimentalTPR: parsed.experimentalTPR,
    tprCoverage: parsed.tprCoverage,
    tprLimit: parsed.tprLimit,
    tprWindow: parsed.tprWindow,
  });
}

async function previewsCommand(): Promise<void> {
  const subcommand = rawArgs[0];
  if (subcommand !== "deploy") {
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      printHelp("previews");
      return;
    }
    throw new Error(`Unknown previews command: ${subcommand}`);
  }

  const options = parsePreviewsDeployArgs(rawArgs.slice(1));
  if (options.help) {
    printHelp("previews");
    return;
  }

  await deploy({
    root: process.cwd(),
    env: "preview",
    skipBuild: options.skipBuild,
    target: { type: "preview", name: options.name },
  });
}

if (command === "--version" || command === "-v") {
  console.log(`vinext-cloudflare v${VERSION}`);
  process.exit(0);
}

if (command === "--help" || command === "-h" || !command) {
  printHelp();
  process.exit(0);
}

switch (command) {
  case "deploy":
    deployCommand().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
    break;
  case "previews":
    previewsCommand().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
