/**
 * CLI argument parser for the vinext CLI.
 *
 * Parses flags for `vinext dev`, `vinext start`, `vinext build`, etc.
 * Validates that value-taking flags (`--port`, `--hostname`) have actual values
 * rather than silently consuming the next flag or returning NaN/undefined.
 */

type ParsedArgs = {
  port?: number;
  hostname?: string;
  help?: boolean;
  verbose?: boolean;
  turbopack?: boolean;
  experimental?: boolean;
  prerenderAll?: boolean;
  precompress?: boolean;
};

// Matches long flags (--foo) and single-letter short flags (-x).
// Digits and multi-char sequences (e.g. -1, -abc) are excluded by [a-zA-Z] and $.
const FLAG_PATTERN = /^(?:--|-[a-zA-Z]$)/;

/**
 * Consume the next positional argument as a value for a flag.
 *
 * Throws if:
 * - No argument follows (end of argv)
 * - The value is an empty string
 * - The next argument is another flag (--long or -x short form)
 */
function takeValue(flag: string, args: string[], i: number): string {
  const next = args[i + 1];
  if (next === undefined || next === "") {
    throw new Error(`${flag} requires a value, but none was provided.`);
  }
  if (FLAG_PATTERN.test(next)) {
    throw new Error(`${flag} requires a value, but got "${next}" which looks like another flag.`);
  }
  return next;
}

/**
 * Try to extract a value from `--flag=value` form.
 * Returns the raw value, or null if the arg doesn't match this flag's = form.
 */
function tryEqualsForm(arg: string, flagName: string): string | null {
  const prefix = `--${flagName}=`;
  return arg.startsWith(prefix) ? arg.slice(prefix.length) : null;
}

/**
 * Parse a port string into a valid TCP port number (0-65535).
 *
 * Uses `Number()` instead of `parseInt()` so that trailing garbage
 * (`4000abc`) is rejected rather than silently truncated to 4000.
 */
function parsePort(raw: string, flag: string): number {
  if (raw === "") {
    throw new Error(`${flag} requires a value, but none was provided.`);
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${flag} expects an integer, but got "${raw}".`);
  }
  if (parsed < 0 || parsed > 65535) {
    throw new Error(`${flag} expects a valid port (0-65535), but got "${raw}".`);
  }
  return parsed;
}

/**
 * Parse CLI arguments into a structured object.
 *
 * Handles both `--flag value` and `--flag=value` forms for value-taking flags.
 *
 * Used by `vinext dev`, `build`, `start`, `lint`, `check`, and `init` commands.
 * The `deploy` command uses `parseDeployArgs` (a `node:util` wrapper) for its
 * own flag set including `--env`, `--skip-build`, etc.
 */
export function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        result.help = true;
        break;

      case "--verbose":
        result.verbose = true;
        break;

      case "--turbopack":
        result.turbopack = true;
        break;

      case "--experimental-https":
        result.experimental = true;
        break;

      case "--prerender-all":
        result.prerenderAll = true;
        break;

      case "--precompress":
        result.precompress = true;
        break;

      case "--port":
      case "-p": {
        const raw = takeValue(arg, args, i);
        i++;
        result.port = parsePort(raw, arg);
        break;
      }

      case "--hostname":
      case "-H": {
        result.hostname = takeValue(arg, args, i);
        i++;
        break;
      }

      default: {
        // Handle --flag=value forms (e.g. --port=3000, --hostname=0.0.0.0).
        const eqRaw = tryEqualsForm(arg, "port");
        if (eqRaw !== null) {
          result.port = parsePort(eqRaw, "--port");
          break;
        }
        const hostRaw = tryEqualsForm(arg, "hostname");
        if (hostRaw !== null) {
          if (hostRaw === "") {
            throw new Error(`--hostname requires a value, but none was provided.`);
          }
          result.hostname = hostRaw;
          break;
        }
        break;
      }
    }
  }
  return result;
}
