import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "pathslash";

type ViteCommand = "dev" | "build";

function findPackageRoot(entryPath: string): string {
  let current = path.dirname(entryPath);
  while (true) {
    const packagePath = path.join(current, "package.json");
    if (fs.existsSync(packagePath)) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Could not find Vite's package root from ${entryPath}`);
    current = parent;
  }
}

function resolveViteCli(root: string): string {
  const require = createRequire(path.join(root, "package.json"));
  const viteEntry = require.resolve("vite");
  const packageRoot = findPackageRoot(viteEntry);
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"),
  ) as {
    bin?: string | Record<string, string>;
  };
  const configuredBin =
    typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.vite;
  if (configuredBin) return path.resolve(packageRoot, configuredBin);

  const siblingCli = path.join(path.dirname(viteEntry), "cli.js");
  if (fs.existsSync(siblingCli)) return siblingCli;
  throw new Error("The installed Vite package does not expose a CLI entrypoint.");
}

export function translateLegacyDevArgs(args: string[]): string[] {
  const translated: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--turbopack" || arg === "--experimental-https") continue;
    if (arg === "--hostname" || arg === "-H") {
      translated.push("--host");
      if (args[index + 1] !== undefined) translated.push(args[++index]);
      continue;
    }
    if (arg.startsWith("--hostname=")) {
      translated.push(`--host=${arg.slice("--hostname=".length)}`);
      continue;
    }
    translated.push(arg);
  }
  return translated;
}

function parsePrerenderConcurrency(value: string | undefined): string {
  if (value === undefined) throw new Error("--prerender-concurrency requires a value.");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--prerender-concurrency must be a positive integer.");
  }
  return String(parsed);
}

export function translateLegacyBuildArgs(args: string[]): {
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const translated: string[] = [];
  const env = { ...process.env };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--verbose") continue;
    if (arg === "--prerender-all") {
      env.VINEXT_PRERENDER_ALL = "1";
      continue;
    }
    if (arg === "--precompress") {
      env.VINEXT_PRECOMPRESS = "1";
      continue;
    }
    if (arg === "--prerender-concurrency") {
      env.VINEXT_PRERENDER_CONCURRENCY = parsePrerenderConcurrency(args[index + 1]);
      index++;
      continue;
    }
    if (arg.startsWith("--prerender-concurrency=")) {
      env.VINEXT_PRERENDER_CONCURRENCY = parsePrerenderConcurrency(
        arg.slice("--prerender-concurrency=".length),
      );
      continue;
    }
    translated.push(arg);
  }
  return { args: translated, env };
}

/** Run the project-local Vite CLI while preserving legacy vinext flags. */
export function runViteCli(command: ViteCommand, args: string[], root = process.cwd()): never {
  const cliPath = resolveViteCli(root);
  const translated =
    command === "dev"
      ? { args: translateLegacyDevArgs(args), env: process.env }
      : translateLegacyBuildArgs(args);
  const result = spawnSync(process.execPath, [cliPath, command, ...translated.args], {
    cwd: root,
    env: translated.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
