import { execFileSync } from "node:child_process";

export const DEFAULT_VERSION_MESSAGE = "Deployed with vinext";

/** Commit SHA variables set by common CI providers, for checkouts without a `.git` directory. */
const COMMIT_SHA_ENV_VARS = [
  "WORKERS_CI_COMMIT_SHA",
  "GITHUB_SHA",
  "CI_COMMIT_SHA",
  "CIRCLE_SHA1",
  "COMMIT_SHA",
] as const;

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
 * Without explicit values, the tag is the deployed commit SHA and the message is
 * its subject, so the dashboard identifies each version instead of showing
 * "Manually deployed". An explicit empty value omits that annotation.
 */
export function resolveVersionAnnotations(
  root: string,
  options: VersionAnnotations,
  env: Readonly<Record<string, string | undefined>> = process.env,
  git: GitRunner = runGit,
): VersionAnnotations {
  const tag =
    options.tag ??
    readGit(git, ["rev-parse", "HEAD"], root) ??
    COMMIT_SHA_ENV_VARS.map((name) => env[name]?.trim()).find(Boolean);
  const message =
    options.message ?? readGit(git, ["log", "-1", "--format=%s"], root) ?? DEFAULT_VERSION_MESSAGE;
  return { message: message || undefined, tag: tag || undefined };
}

/** The `=` form keeps values that start with `-` from being parsed as flags. */
export function buildVersionAnnotationArgs({ message, tag }: VersionAnnotations): string[] {
  return [...(message ? [`--message=${message}`] : []), ...(tag ? [`--tag=${tag}`] : [])];
}
