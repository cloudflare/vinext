import path, { toSlash } from "pathslash";
import type { InlineConfig } from "vite";
import { findViteConfigPath } from "./project.js";

type ViteCliCommand = "dev" | "build";

export type ViteCliInvocation = {
  command: ViteCliCommand;
  mode: string;
  root: string;
  rootArg?: string;
  configFile?: string;
};

let buildInvocationClaimed = false;

const SHORT_OPTIONS = new Set(["c", "d", "f", "h", "l", "m", "v", "w"]);

const REQUIRED_VALUE_OPTIONS = new Set([
  "--assetsDir",
  "--assetsInlineLimit",
  "--base",
  "--config",
  "--configLoader",
  "--filter",
  "--logLevel",
  "--mode",
  "--outDir",
  "--port",
  "--target",
  "-c",
  "-f",
  "-l",
  "-m",
]);
const OPTIONAL_VALUE_OPTIONS = new Set([
  "--debug",
  "--host",
  "--manifest",
  "--minify",
  "--open",
  "--profile",
  "--sourcemap",
  "--ssr",
  "--ssrManifest",
  "-d",
]);
const BOOLEAN_OPTIONS = new Set([
  "--app",
  "--clearScreen",
  "--cors",
  "--emptyOutDir",
  "--experimentalBundle",
  "--force",
  "--strictPort",
  "--watch",
  "-w",
]);

function optionName(arg: string): string {
  const equalsIndex = arg.indexOf("=");
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
}

function clusteredShortOption(arg: string): string | undefined {
  const name = optionName(arg);
  if (!name.startsWith("-") || name.startsWith("--") || name.length <= 2) return undefined;
  const options = name.slice(1);
  return Array.from(options).every((option) => SHORT_OPTIONS.has(option))
    ? `-${options.at(-1)}`
    : undefined;
}

function optionHasInlineValue(arg: string): boolean {
  return arg.includes("=");
}

function optionConsumesNext(arg: string, next: string | undefined): boolean {
  if (optionHasInlineValue(arg)) return false;
  const option = clusteredShortOption(arg) ?? optionName(arg);
  if (REQUIRED_VALUE_OPTIONS.has(option)) return true;
  if (OPTIONAL_VALUE_OPTIONS.has(option)) return next !== undefined && !next.startsWith("-");
  const booleanOption = option.startsWith("--no-") ? `--${option.slice(5)}` : option;
  return BOOLEAN_OPTIONS.has(booleanOption) && /^(?:true|false)$/.test(next ?? "");
}

function commandArguments(argv: string[]): { command: ViteCliCommand; args: string[] } | undefined {
  const entry = toSlash(argv[1] ?? "");
  const isViteEntry =
    entry.endsWith("/vite/bin/vite.js") ||
    entry.endsWith("/vite/node/cli.js") ||
    entry.endsWith("/dist/vite/node/cli.js");
  let args = argv.slice(2);
  if (!isViteEntry) {
    if (path.basename(entry) !== "vp") return undefined;
    if (args[0] === "-C") args = args.slice(2);
    if (args[0] === "exec" && args[1] === "vite") args = args.slice(2);
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;
    if (optionConsumesNext(arg, args[index + 1])) {
      index++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (arg === "build") {
      return { command: "build", args: args.slice(0, index).concat(args.slice(index + 1)) };
    }
    if (arg === "dev" || arg === "serve") {
      return { command: "dev", args: args.slice(0, index).concat(args.slice(index + 1)) };
    }
    if (arg === "preview" || arg === "optimize") return undefined;
    return isViteEntry ? { command: "dev", args } : undefined;
  }
  return isViteEntry ? { command: "dev", args } : undefined;
}

/** Resolve the root and mode before Vite evaluates the project config. */
export function getViteCliInvocation(argv: string[] = process.argv): ViteCliInvocation | undefined {
  const invocation = commandArguments(argv);
  if (!invocation) return undefined;
  let mode: string | undefined;
  let root: string | undefined;
  let configFile: string | undefined;
  for (let index = 0; index < invocation.args.length; index += 1) {
    const arg = invocation.args[index];
    if (arg === "--") {
      root ??= invocation.args[index + 1];
      break;
    }
    const option = clusteredShortOption(arg) ?? optionName(arg);
    if (option === "--config" || option === "-c") {
      const value = optionHasInlineValue(arg)
        ? arg.slice(arg.indexOf("=") + 1)
        : invocation.args[++index];
      configFile ??= value;
      continue;
    }
    if (option === "--mode" || option === "-m") {
      mode = optionHasInlineValue(arg) ? arg.slice(arg.indexOf("=") + 1) : invocation.args[++index];
      continue;
    }
    if (optionConsumesNext(arg, invocation.args[index + 1])) {
      index++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    root ??= arg;
  }
  return {
    command: invocation.command,
    mode: mode || (invocation.command === "build" ? "production" : "development"),
    root: path.resolve(toSlash(process.cwd()), root ?? "."),
    ...(root ? { rootArg: root } : {}),
    ...(configFile ? { configFile: path.resolve(toSlash(process.cwd()), configFile) } : {}),
  };
}

/** Match the Vite config loaded by the outer CLI, not one loaded by a nested server. */
export function isViteCliConfigFile(
  configFile: string,
  inlineConfig?: Pick<InlineConfig, "root" | "configFile">,
): boolean {
  const invocation = getViteCliInvocation();
  if (!invocation || !path.isAbsolute(configFile)) return false;
  if (inlineConfig) {
    if (inlineConfig.root !== invocation.rootArg) return false;
    if (invocation.configFile) {
      if (
        typeof inlineConfig.configFile !== "string" ||
        path.resolve(toSlash(process.cwd()), inlineConfig.configFile) !== invocation.configFile
      )
        return false;
    } else if (inlineConfig.configFile !== undefined) {
      return false;
    }
  }
  const expected = invocation.configFile ?? findViteConfigPath(invocation.root);
  return expected !== undefined && path.resolve(configFile) === expected;
}

/** Distinguish real Vite/Vite+ CLI commands from programmatic API callers. */
export function isViteCliInvocation(
  command: ViteCliCommand,
  argv: string[] = process.argv,
): boolean {
  return commandArguments(argv)?.command === command;
}

/** Claim the single application lifecycle owned by a top-level Vite CLI build. */
export function claimViteCliBuildInvocation(argv: string[] = process.argv): boolean {
  if (buildInvocationClaimed || !isViteCliInvocation("build", argv)) return false;
  buildInvocationClaimed = true;
  return true;
}
