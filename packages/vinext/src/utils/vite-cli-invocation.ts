import fs from "node:fs";
import path, { toSlash } from "pathslash";
import type { InlineConfig } from "vite";
import { findViteConfigPath } from "./project.js";

type Command = "dev" | "build";
type Invocation = {
  command: Command;
  mode: string;
  root: string;
  rootArg?: string;
  configFile?: string;
};

let buildClaimed = false;

// Only options whose values could be mistaken for a positional root. Vite
// remains responsible for validation and options not listed here.
const valued = new Set(
  "--config -c --mode -m --logLevel -l --filter -f --configLoader --port --outDir --target --assetsDir --assetsInlineLimit".split(
    " ",
  ),
);
const optional = new Set(
  "--base --debug -d --host --open --profile --ssr --sourcemap --minify --manifest --ssrManifest".split(
    " ",
  ),
);
const flags = new Set(
  "--app --clearScreen --cors --emptyOutDir --experimentalBundle --force --strictPort --watch -w --help -h --version -v".split(
    " ",
  ),
);
const devOnly = new Set(
  "--host --port --open --cors --strictPort --force --experimentalBundle".split(" "),
);
const buildOnly = new Set(
  "--target --outDir --assetsDir --assetsInlineLimit --ssr --sourcemap --minify --manifest --ssrManifest --emptyOutDir --watch -w --app".split(
    " ",
  ),
);

export function valueOptionName(arg: string): string {
  const name = arg.split("=", 1)[0];
  if (!name.startsWith("-") || name.startsWith("--") || name.length <= 2) return name;
  const parts = name
    .slice(1)
    .split("")
    .map((part) => `-${part}`);
  return parts.every((part) => valued.has(part) || optional.has(part) || flags.has(part))
    ? parts.at(-1)!
    : name;
}

function consumesNext(arg: string, next: string | undefined): boolean {
  if (arg.includes("=")) return false;
  const name = valueOptionName(arg);
  if (valued.has(name)) return true;
  if (optional.has(name)) return next !== undefined && !next.startsWith("-");
  return flags.has(name) && /^(?:true|false)$/.test(next ?? "");
}

function parse(args: string[], command: Command) {
  let root: string | undefined;
  let mode: string | undefined;
  let config: string | undefined;
  let preflight = true;
  let uncertainRoot = false;
  let configs = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    const name = valueOptionName(arg);
    const normalized = name.startsWith("--no-") ? `--${name.slice(5)}` : name;
    const inline = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined;
    const takesNext = consumesNext(arg, args[i + 1]);
    const value = inline ?? (takesNext ? args[i + 1] : undefined);
    if (name === "--config" || name === "-c") {
      configs++;
      if (command === "dev") config = value;
      else config ??= value;
    } else if (name === "--mode" || name === "-m") {
      mode = value;
    }
    if (
      ((name === "--help" || name === "-h") && value !== "false") ||
      (/^-[^-]*h/.test(arg) && arg.length > 2)
    )
      preflight = false;
    if (valued.has(name) && (!value || value.startsWith("-"))) {
      preflight = false;
      if (!root) uncertainRoot = true;
    }
    if ((command === "build" ? devOnly : buildOnly).has(normalized)) preflight = false;
    if (arg.startsWith("-")) {
      if (
        (!valued.has(normalized) && !optional.has(normalized) && !flags.has(normalized)) ||
        (name.startsWith("--no-") && (valued.has(normalized) || inline !== undefined)) ||
        (/^-[^-]{2,}/.test(arg) &&
          arg
            .slice(1)
            .split("=", 1)[0]
            .split("")
            .slice(0, -1)
            .some((part) => valued.has(`-${part}`)))
      ) {
        preflight = false;
        if (!root) uncertainRoot = true;
      }
      if (takesNext) i++;
      continue;
    }
    if (root) preflight = false;
    else root = arg;
  }
  if (configs > 1) preflight = false;
  return { root: uncertainRoot ? undefined : root, mode, config, preflight };
}

export function findViteRoot(command: Command, args: string[]) {
  const { root, preflight } = parse(args, command);
  return { root, shouldPreflight: preflight };
}

function isViteEntry(entry: string): boolean {
  return (
    entry.endsWith("/vite/bin/vite.js") ||
    entry.endsWith("/vite/node/cli.js") ||
    entry.endsWith("/dist/vite/node/cli.js")
  );
}

function commandArguments(argv: string[]): { command: Command; args: string[] } | undefined {
  const entry = toSlash(argv[1] ?? "");
  let vite = isViteEntry(entry);
  if (!vite && entry && path.basename(entry) !== "vp") {
    try {
      // npm's POSIX bin links remain in argv[1] even though Node loads their target.
      vite = isViteEntry(toSlash(fs.realpathSync.native(entry)));
    } catch {
      // Non-file or missing entries are not Vite CLI invocations.
    }
  }
  let args = argv.slice(2);
  if (!vite) {
    if (path.basename(entry) !== "vp") return undefined;
    if (args[0] === "-C") args = args.slice(2);
    if (args[0] === "exec" && args[1] === "vite") args = args.slice(2);
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg.startsWith("-")) {
      if (consumesNext(arg, args[i + 1])) i++;
      continue;
    }
    if (arg === "build")
      return { command: "build", args: args.slice(0, i).concat(args.slice(i + 1)) };
    if (arg === "dev" || arg === "serve")
      return { command: "dev", args: args.slice(0, i).concat(args.slice(i + 1)) };
    return vite && arg !== "preview" && arg !== "optimize" ? { command: "dev", args } : undefined;
  }
  return vite ? { command: "dev", args } : undefined;
}

export function getViteCliInvocation(argv: string[] = process.argv): Invocation | undefined {
  const invocation = commandArguments(argv);
  if (!invocation) return undefined;
  const { root, mode, config } = parse(invocation.args, invocation.command);
  const cwd = toSlash(process.cwd());
  return {
    command: invocation.command,
    mode: mode || (invocation.command === "build" ? "production" : "development"),
    root: path.resolve(cwd, root ?? "."),
    ...(root ? { rootArg: root } : {}),
    ...(config ? { configFile: path.resolve(cwd, config) } : {}),
  };
}

/** Only the config loaded by the outer CLI may claim its dev lifecycle. */
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

export function isViteCliInvocation(command: Command, argv: string[] = process.argv): boolean {
  return commandArguments(argv)?.command === command;
}

export function claimViteCliBuildInvocation(argv: string[] = process.argv): boolean {
  if (buildClaimed || !isViteCliInvocation("build", argv)) return false;
  buildClaimed = true;
  return true;
}
