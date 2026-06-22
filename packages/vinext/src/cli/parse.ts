/**
 * Argument parsing engine for the vinext CLI command framework.
 *
 * Wraps Node's built-in `node:util` `parseArgs` (the parser already used by
 * `vinext deploy`) and layers on:
 *
 *   - Typed coercion driven by each flag's {@link ArgType} (`port`, `int`,
 *     `positiveInt`, `string`, `boolean`).
 *   - The strict value validation previously hand-rolled in `cli-args.ts`:
 *     value-taking flags error on missing/empty values and reject a following
 *     token that "looks like another flag" (e.g. `--port --hostname`).
 *   - Per-command defaults applied to the returned values.
 *   - A strict-by-default unknown-flag policy: undeclared flags raise a
 *     {@link CliUsageError}, with a per-command `passthroughUnknown` opt-in
 *     for commands that must tolerate arbitrary pass-through flags.
 *
 * Parsing errors throw a {@link CliUsageError} so the caller can render them
 * cleanly without a stack trace.
 */

import { parseArgs as nodeParseArgs } from "node:util";
import type { ArgSpec, CommandSpec, InferValues } from "./types.js";

/**
 * Matches long flags (`--foo`) and single-letter short flags (`-x`). Digits and
 * multi-char sequences (e.g. `-1`, `-abc`) are intentionally excluded so that
 * negative numbers are not mistaken for flags.
 */
const FLAG_PATTERN = /^(?:--|-[a-zA-Z]$)/;

/** Value-taking arg kinds (everything except `boolean`). */
type ValueArgType = Exclude<ArgSpec["type"], "boolean">;

/** Error raised for invalid CLI usage (bad flag value, missing value, etc.). */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/** Result of parsing one command's argv. */
export type ParseResult<A extends Record<string, ArgSpec>> = {
  /** Parsed, coerced, defaulted flag values plus the framework `help` flag. */
  values: InferValues<A> & { help: boolean };
  /** Positional arguments in order. */
  positionals: string[];
};

function coerceInteger(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new CliUsageError(`${flag} expects an integer, but got "${raw}".`);
  }
  return parsed;
}

/**
 * Coerce a raw string value into the type declared by its {@link ArgSpec}.
 * Mirrors the validation messages from the legacy `cli-args.ts` parser.
 */
function coerceValue(raw: string, type: ValueArgType, flag: string): string | number {
  switch (type) {
    case "string":
      return raw;
    case "int":
      return coerceInteger(raw, flag);
    case "positiveInt": {
      // Match the legacy parsePositiveIntegerArg: a single "positive integer"
      // message covers both non-integers (e.g. "4.5") and values <= 0.
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CliUsageError(`${flag} expects a positive integer, but got "${raw}".`);
      }
      return parsed;
    }
    case "port": {
      const parsed = coerceInteger(raw, flag);
      if (parsed < 0 || parsed > 65535) {
        throw new CliUsageError(`${flag} expects a valid port (0-65535), but got "${raw}".`);
      }
      return parsed;
    }
  }
}

/**
 * Parse a command's argv into typed, validated values.
 *
 * A `help` boolean flag (with `-h` short alias) is always recognized, even if
 * the command does not declare it, so `--help` works uniformly everywhere.
 *
 * @throws {CliUsageError} when a value-taking flag is missing its value, is
 *   given an empty value, is followed by something that looks like another
 *   flag, or fails type coercion (e.g. a non-integer `--port`).
 */
export function parseCommand<A extends Record<string, ArgSpec>>(
  spec: Pick<CommandSpec<A>, "args" | "passthroughUnknown">,
  argv: string[],
): ParseResult<A> {
  const args = (spec.args ?? {}) as Record<string, ArgSpec>;

  // Build the node:util options map. A `help` flag is always available.
  const options: Record<
    string,
    { type: "boolean" | "string"; short?: string; multiple?: boolean }
  > = {
    help: { type: "boolean", short: "h" },
  };
  for (const [name, arg] of Object.entries(args)) {
    options[name] = {
      type: arg.type === "boolean" ? "boolean" : "string",
      ...(arg.short ? { short: arg.short } : {}),
      ...(arg.type !== "boolean" && arg.multiple ? { multiple: true } : {}),
    };
  }

  const {
    values: rawValues,
    positionals,
    tokens,
  } = nodeParseArgs({
    args: argv,
    options,
    allowPositionals: true,
    // Keep node:util lenient and enforce our own unknown-flag policy below, so
    // we can honor each command's `passthroughUnknown` opt-in and raise a
    // CliUsageError consistent with the rest of the framework.
    strict: false,
    tokens: true,
  });

  // Single pass over the token stream to (a) validate value-taking flags and
  // (b) remember the exact form the user typed (`-p` vs `--port`) so coercion
  // errors below reference the same spelling. Tokens preserve whether a value
  // was inline (`--port=3000`) vs. consumed from the next token (`--port 3000`),
  // which is what lets us reproduce the "looks like another flag" guard.
  const typedAs: Record<string, string> = {};
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    const arg = args[token.name];
    if (!arg) {
      // `help` is always injected and accepted. Any other undeclared flag is a
      // hard error unless the command opts into pass-through.
      if (token.name === "help" || spec.passthroughUnknown) continue;
      throw new CliUsageError(`Unknown option "${token.rawName}".`);
    }
    if (arg.type === "boolean") {
      // With `strict: false`, node:util accepts an inline value on a boolean
      // flag and stores it as a *string* (`--verbose=true` → "true"), which
      // would otherwise silently resolve to `false` below. Reject it instead —
      // silently flipping an explicitly-passed value is exactly the kind of
      // trap the strict-by-default policy is meant to prevent.
      if (token.value !== undefined) {
        throw new CliUsageError(
          `${token.rawName} does not take a value, but got "${token.value}".`,
        );
      }
      continue;
    }

    const label = token.rawName;
    typedAs[token.name] = label;

    if (token.value === undefined || token.value === "") {
      throw new CliUsageError(`${label} requires a value, but none was provided.`);
    }
    if (!token.inlineValue && FLAG_PATTERN.test(token.value)) {
      throw new CliUsageError(
        `${label} requires a value, but got "${token.value}" which looks like another flag.`,
      );
    }
  }

  // Build the typed result by iterating the spec (never the raw values) so
  // unknown flags are dropped, defaults are applied, and types are coerced.
  const result: Record<string, unknown> = {};
  for (const [name, arg] of Object.entries(args)) {
    const raw = rawValues[name];
    const label = typedAs[name] ?? `--${name}`;

    if (arg.type === "boolean") {
      // Boolean defaults are always false; a repeated boolean (node returns an
      // array) still resolves to true.
      result[name] = raw === true || (Array.isArray(raw) && raw.length > 0);
      continue;
    }

    if (arg.multiple) {
      const list = Array.isArray(raw) ? raw : [];
      result[name] = list.map((v) => coerceValue(String(v), arg.type, label));
      continue;
    }

    result[name] = typeof raw === "string" ? coerceValue(raw, arg.type, label) : arg.default;
  }

  return {
    values: { ...result, help: rawValues.help === true } as InferValues<A> & { help: boolean },
    positionals,
  };
}
