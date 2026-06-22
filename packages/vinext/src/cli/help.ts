/**
 * Help-text generation for the vinext CLI command framework.
 *
 * Help is rendered from the same {@link CommandSpec} that drives parsing, so
 * the documented flags can never drift from the parsed ones. ANSI styling is
 * applied only when stdout is a TTY, so piped/redirected output and test
 * snapshots stay plain text.
 */

import type { ArgSpec, CommandSpec } from "./types.js";

const INDENT = "  ";
const ITEM_INDENT = "    ";
/** Spaces between an item's label column and its description column. */
const COLUMN_GAP = 2;

const isTTY = () => Boolean(process.stdout.isTTY);
const bold = (s: string) => (isTTY() ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (isTTY() ? `\x1b[2m${s}\x1b[0m` : s);

/** Default angle-bracket placeholder for a value flag lacking an explicit hint. */
function valuePlaceholder(arg: ArgSpec): string {
  if (arg.type === "boolean") return "";
  const hint =
    arg.valueHint ?? (arg.type === "port" ? "port" : arg.type === "string" ? "value" : "n");
  return ` <${hint}>`;
}

/** The left-hand label for an option row, e.g. `-p, --port <port>`. */
function optionLabel(name: string, arg: ArgSpec): string {
  const short = arg.short ? `-${arg.short}, ` : "";
  return `${short}--${name}${valuePlaceholder(arg)}`;
}

/** The trailing `(default: …)` suffix for value flags that declare a default. */
function defaultSuffix(arg: ArgSpec): string {
  if (arg.type === "boolean" || arg.default === undefined) return "";
  return dim(` (default: ${arg.default})`);
}

/** Render a block of aligned `label  description` rows. */
function renderRows(rows: Array<{ label: string; description: string }>): string[] {
  const width = Math.max(...rows.map((r) => r.label.length));
  return rows.map((r) => `${ITEM_INDENT}${r.label.padEnd(width + COLUMN_GAP)}${r.description}`);
}

/**
 * Render the full `--help` output for a single command.
 *
 * The framework always documents a trailing `-h, --help` row, matching the
 * `help` flag it injects during parsing.
 */
export function renderCommandHelp<A extends Record<string, ArgSpec>>(spec: CommandSpec<A>): string {
  const lines: string[] = [];
  const args = (spec.args ?? {}) as Record<string, ArgSpec>;

  lines.push("");
  lines.push(`${INDENT}${bold(`vinext ${spec.name}`)} - ${spec.summary}`);
  lines.push("");
  lines.push(`${INDENT}${bold("Usage:")} ${spec.usage ?? `vinext ${spec.name} [options]`}`);

  if (spec.description) {
    lines.push("");
    for (const line of spec.description.split("\n")) {
      lines.push(line ? `${INDENT}${line}` : "");
    }
  }

  if (spec.positionals && spec.positionals.length > 0) {
    lines.push("");
    lines.push(`${INDENT}${bold("Arguments:")}`);
    lines.push(
      ...renderRows(
        spec.positionals.map((p) => ({
          label: p.variadic ? `[${p.name}...]` : `[${p.name}]`,
          description: p.description,
        })),
      ),
    );
  }

  lines.push("");
  lines.push(`${INDENT}${bold("Options:")}`);
  const optionRows = Object.entries(args)
    .filter(([, arg]) => !arg.hidden)
    .map(([name, arg]) => ({
      label: optionLabel(name, arg),
      description: `${arg.description}${defaultSuffix(arg)}`,
    }));
  optionRows.push({ label: "-h, --help", description: "Show this help" });
  lines.push(...renderRows(optionRows));

  if (spec.examples && spec.examples.length > 0) {
    lines.push("");
    lines.push(`${INDENT}${bold("Examples:")}`);
    lines.push(
      ...renderRows(
        spec.examples.map((e) => ({ label: e.command, description: e.description ?? "" })),
      ),
    );
  }

  if (spec.notes) {
    lines.push("");
    for (const line of spec.notes.split("\n")) {
      lines.push(line ? `${INDENT}${line}` : "");
    }
  }

  lines.push("");
  return lines.join("\n");
}
