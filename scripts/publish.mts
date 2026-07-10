#!/usr/bin/env node
/**
 * Publish versioned packages with Changesets while making prereleases the
 * default npm install.
 *
 * Changesets derives beta version numbers from `.changeset/pre.json`, but in
 * pre mode it forces npm's dist-tag to the prerelease name and rejects
 * `changeset publish --tag latest`. Temporarily hiding the pre-state file lets
 * us preserve the already-versioned `-beta.*` package versions while publishing
 * them under `latest`. The file is restored even when publishing fails.
 */

import { execFileSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

export function withHiddenPrereleaseState<T>(repoRoot: string, publish: () => T): T {
  const preStatePath = join(repoRoot, ".changeset", "pre.json");
  if (!existsSync(preStatePath)) return publish();

  const backupPath = `${preStatePath}.publish-backup`;
  if (existsSync(backupPath)) {
    throw new Error(`Refusing to overwrite existing prerelease backup: ${backupPath}`);
  }

  renameSync(preStatePath, backupPath);
  try {
    return publish();
  } finally {
    renameSync(backupPath, preStatePath);
  }
}

export function publishArgs(prerelease: boolean): string[] {
  const args = ["exec", "changeset", "publish"];
  if (prerelease) args.push("--tag", "latest");
  return args;
}

export function main(): void {
  const preStatePath = join(REPO_ROOT, ".changeset", "pre.json");
  const prerelease = existsSync(preStatePath);

  withHiddenPrereleaseState(REPO_ROOT, () => {
    execFileSync("vp", publishArgs(prerelease), { cwd: REPO_ROOT, stdio: "inherit" });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
