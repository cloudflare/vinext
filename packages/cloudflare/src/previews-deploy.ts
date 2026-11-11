import { parseArgs } from "node:util";

function validatePreviewName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Preview name must not be empty.");
  if (trimmed.includes("\0")) throw new Error("Preview names cannot contain null bytes.");
  if (trimmed.startsWith("-")) throw new Error("Preview name must not start with '-'.");
  return trimmed;
}

function validateMode(mode: string): string {
  const trimmed = mode.trim();
  // Match `cf previews deploy`, which rejects an empty mode instead of using the default.
  if (!trimmed) throw new Error("--mode requires a non-empty value.");
  return trimmed;
}

/** CLI options for `vinext-cloudflare previews deploy`. */
export function parsePreviewsDeployArgs(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      mode: { type: "string" },
      "preview-name": { type: "string" },
      "skip-build": { type: "boolean", default: false },
      "vite-config": { type: "string" },
    },
  });

  // Like `cf previews deploy`, the Preview name is a flag, not a positional argument.
  if (positionals.length > 0) {
    throw new Error(
      `Unexpected argument: ${positionals[0]}. Pass the Preview name with --preview-name <name>.`,
    );
  }

  const previewName = values["preview-name"];
  return {
    help: values.help,
    name: previewName === undefined ? undefined : validatePreviewName(previewName),
    mode: values.mode === undefined ? undefined : validateMode(values.mode),
    skipBuild: values["skip-build"],
    viteConfig: values["vite-config"]?.trim() || undefined,
  };
}
