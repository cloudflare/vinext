import path, { toSlash } from "pathslash";

type ViteCliCommand = "dev" | "build";

let buildInvocationClaimed = false;

function findVpCommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-C") {
      i++;
      continue;
    }
    if (!arg.startsWith("-")) return arg;
  }
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
  // ConfigEnv already identifies build, serve, and preview. Once provenance is
  // known, parsing Vite's CLI arguments again only risks disagreeing with CAC.
  if (isViteEntry) return true;

  if (path.basename(entry) !== "vp") return false;
  const args = argv.slice(2);
  const vpCommand = findVpCommand(args);
  if (vpCommand === "exec") return args[args.indexOf("exec") + 1] === "vite";
  return command === "build" ? vpCommand === "build" : vpCommand === "dev" || vpCommand === "serve";
}

/** Claim the single application lifecycle owned by a top-level Vite CLI build. */
export function claimViteCliBuildInvocation(argv: string[] = process.argv): boolean {
  if (buildInvocationClaimed || !isViteCliInvocation("build", argv)) return false;
  buildInvocationClaimed = true;
  return true;
}
