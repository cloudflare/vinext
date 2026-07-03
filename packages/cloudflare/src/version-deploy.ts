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

function findStringByKey(value: unknown, keys: readonly string[]): string | null {
  if (!isRecord(value)) return null;
  for (const [key, field] of Object.entries(value)) {
    if (keys.includes(key) && typeof field === "string" && field.length > 0) {
      return field;
    }
    const nested = findStringByKey(field, keys);
    if (nested) return nested;
  }
  return null;
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

export function parseVersionId(output: string): string | null {
  return (
    output.match(
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/,
    )?.[0] ?? null
  );
}

export function parseWranglerVersionUploadOutput(output: string): WranglerVersionUploadResult {
  const parsed = parseJsonObject(output);
  const versionId =
    findStringByKey(parsed, ["id", "version_id", "versionId"]) ?? parseVersionId(output);
  const previewUrl =
    findStringByKey(parsed, ["preview_url", "previewUrl", "url"]) ?? parseWorkersDevUrl(output);

  if (!versionId) {
    throw new Error("Could not detect Worker version ID from `wrangler versions upload` output.");
  }

  return { versionId, previewUrl, output };
}

export function buildWranglerVersionUploadArgs(
  options: Pick<DeployOptions, "preview" | "env" | "name"> & { previewAlias?: string },
): WranglerVersionArgs {
  const args = ["versions", "upload"];
  const env = options.env || (options.preview ? "preview" : undefined);
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
  options: Pick<DeployOptions, "preview" | "env" | "name">,
): WranglerVersionArgs {
  const args = [
    "versions",
    "deploy",
    ...versionTraffic.map(({ versionId, percentage }) => `${versionId}@${percentage}%`),
    "--yes",
  ];
  const env = options.env || (options.preview ? "preview" : undefined);
  if (options.name) {
    args.push("--name", options.name);
  }
  if (env) {
    args.push("--env", validateWranglerEnvName(env));
  }
  return { args, env };
}

export function buildWranglerDeploymentsStatusArgs(
  options: Pick<DeployOptions, "preview" | "env" | "name">,
): WranglerVersionArgs {
  const args = ["deployments", "status", "--json"];
  const env = options.env || (options.preview ? "preview" : undefined);
  if (options.name) {
    args.push("--name", options.name);
  }
  if (env) {
    args.push("--env", validateWranglerEnvName(env));
  }
  return { args, env };
}

export function buildWranglerTriggersDeployArgs(
  options: Pick<DeployOptions, "preview" | "env" | "name">,
): WranglerVersionArgs {
  const args = ["triggers", "deploy"];
  const env = options.env || (options.preview ? "preview" : undefined);
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
  options: Pick<DeployOptions, "preview" | "env" | "name"> & { previewAlias?: string },
  execute: typeof execFileSync = execFileSync,
): WranglerVersionUploadResult {
  const { args, env } = buildWranglerVersionUploadArgs(options);
  if (env) {
    console.log(`\n  Uploading Worker version for env: ${env}...`);
  } else {
    console.log("\n  Uploading Worker version for production...");
  }
  return parseWranglerVersionUploadOutput(runWranglerCommand(root, args, execute));
}

export function runWranglerVersionDeploy(
  root: string,
  versionTraffic: readonly WranglerVersionTraffic[],
  options: Pick<DeployOptions, "preview" | "env" | "name">,
  execute: typeof execFileSync = execFileSync,
): WranglerVersionDeployResult {
  const { args, env } = buildWranglerVersionDeployArgs(versionTraffic, options);
  if (env) {
    console.log(`\n  Deploying warmed Worker version to env: ${env}...`);
  } else {
    console.log("\n  Deploying warmed Worker version to production...");
  }
  const output = runWranglerCommand(root, args, execute);
  return { deployedUrl: parseWorkersDevUrl(output), output };
}

export function runWranglerDeploymentStatus(
  root: string,
  options: Pick<DeployOptions, "preview" | "env" | "name">,
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
  options: Pick<DeployOptions, "preview" | "env" | "name">,
  execute: typeof execFileSync = execFileSync,
): void {
  const { args, env } = buildWranglerTriggersDeployArgs(options);
  if (env) {
    console.log(`\n  Applying Worker triggers for env: ${env}...`);
  } else {
    console.log("\n  Applying Worker triggers...");
  }
  runWranglerCommand(root, args, execute);
}
