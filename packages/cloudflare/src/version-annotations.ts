import { execFileSync } from "node:child_process";

export type VersionAnnotations = {
  message?: string;
  tag?: string;
};

type GitRunner = (args: string[], cwd: string) => string;

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function readGit(git: GitRunner, args: string[], cwd: string): string | undefined {
  try {
    return git(args, cwd).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the message and tag recorded on uploaded Worker versions.
 *
 * Like `cf previews deploy`, CI deploys default the tag to the short HEAD commit
 * SHA and the message to its commit message. An explicit empty value omits that
 * annotation.
 */
export function resolveVersionAnnotations(
  root: string,
  options: VersionAnnotations,
  env: Readonly<Record<string, string | undefined>> = process.env,
  git: GitRunner = runGit,
): VersionAnnotations {
  const isCI = env.CI === "1" || env.CI === "true";
  const tag =
    options.tag ?? (isCI ? readGit(git, ["rev-parse", "--short", "HEAD"], root) : undefined);
  const message =
    options.message ?? (isCI ? readGit(git, ["log", "-1", "--format=%B"], root) : undefined);
  return { message: message || undefined, tag: tag || undefined };
}

/** The `=` form keeps values that start with `-` from being parsed as flags. */
export function buildVersionAnnotationArgs({ message, tag }: VersionAnnotations): string[] {
  return [...(message ? [`--message=${message}`] : []), ...(tag ? [`--tag=${tag}`] : [])];
}
