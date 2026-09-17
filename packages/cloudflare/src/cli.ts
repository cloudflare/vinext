#!/usr/bin/env node

import fs from "node:fs";
import { parseArgs } from "node:util";
import { deploy, parseDeployArgs } from "./deploy.js";
import { printDeployHelp } from "./deploy-help.js";
import { cleanupResponseStoreVersions } from "./response-store-cleanup.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"))
  .version as string;
const command = process.argv[2];
const rawArgs = process.argv.slice(3);

function printHelp(commandName?: string): void {
  if (commandName === "deploy") {
    printDeployHelp();
    return;
  }
  if (commandName === "response-store-cleanup") {
    console.log(`
  vinext-cloudflare response-store-cleanup - Delete retired version metadata

  Usage: vinext-cloudflare response-store-cleanup --older-than <age> [options]

  Options:
    --older-than <age>            Select versions older than an age such as 24h, 7d, or 4w
    --shards <counts>             Historical shard layouts, comma-separated (default: 1)
    --name <name>                 Application Worker whose versions are selected
    --response-store-worker <name>
                                  Cache Worker that owns the metadata Durable Objects
    --env <name>                  Use Wrangler env.<name>
    --config <path>               Wrangler config path
    --yes                         Delete the selected Durable Object storage
    -h, --help                    Show this help

  Without --yes, the command only prints the versions it would delete. Versions in
  the current deployment are always protected. This deletes SQLite Durable Object
  storage; version-scoped R2 response bodies are unchanged.
`);
    return;
  }

  console.log(`
  vinext-cloudflare v${VERSION}

  Usage: vinext-cloudflare <command> [options]

  Vite+:
    vpx @vinext/cloudflare <command>       Run by package name
    vp exec vinext-cloudflare <command>    Run the locally installed bin

  Commands:
    deploy                   Deploy to Cloudflare Workers
    response-store-cleanup   Delete retired Response Store metadata

  Options:
    -h, --help     Show this help
    --version      Show version
`);
}

function parseShardCounts(raw: string): number[] {
  const counts = [...new Set(raw.split(",").map(Number))];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 1)) {
    throw new Error(`--shards expects comma-separated positive integers, but got "${raw}".`);
  }
  return counts;
}

async function responseStoreCleanupCommand(): Promise<void> {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      config: { type: "string" },
      env: { type: "string" },
      help: { type: "boolean", short: "h" },
      name: { type: "string" },
      "older-than": { type: "string" },
      "response-store-worker": { type: "string" },
      shards: { type: "string", default: "1" },
      yes: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    printHelp("response-store-cleanup");
    return;
  }
  if (!values["older-than"]) {
    throw new Error("--older-than is required.");
  }

  const result = await cleanupResponseStoreVersions({
    root: process.cwd(),
    olderThan: values["older-than"],
    shardCounts: parseShardCounts(values.shards),
    yes: values.yes,
    config: values.config,
    env: values.env,
    workerName: values.name,
    responseStoreWorker: values["response-store-worker"],
  });
  console.log(
    `  Found ${result.selectedVersions.length} undeployed Worker version(s) older than ${result.cutoff}.`,
  );
  for (const version of result.selectedVersions) {
    console.log(`  ${version.id}  ${new Date(version.metadata.created_on).toISOString()}`);
  }
  if (!values.yes && result.selectedVersions.length) {
    console.log("\n  Dry run only. Re-run with --yes to delete their metadata Durable Objects.");
  }
  if (values.yes) {
    const deletedBytes = result.deletions.reduce(
      (total, deletion) => total + deletion.deletedBytes,
      0,
    );
    console.log(
      `  Deleted ${result.deletions.length} version layout(s), reclaiming ${deletedBytes} SQLite byte(s).`,
    );
  }
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
    warmCdnIncludeFallbacks: parsed.warmCdnIncludeFallbacks,
    experimentalTPR: parsed.experimentalTPR,
    tprCoverage: parsed.tprCoverage,
    tprLimit: parsed.tprLimit,
    tprWindow: parsed.tprWindow,
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
  case "response-store-cleanup":
    responseStoreCleanupCommand().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
