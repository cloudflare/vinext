import path, { toSlash } from "pathslash";

type ViteCliCommand = "dev" | "build";

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
  if (isViteEntry) {
    const cliCommand = argv[2];
    return command === "build"
      ? cliCommand === "build"
      : cliCommand !== "build" && cliCommand !== "preview" && cliCommand !== "optimize";
  }

  if (path.basename(entry) !== "vp") return false;
  if (argv[2] === "exec" && argv[3] === "vite") {
    const cliCommand = argv[4];
    return command === "build"
      ? cliCommand === "build"
      : cliCommand !== "build" && cliCommand !== "preview" && cliCommand !== "optimize";
  }
  return command === "build" ? argv[2] === "build" : argv[2] === "dev" || argv[2] === "serve";
}
