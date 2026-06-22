/**
 * Command runner for the vinext CLI framework.
 *
 * Ties together parsing ({@link parseCommand}), help rendering
 * ({@link renderCommandHelp}), and execution (`spec.run`):
 *
 *   1. If `--help`/`-h` is present, print the generated help and return.
 *   2. Otherwise parse argv into typed values and invoke `spec.run`.
 *   3. {@link CliUsageError}s (bad flags) are printed cleanly without a stack
 *      trace, followed by a hint to run `--help`, and exit with code 1.
 *
 * `defineCommand` is an identity helper that preserves the precise `args`
 * generic so `run`'s `ctx.values` is fully typed at the definition site.
 */

import { CliUsageError, parseCommand } from "./parse.js";
import { renderCommandHelp } from "./help.js";
import type { ArgSpec, CommandSpec } from "./types.js";

/** Identity helper that infers and preserves a command's `args` generic. */
export function defineCommand<A extends Record<string, ArgSpec>>(
  spec: CommandSpec<A>,
): CommandSpec<A> {
  return spec;
}

/**
 * Parse argv for `spec`, handle `--help`, and run the command.
 *
 * Parsing/usage errors are reported to stderr and exit the process with code 1.
 * Errors thrown by `spec.run` propagate to the caller (the top-level CLI
 * dispatcher already wraps command execution in a `.catch`).
 */
export async function runCommand<A extends Record<string, ArgSpec>>(
  spec: CommandSpec<A>,
  argv: string[],
): Promise<void> {
  let parsed;
  try {
    parsed = parseCommand(spec, argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(
        `\n  ${err.message}\n  Run \`vinext ${spec.name} --help\` for usage.\n\n`,
      );
      process.exit(1);
    }
    throw err;
  }

  if (parsed.values.help) {
    process.stdout.write(renderCommandHelp(spec) + "\n");
    return;
  }

  await spec.run({ values: parsed.values, positionals: parsed.positionals });
}
