/**
 * `vinext init` — migrate a Next.js project to run under vinext.
 *
 * One-command migration: installs dependencies, configures ESM, generates
 * vite.config.ts, and adds npm scripts. The command's flags and help text are
 * both derived from the {@link CommandSpec} below.
 */

import { defineCommand } from "../command.js";
import { init as runInit } from "../../init.js";

export const initCommand = defineCommand({
  name: "init",
  summary: "Migrate a Next.js project to vinext",
  description:
    "One-command migration: installs dependencies, configures ESM, generates\n" +
    "vite.config.ts, and adds npm scripts. Your Next.js setup continues to work\n" +
    "alongside vinext.",
  args: {
    port: {
      type: "port",
      short: "p",
      valueHint: "port",
      description: "Dev server port for the vinext script",
      default: 3001,
    },
    "skip-check": {
      type: "boolean",
      description: "Skip the compatibility check step",
    },
    force: {
      type: "boolean",
      description: "Overwrite existing vite.config.ts",
    },
  },
  examples: [
    { command: "vinext init", description: "Migrate with defaults" },
    { command: "vinext init -p 4000", description: "Use port 4000 for dev:vinext" },
    { command: "vinext init --force", description: "Overwrite existing vite.config.ts" },
    { command: "vinext init --skip-check", description: "Skip the compatibility report" },
  ],
  async run({ values }) {
    console.log(`\n  vinext init\n`);

    await runInit({
      root: process.cwd(),
      port: values.port,
      skipCheck: values["skip-check"],
      force: values.force,
    });
  },
});
