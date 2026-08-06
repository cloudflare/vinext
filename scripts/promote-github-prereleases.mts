#!/usr/bin/env node
/** Make newly published beta GitHub Releases normal releases and promote vinext. */

import { execFileSync } from "node:child_process";

export type PublishedPackage = { name: string; version: string };

export function releaseTag({ name, version }: PublishedPackage): string {
  return `${name}@${version}`;
}

export function releasePatchArgs(repository: string, releaseId: number, latest: boolean): string[] {
  const args = [
    "api",
    "--method",
    "PATCH",
    `repos/${repository}/releases/${releaseId}`,
    "-F",
    "prerelease=false",
  ];
  if (latest) args.push("-f", "make_latest=true");
  return args;
}

export function prereleasePackages(value: string): PublishedPackage[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("Published packages must be a JSON array");

  return parsed.filter((item): item is PublishedPackage => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<PublishedPackage>;
    return (
      typeof candidate.name === "string" &&
      typeof candidate.version === "string" &&
      candidate.version.includes("-")
    );
  });
}

export function main(): void {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");

  const packages = prereleasePackages(process.env.PUBLISHED_PACKAGES || "[]");
  for (const pkg of packages) {
    const tag = releaseTag(pkg);
    const releaseId = Number.parseInt(
      execFileSync("gh", ["api", `repos/${repository}/releases/tags/${tag}`, "--jq", ".id"], {
        encoding: "utf8",
      }).trim(),
      10,
    );
    if (!Number.isSafeInteger(releaseId)) throw new Error(`Invalid release id for ${tag}`);

    execFileSync("gh", releasePatchArgs(repository, releaseId, pkg.name === "vinext"), {
      stdio: "inherit",
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
