import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import {
  buildNodeCliInvocation,
  resolveWranglerBin,
  validateWranglerEnvName,
  type DeployOptions,
} from "./deploy.js";
import { parseWorkersDevUrl } from "./workers-dev-url.js";

export { parseWorkersDevUrl } from "./workers-dev-url.js";

export type WranglerVersionUploadResult = {
  versionId: string;
  previewUrl: string | null;
  output: string;
};

export type WranglerVersionDeployResult = {
  deployedUrl: string | null;
  output: string;
};

export type WranglerVersionTraffic = {
  versionId: string;
  percentage: number;
};

export type WranglerDeploymentStatus = {
  versions: WranglerVersionTraffic[];
  output: string;
};

type WranglerVersionArgs = {
  args: string[];
  env: string | undefined;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(output: string): JsonRecord | unknown[] | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) || Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function findStringInRecord(value: unknown, keys: readonly string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.length > 0) return field;
  }
  return null;
}

function findVersionIdInUploadJson(parsed: JsonRecord | unknown[] | null): string | null {
  if (!isRecord(parsed)) return null;
  return (
    findStringInRecord(parsed, ["version_id", "versionId", "id"]) ??
    findStringInRecord(parsed.version, ["version_id", "versionId", "id"]) ??
    findStringInRecord(parsed.result, ["version_id", "versionId", "id"])
  );
}

function findPreviewUrlInUploadJson(parsed: JsonRecord | unknown[] | null): string | null {
  if (!isRecord(parsed)) return null;
  return (
    findStringInRecord(parsed, ["preview_url", "previewUrl", "url"]) ??
    findStringInRecord(parsed.version, ["preview_url", "previewUrl", "url"]) ??
    findStringInRecord(parsed.result, ["preview_url", "previewUrl", "url"])
  );
}

export function parseVersionId(output: string): string | null {
  return (
    output.match(
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/,
    )?.[0] ?? null
  );
}

export function parseWranglerVersionUploadOutput(output: string): WranglerVersionUploadResult {
  const parsed = parseJsonObject(output);
  const versionId = findVersionIdInUploadJson(parsed) ?? parseVersionId(output);
  const previewUrl = findPreviewUrlInUploadJson(parsed) ?? parseWorkersDevUrl(output);

  if (!versionId) {
    throw new Error("Could not detect Worker version ID from `wrangler versions upload` output.");
  }

  return { versionId, previewUrl, output };
}

export function buildWranglerVersionUploadArgs(
  options: Pick<DeployOptions, "preview" | "env" | "name" | "config"> & { previewAlias?: string },
): WranglerVersionArgs {
  const args = ["versions", "upload"];
  const env = options.env || (options.preview ? "preview" : undefined);
  if (options.config) {
    args.push("--config", options.config);
  }
  if (options.name) {
    args.push("--name", options.name);
  }
  if (env) {
    args.push("--env", validateWranglerEnvName(env));
  }
  if (options.previewAlias) {
    args.push("--preview-alias", options.previewAlias);
  }
  return { args, env };
}

export function buildWranglerVersionDeployArgs(
  versionTraffic: readonly WranglerVersionTraffic[],
  options: Pick<DeployOptions, "preview" | "env" | "name" | "config">,
): WranglerVersionArgs {
  const args = [
    "versions",
    "deploy",
    ...versionTraffic.map(({ versionId, percentage }) => `${versionId}@${percentage}%`),
    "--yes",
  ];
  const env = options.env || (options.preview ? "preview" : undefined);
  if (options.config) {
    args.push("--config", options.config);
  }
  if (options.name) {
    args.push("--name", options.name);
  }
  if (env) {
    args.push("--env", validateWranglerEnvName(env));
  }
  return { args, env };
}

export function buildWranglerDeploymentsStatusArgs(
  options: Pick<DeployOptions, "preview" | "env" | "name" | "config">,
): WranglerVersionArgs {
  const args = ["deployments", "status", "--json"];
  const env = options.env || (options.preview ? "preview" : undefined);
  if (options.config) {
    args.push("--config", options.config);
  }
  if (options.name) {
    args.push("--name", options.name);
  }
  if (env) {
    args.push("--env", validateWranglerEnvName(env));
  }
  return { args, env };
}

export function buildWranglerTriggersDeployArgs(
  options: Pick<DeployOptions, "preview" | "env" | "name" | "config">,
): WranglerVersionArgs {
  const args = ["triggers", "deploy"];
  const env = options.env || (options.preview ? "preview" : undefined);
  if (options.config) {
    args.push("--config", options.config);
  }
  if (options.name) {
    args.push("--name", options.name);
  }
  if (env) {
    args.push("--env", validateWranglerEnvName(env));
  }
  return { args, env };
}

