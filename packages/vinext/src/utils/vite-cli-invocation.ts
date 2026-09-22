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
const VALUELESS_OPTIONS = new Set(["--help", "-h", "--version", "-v"]);
const COMMAND_ONLY_OPTIONS: Record<ViteCliCommand, Set<string>> = {
  dev: new Set([
    "--host",
    "--port",
    "--open",
    "--cors",
    "--strictPort",
    "--force",
    "--experimentalBundle",
  ]),
  build: new Set([
    "--target",
    "--outDir",
    "--assetsDir",
    "--assetsInlineLimit",
    "--ssr",
    "--sourcemap",
    "--minify",
    "--manifest",
    "--ssrManifest",
    "--emptyOutDir",
    "--watch",
    "-w",
    "--app",
  ]),
};

function optionName(arg: string): string {
  const equalsIndex = arg.indexOf("=");
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
}

function clusteredShortOptions(arg: string): string[] | undefined {
  const name = optionName(arg);
  if (!name.startsWith("-") || name.startsWith("--") || name.length <= 2) return undefined;
  const options = name.slice(1);
  return Array.from(options).every((option) => SHORT_OPTIONS.has(option))
    ? Array.from(options, (option) => `-${option}`)
    : undefined;
}

export function valueOptionName(arg: string): string {
  return clusteredShortOptions(arg)?.at(-1) ?? optionName(arg);
}

function optionHasInlineValue(arg: string): boolean {
  return arg.includes("=");
}

function optionConsumesNext(arg: string, next: string | undefined): boolean {
  if (optionHasInlineValue(arg)) return false;
  const option = valueOptionName(arg);
  if (REQUIRED_VALUE_OPTIONS.has(option)) return true;
  if (OPTIONAL_VALUE_OPTIONS.has(option)) return next !== undefined && !next.startsWith("-");
  if (VALUELESS_OPTIONS.has(option)) return /^(?:true|false)$/.test(next ?? "");
  // CAC does not consume a separate value following --no-*.
  return BOOLEAN_OPTIONS.has(option) && /^(?:true|false)$/.test(next ?? "");
}

function requiredOptionValueIsMissing(arg: string, next: string | undefined): boolean {
  if (!REQUIRED_VALUE_OPTIONS.has(valueOptionName(arg))) return false;
  return optionHasInlineValue(arg)
    ? arg.slice(arg.indexOf("=") + 1) === ""
    : next === undefined || next.startsWith("-");
}

export function findViteRoot(
  command: ViteCliCommand,
  args: string[],
): { root?: string; shouldPreflight: boolean } {
  let root: string | undefined;
  let shouldPreflight = true;
  const otherCommand = command === "dev" ? "build" : "dev";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;
    const clusteredOptions = clusteredShortOptions(arg);
    const option = clusteredOptions?.at(-1) ?? optionName(arg);
    const earlierGlobalOption = clusteredOptions
      ?.slice(0, -1)
      .some((name) => VALUELESS_OPTIONS.has(name));
    if (
      earlierGlobalOption ||
      (VALUELESS_OPTIONS.has(option) &&
        (optionHasInlineValue(arg)
          ? arg.slice(arg.indexOf("=") + 1) !== "false"
          : args[index + 1] !== "false"))
    ) {
      shouldPreflight = false;
    }
    if (clusteredOptions?.slice(0, -1).some((name) => REQUIRED_VALUE_OPTIONS.has(name))) {
      shouldPreflight = false;
    }
    if (requiredOptionValueIsMissing(arg, args[index + 1])) {
      shouldPreflight = false;
      continue;
    }
    const normalizedOptions = (clusteredOptions ?? [option]).map((name) =>
      name.startsWith("--no-") ? `--${name.slice(5)}` : name,
    );
    if (normalizedOptions.some((name) => COMMAND_ONLY_OPTIONS[otherCommand].has(name))) {
      shouldPreflight = false;
    }
    if (optionConsumesNext(arg, args[index + 1])) {
      index++;
      continue;
    }
    if (arg.startsWith("-")) {
      const normalizedOption = option.startsWith("--no-") ? `--${option.slice(5)}` : option;
      if (
        (option.startsWith("--no-") && optionHasInlineValue(arg)) ||
        (!clusteredOptions &&
          !REQUIRED_VALUE_OPTIONS.has(option) &&
          !OPTIONAL_VALUE_OPTIONS.has(normalizedOption) &&
          !VALUELESS_OPTIONS.has(normalizedOption) &&
          !BOOLEAN_OPTIONS.has(normalizedOption))
      ) {
        shouldPreflight = false;
      }
      continue;
    }
    if (root !== undefined) shouldPreflight = false;
    else root = arg;
  }
  return { root, shouldPreflight };
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
    const option = valueOptionName(arg);
    if (option === "--config" || option === "-c") {
      const value = optionHasInlineValue(arg)
        ? arg.slice(arg.indexOf("=") + 1)
        : invocation.args[++index];
      // Vite dev keeps the last repeated --config, while Vite build keeps
      // the first. Match the installed CLI when identifying its config.
      if (invocation.command === "dev") configFile = value;
      else configFile ??= value;
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
