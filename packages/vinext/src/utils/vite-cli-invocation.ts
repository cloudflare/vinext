import path, { toSlash } from "pathslash";

type ViteCliCommand = "dev" | "build";

const VITE_COMMANDS = new Set(["build", "dev", "optimize", "preview", "serve"]);
const VITE_GLOBAL_OPTIONS_WITH_VALUES = new Set([
  "--base",
  "--config",
  "--configLoader",
  "--debug",
  "--filter",
  "--logLevel",
  "--mode",
  "--profile",
  "-c",
  "-d",
  "-f",
  "-l",
  "-m",
]);

function findViteCommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (VITE_GLOBAL_OPTIONS_WITH_VALUES.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith("-")) return VITE_COMMANDS.has(arg) ? arg : undefined;
  }
}

function matchesViteCommand(args: string[], command: ViteCliCommand, defaultDev: boolean): boolean {
  const cliCommand = findViteCommand(args);
  return command === "build"
    ? cliCommand === "build"
    : cliCommand === "dev" || cliCommand === "serve" || (defaultDev && cliCommand === undefined);
}

/** Distinguish real Vite/Vite+ CLI commands from programmatic API callers. */
export function isViteCliInvocation(
  command: ViteCliCommand,
  argv: string[] = process.argv,
): boolean {
  const entry = toSlash(argv[1] ?? "");
  const isViteEntry =
    entry.endsWith("/vite/bin/vite.js") ||
    entry.endsWith("/vite/node/cli.js") ||
    entry.endsWith("/dist/vite/node/cli.js");
  if (isViteEntry) return matchesViteCommand(argv.slice(2), command, true);

  if (path.basename(entry) !== "vp") return false;
  if (argv[2] === "exec" && argv[3] === "vite") {
    return matchesViteCommand(argv.slice(4), command, true);
  }
  return matchesViteCommand(argv.slice(2), command, false);
}
