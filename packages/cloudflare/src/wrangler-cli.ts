/**
 * Bottom-layer Wrangler CLI helpers and the target-selection options type.
 *
 * Shared by the deploy command and the modules it orchestrates
 * (version-deploy.ts, cdn-warm-deployment.ts, wrangler-deployment-target.ts).
 * Lives below all of them so the dependency direction stays
 * deploy.ts → transaction/adapters → this module, with no imports pointing
 * back into the CLI entrypoint.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { findInNodeModules } from "vinext/internal/utils/project";

/** The subset of deploy options that selects which Wrangler target a command addresses. */
export type WranglerTargetOptions = {
  /** Deploy to preview environment (default: production) */
  preview?: boolean;
  /** Wrangler environment name from wrangler.jsonc env.<name> */
  env?: string;
  /** Custom project name for the Worker */
  name?: string;
  /** Wrangler config path, relative to root unless absolute */
  config?: string;
};

export function validateWranglerEnvName(env: string): string {
  if (env.includes("\0")) {
    throw new Error("Wrangler environment names cannot contain null bytes.");
  }
  return env;
}

/**
 * Resolve Wrangler's JavaScript CLI entrypoint in node_modules.
 *
 * Invoking the JavaScript file through `process.execPath` avoids the `.cmd`
 * shim and command shell that package managers create on Windows.
 */
export function resolveWranglerBin(
  root: string,
  resolvePackageJson: (root: string) => string | null = (projectRoot) => {
    try {
      return createRequire(path.join(projectRoot, "package.json")).resolve("wrangler/package.json");
    } catch {
      return findInNodeModules(projectRoot, "wrangler/package.json");
    }
  },
): string {
  const packageJsonPath = resolvePackageJson(root);
  if (packageJsonPath) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
      bin?: string | Record<string, string>;
    };
    const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.wrangler;
    if (bin) return path.resolve(path.dirname(packageJsonPath), bin);
  }

  return path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
}

export function buildNodeCliInvocation(
  scriptPath: string,
  args: string[],
  nodeExecutable: string = process.execPath,
): { file: string; args: string[] } {
  return { file: nodeExecutable, args: [scriptPath, ...args] };
}
