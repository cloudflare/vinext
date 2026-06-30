#!/usr/bin/env node

import fs from "node:fs";
import { deploy, parseDeployArgs } from "./deploy.js";
import { printDeployHelp } from "./deploy-help.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"))
  .version as string;
const command = process.argv[2];
const rawArgs = process.argv.slice(3);

function printHelp(commandName?: string): void {
  if (commandName === "deploy") {
    printDeployHelp();
    return;
  }

  console.log(`
  vinext-cloudflare v${VERSION}

  Usage: vinext-cloudflare <command> [options]

  Vite+:
    vpx @vinext/cloudflare <command>       Run by package name
    vp exec vinext-cloudflare <command>    Run the locally installed bin

  Commands:
    deploy   Deploy to Cloudflare Workers

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
      console.error(error);
      process.exit(1);
    });
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