function runWranglerCommand(
  root: string,
  args: string[],
  execute: typeof execFileSync = execFileSync,
): string {
  const wranglerBin = resolveWranglerBin(root);
  const invocation = buildNodeCliInvocation(wranglerBin, args);
  const execOpts: ExecFileSyncOptions = {
    cwd: root,
    stdio: "pipe",
    encoding: "utf-8",
    shell: false,
  };
  const output = execute(invocation.file, invocation.args, execOpts) as string;
  if (output.trim()) {
    for (const line of output.trim().split("\n")) {
      console.log(`  ${line}`);
    }
  }
  return output;
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const parts = error instanceof Error ? [error.message] : [];
  const record = error as Record<string, unknown>;
  for (const field of ["stdout", "stderr", "output"] as const) {
    const value = record[field];
    if (Array.isArray(value)) {
      parts.push(
        ...value
          .filter(
            (entry): entry is string | Buffer =>
              typeof entry === "string" || Buffer.isBuffer(entry),
          )
          .map((entry) => entry.toString()),
      );
    } else if (typeof value === "string" || Buffer.isBuffer(value)) {
      parts.push(value.toString());
    }
  }
  return parts.join("\n");
}

function isMissingWorkerVersionUploadError(error: unknown): boolean {
  return /cannot upload a new version of a Worker that does not yet exist/i.test(errorText(error));
}

function withInitialDeployRequiredMessage(): Error {
  const message =
    "CDN pre-warm needs an existing Cloudflare Worker before it can upload a new Worker version. " +
    "Run `vinext-cloudflare deploy` once without `--experimental-warm-cdn-cache` to create the Worker, then rerun your pre-warm deploy.";
  return new Error(message);
}

function parseDeploymentVersions(value: unknown): WranglerVersionTraffic[] {
  const deployment = Array.isArray(value) ? value.at(-1) : value;
  if (!isRecord(deployment) || !Array.isArray(deployment.versions)) return [];

  const versions: WranglerVersionTraffic[] = [];
  for (const version of deployment.versions) {
    if (!isRecord(version)) continue;
    const versionId = version.version_id;
    const percentage = version.percentage;
    if (typeof versionId !== "string" || typeof percentage !== "number") continue;
    versions.push({ versionId, percentage });
  }
  return versions;
}

export function parseWranglerDeploymentStatusOutput(output: string): WranglerDeploymentStatus {
  const parsed = parseJsonObject(output);
  if (!parsed) {
    throw new Error("Could not parse `wrangler deployments status --json` output.");
  }

  return { versions: parseDeploymentVersions(parsed), output };
}

export function runWranglerVersionUpload(
  root: string,
  options: Pick<DeployOptions, "preview" | "env" | "name" | "config"> & { previewAlias?: string },
  execute: typeof execFileSync = execFileSync,
): WranglerVersionUploadResult {
  const { args, env } = buildWranglerVersionUploadArgs(options);
  if (env) {
    console.log(`\n  Uploading Worker version for env: ${env}...`);
  } else {
    console.log("\n  Uploading Worker version for production...");
  }
  try {
    return parseWranglerVersionUploadOutput(runWranglerCommand(root, args, execute));
  } catch (error) {
    if (isMissingWorkerVersionUploadError(error)) {
      throw withInitialDeployRequiredMessage();
    }
    throw error;
  }
}

export function runWranglerVersionDeploy(
  root: string,
  versionTraffic: readonly WranglerVersionTraffic[],
  options: Pick<DeployOptions, "preview" | "env" | "name" | "config">,
  phase: "stage" | "promote-warmed" | "promote-uploaded" = "promote-uploaded",
  execute: typeof execFileSync = execFileSync,
): WranglerVersionDeployResult {
  const { args, env } = buildWranglerVersionDeployArgs(versionTraffic, options);
  const target = env ? `env: ${env}` : "production";
  if (phase === "stage") {
    console.log(`\n  Staging uploaded Worker version at 0% for CDN warmup in ${target}...`);
  } else if (phase === "promote-warmed") {
    console.log(`\n  Promoting warmed Worker version to ${target}...`);
  } else {
    console.log(`\n  Promoting uploaded Worker version to ${target}...`);
  }
  const output = runWranglerCommand(root, args, execute);
  return { deployedUrl: parseWorkersDevUrl(output), output };
}

export function runWranglerDeploymentStatus(
  root: string,
  options: Pick<DeployOptions, "preview" | "env" | "name" | "config">,
  execute: typeof execFileSync = execFileSync,
): WranglerDeploymentStatus {
  const { args, env } = buildWranglerDeploymentsStatusArgs(options);
  if (env) {
    console.log(`\n  Reading current Worker deployment for env: ${env}...`);
  } else {
    console.log("\n  Reading current Worker deployment...");
  }
  return parseWranglerDeploymentStatusOutput(runWranglerCommand(root, args, execute));
}

export function runWranglerTriggersDeploy(
  root: string,
  options: Pick<DeployOptions, "preview" | "env" | "name" | "config">,
  execute: typeof execFileSync = execFileSync,
): WranglerVersionDeployResult {
  const { args, env } = buildWranglerTriggersDeployArgs(options);
  if (env) {
    console.log(`\n  Applying Worker triggers for env: ${env}...`);
  } else {
    console.log("\n  Applying Worker triggers...");
  }
  const output = runWranglerCommand(root, args, execute);
  return { deployedUrl: parseWorkersDevUrl(output), output };
}
