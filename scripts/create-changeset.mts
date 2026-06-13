#!/usr/bin/env node
/**
 * Auto-generate Changesets from Conventional Commits. The only bespoke
 * "changeset authoring" surface in the release flow. Runs in CI before
 * `changesets/action` (see .github/workflows/release.yml) and writes
 * `.changeset/auto-*.md` into the working tree only — never committed to `main`;
 * the action consumes them into the Version PR and they are discarded.
 *
 * Runs directly on Node >=24 via native type stripping: `node scripts/create-changeset.mts`.
 *
 * THE CORRECTNESS RULE: to accumulate across pushes without persisting changesets
 * on `main`, we regenerate the full unreleased set every run, from each package's
 * last release tag to HEAD. That would collide with the publish trigger right
 * after a Version PR merges, so decideGeneration() skips a package whose
 * package.json version is already ahead of its latest tag (release merged,
 * awaiting publish) — leaving the working tree empty so the action publishes
 * instead of re-opening a PR. Recomputing from the tag each run is idempotent.
 *
 * Type → bump: feat→minor; fix/perf/revert→patch; everything else→skip;
 * any `<type>!` or `BREAKING CHANGE:` footer→major (overrides the table).
 *
 * Retroactive overrides: committing a changeset named after a commit SHA
 * (`.changeset/<sha>.md`) reclassifies that commit to the bump in its
 * frontmatter (e.g. treat a mislabeled `feat:` as a `fix:`). See CommitOverride
 * / loadOverrides below.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Bump = "major" | "minor" | "patch";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

/** Conventional-Commit type → semver bump. `null` means "no release". */
export const TYPE_BUMP: Record<string, Bump | null> = {
  feat: "minor",
  fix: "patch",
  perf: "patch",
  revert: "patch",
  refactor: null,
  docs: null,
  test: null,
  ci: null,
  build: null,
  chore: null,
  style: null,
};

const BUMP_ORDER: Bump[] = ["major", "minor", "patch"];

export type ConventionalParts = {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
};

/** Split a Conventional-Commit subject into its parts, or null if non-conforming. */
export function conventionalParts(subject: string): ConventionalParts | null {
  if (typeof subject !== "string") return null;
  const m = subject.match(/^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s+(.*)$/);
  if (!m) return null;
  return {
    type: m[1].toLowerCase(),
    scope: m[2] || null,
    breaking: m[3] === "!",
    description: m[4].trim(),
  };
}

/** Parse a Conventional-Commit subject (+ body, scanned for BREAKING CHANGE). */
export function parseBumpFromSubject(subject: string, body = ""): Bump | null {
  const parts = conventionalParts(subject);
  if (!parts) return null;
  if (parts.breaking || /(^|\n)\s*BREAKING[ -]CHANGE[:!]/.test(body)) return "major";
  if (!(parts.type in TYPE_BUMP)) return null;
  return TYPE_BUMP[parts.type];
}

/** Higher-precedence of two bumps (major > minor > patch); null = no bump. */
export function maxBump(a: Bump | null, b: Bump | null): Bump | null {
  if (!a) return b ?? null;
  if (!b) return a ?? null;
  return BUMP_ORDER.indexOf(a) <= BUMP_ORDER.indexOf(b) ? a : b;
}

/** Affected publishable package names for the given changed paths, sorted. */
export function affectedPackages(
  changedPaths: string[],
  packageDirToName: Record<string, string>,
): string[] {
  const affected = new Set<string>();
  // Longest dir first so nested packages match before their ancestors.
  const dirs = Object.keys(packageDirToName).sort((a, b) => b.length - a.length);
  for (const path of changedPaths) {
    const norm = path.replace(/\\/g, "/");
    for (const dir of dirs) {
      if (norm.startsWith(`${dir}/`)) {
        affected.add(packageDirToName[dir]);
        break;
      }
    }
  }
  return [...affected].sort();
}

/** Compare semver-ish strings (major.minor.patch, ignores prerelease). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) => v.split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(String(a));
  const pb = parse(String(b));
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Decide whether to (re)generate changesets for a package this run.
 *
 * Auto-changesets are never committed to `main`, so each run regenerates the
 * whole unreleased set from the last tag (that's why the bump itself isn't the
 * deciding factor here — that's done per-commit by parseBumpFromSubject). The
 * one case to suppress: right after a Version PR merges, `package.json` is
 * bumped but `changeset publish` hasn't created the tag yet. Regenerating then
 * would re-pick-up the just-released commits and re-open a Version PR instead of
 * letting the publish run — so skip while the version is ahead of its tag.
 */
export function decideGeneration(
  pkgVersion: string,
  tagVersion: string | null,
): { action: "skip" | "generate"; reason: string } {
  if (tagVersion == null) return { action: "generate", reason: "no release tag yet" };
  if (compareVersions(pkgVersion, tagVersion) > 0) {
    return {
      action: "skip",
      reason: `package.json (${pkgVersion}) > tag (${tagVersion}); release merged, awaiting publish`,
    };
  }
  return {
    action: "generate",
    reason: `package.json (${pkgVersion}) == tag (${tagVersion}); accumulating unreleased commits`,
  };
}

/** Build the combined changeset file (frontmatter + bullet body). Pure. */
export function renderChangeset(pkgBumps: Record<string, Bump>, summaryLines: string[]): string {
  const front = Object.keys(pkgBumps)
    .sort()
    .map((name) => `"${name}": ${pkgBumps[name]}`)
    .join("\n");
  const body = summaryLines.length
    ? summaryLines.map((l) => `- ${l}`).join("\n")
    : "Automated changeset.";
  return `---\n${front}\n---\n\n${body}\n`;
}

// ───────────────────────────── git / fs glue ─────────────────────────────

function git(args: string[], cwd: string = REPO_ROOT): string {
  // Pipe stderr so expected probe failures (e.g. a missing tag) don't leak
  // `fatal:` noise into CI logs; callers that care handle the thrown error.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

type PackageJson = { name?: string; version?: string; private?: boolean };

/** Publishable packages — non-private entries under `packages/*`: dir → name. */
export function discoverPublishablePackages(root: string = REPO_ROOT): Record<string, string> {
  const map: Record<string, string> = {};
  const base = join(root, "packages");
  if (!existsSync(base)) return map;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = join(base, entry.name, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as PackageJson;
    } catch {
      continue;
    }
    if (pkg.private !== true && pkg.name && pkg.version) map[`packages/${entry.name}`] = pkg.name;
  }
  return map;
}

/**
 * Pick the highest release-tag version for a package out of a tag list. Accepts
 * both the legacy global `v<version>` and changesets' `<name>@<version>` scheme;
 * returns null when no tag matches — e.g. a brand-new, never-released package.
 * Pure (no git), so the tag-selection / no-tag behaviour is unit-testable.
 */
export function latestTagVersionFromTags(tags: string[], pkgName: string): string | null {
  const scopedPrefix = `${pkgName}@`;
  const versions = tags
    .map((tag) =>
      tag.startsWith(scopedPrefix)
        ? tag.slice(scopedPrefix.length)
        : /^v\d+\.\d+\.\d+/.test(tag)
          ? tag.slice(1)
          : null,
    )
    .filter((v): v is string => v != null)
    .sort(compareVersions);
  return versions.at(-1) ?? null;
}

/**
 * Latest release tag version for a package, read from `git tag -l`. Returns null
 * when git fails or the package has no matching tag.
 */
function latestTagVersion(pkgName: string): string | null {
  let tags: string[] = [];
  try {
    tags = git(["tag", "-l"]).split("\n").filter(Boolean);
  } catch {
    return null;
  }
  return latestTagVersionFromTags(tags, pkgName);
}

/** Git ref to diff from: prefer the scoped tag, else the global `v<version>`. */
export function tagRefFor(pkgName: string, tagVersion: string): string {
  const scoped = `${pkgName}@${tagVersion}`;
  try {
    git(["rev-parse", "--verify", `${scoped}^{commit}`]);
    return scoped;
  } catch {
    return `v${tagVersion}`;
  }
}

export type Commit = { sha: string; subject: string; body: string; files: string[] };

/** Commits in `from..HEAD` with their changed files. */
export function commitsInRange(from: string): Commit[] {
  const FIELD = "␞";
  const REC = "␟";
  let raw = "";
  try {
    raw = git(["log", `${from}..HEAD`, "--no-merges", `--format=${REC}%H${FIELD}%s${FIELD}%b`]);
  } catch {
    return [];
  }
  return raw
    .split(REC)
    .filter((r) => r.trim().length > 0)
    .map((rec) => {
      const [sha, subject, body = ""] = rec.split(FIELD);
      let files: string[] = [];
      try {
        files = git(["show", "--name-only", "--format=", sha.trim()])
          .split("\n")
          .map((f) => f.trim())
          .filter(Boolean);
      } catch {
        /* ignore */
      }
      return { sha: sha.trim(), subject: (subject || "").trim(), body: body || "", files };
    });
}

function firstCommit(): string {
  try {
    return git(["rev-list", "--max-parents=0", "HEAD"]).split("\n")[0].trim();
  } catch {
    return "HEAD~50";
  }
}

// ───────────────────────── per-commit overrides ─────────────────────────────

/**
 * A retroactive reclassification of an already-merged commit. Auto-changesets
 * are regenerated from commit subjects on every push and never committed to
 * `main`, so you can't hand-edit them to fix a mislabeled commit. Instead, you
 * commit a changeset file *named after the commit SHA* — e.g.
 * `.changeset/<sha>.md` — and the release tooling treats that commit as the bump
 * declared in the changeset's frontmatter instead of the bump implied by its
 * subject. This demotes a PR that merged as `feat:` (minor) to a `fix:` (patch,
 * listed under Bug Fixes) just by committing `<sha>.md` with `"<pkg>": patch`.
 *
 * The SHA-named file is itself a real changeset: `changesets/action` consumes it
 * for the bump and deletes it on release, so overrides never accumulate. Its
 * frontmatter bump maps to the conventional type used for both bump derivation
 * and changelog grouping (see bumpToOverride). A SHA-named changeset with no
 * package bump *suppresses* the commit (treated as `chore` → no release, dropped
 * from the changelog).
 *
 * The changeset body *also overrides the commit's changelog message*: when the
 * body is non-empty it becomes the entry text for that commit (rendered as a
 * plain bullet, replacing the commit subject's description). An empty body keeps
 * the original subject description and just reclassifies the type.
 */
export type CommitOverride = {
  /** Full SHA or an unambiguous prefix (>= MIN_OVERRIDE_SHA_LEN chars) to reclassify. */
  commit: string;
  /** Conventional type to treat the commit as (e.g. "fix", "feat", "chore"). */
  type: string;
  /** Treat the commit as a breaking change (major bump). Defaults to false. */
  breaking?: boolean;
  /** Changelog entry text from the changeset body; overrides the commit subject. */
  message?: string;
};

/** Shortest SHA prefix accepted as a changeset override filename (git's default). */
export const MIN_OVERRIDE_SHA_LEN = 7;

const CHANGESET_DIR = join(REPO_ROOT, ".changeset");

/**
 * The commit SHA encoded by a changeset filename, or null if it isn't one. A
 * SHA-named changeset (7–40 hex chars + `.md`) is an override; the random
 * `adjective-noun-verb.md` names from `changeset add`, `README.md`, and the
 * generated `auto-*.md` are not. Pure.
 */
export function shaFromChangesetFilename(filename: string): string | null {
  const m = filename.match(/^([0-9a-f]{7,40})\.md$/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Highest semver bump declared in a changeset's frontmatter, or null when it
 * declares none (an empty/package-less changeset → suppression). Only the
 * frontmatter block is scanned, never the body. Pure.
 */
export function changesetFrontmatterBump(md: string): Bump | null {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  let bump: Bump | null = null;
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/:\s*["']?(major|minor|patch)["']?\s*$/i);
    if (m) bump = maxBump(bump, m[1].toLowerCase() as Bump);
  }
  return bump;
}

/**
 * The changeset body (everything after the frontmatter), collapsed to a single
 * line for use as a changelog bullet, or null when the body is empty. Pure.
 */
export function changesetBodyMessage(md: string): string | null {
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const text = m[1].replace(/\s+/g, " ").trim();
  return text || null;
}

/**
 * Map an override changeset's frontmatter bump to the conventional type used for
 * both bump derivation and changelog grouping: patch → fix (Bug Fixes), minor →
 * feat (Features), major → feat + breaking. Pure.
 */
export function bumpToOverride(bump: Bump): { type: string; breaking: boolean } {
  if (bump === "major") return { type: "feat", breaking: true };
  if (bump === "minor") return { type: "feat", breaking: false };
  return { type: "fix", breaking: false };
}

/** The override matching a commit SHA (exact or prefix), or null. Pure. */
export function findOverride(sha: string, overrides: CommitOverride[]): CommitOverride | null {
  const full = sha.trim().toLowerCase();
  for (const o of overrides) {
    if (full === o.commit || full.startsWith(o.commit)) return o;
  }
  return null;
}

/**
 * Rewrite a Conventional-Commit subject so its type token becomes `type` (with a
 * `!` breaking marker when asked). With no `message`, the scope, description, and
 * any trailing ` (#123)` PR ref are preserved (a non-conventional subject is
 * prefixed as-is). With a `message`, it replaces the description and the scope is
 * dropped, so the changelog renders a plain `- <message>` bullet the author fully
 * controls. Pure.
 */
export function rewriteSubjectType(
  subject: string,
  type: string,
  breaking: boolean,
  message?: string,
): string {
  const bang = breaking ? "!" : "";
  if (message != null && message !== "") return `${type}${bang}: ${message}`;
  const parts = conventionalParts(subject);
  if (!parts) return `${type}${bang}: ${subject.trim()}`;
  const scope = parts.scope ? `(${parts.scope})` : "";
  return `${type}${scope}${bang}: ${parts.description}`;
}

/**
 * Apply per-commit overrides to a commit list. For each matched commit the
 * subject is rewritten to its overridden type (and message, when the changeset
 * body provided one) and the body is cleared, so every downstream consumer (bump
 * computation, changeset summary, and the changelog grouping in version.mts) sees
 * one authoritative reclassification — including dropping any stale
 * `BREAKING CHANGE:` footer that would otherwise re-escalate the bump. Unmatched
 * commits pass through untouched. Pure.
 */
export function applyOverrides(commits: Commit[], overrides: CommitOverride[]): Commit[] {
  if (overrides.length === 0) return commits;
  return commits.map((c) => {
    const o = findOverride(c.sha, overrides);
    if (!o) return c;
    return {
      ...c,
      subject: rewriteSubjectType(c.subject, o.type, o.breaking === true, o.message),
      body: "",
    };
  });
}

/**
 * Discover per-commit overrides from SHA-named changeset files in `.changeset/`.
 * Each `<sha>.md` reclassifies commit `<sha>` to the conventional type implied by
 * its frontmatter bump; a package-less one suppresses the commit (`chore`).
 * Returns [] when the directory is absent. CI glue.
 */
export function loadOverrides(dir: string = CHANGESET_DIR): CommitOverride[] {
  if (!existsSync(dir)) return [];
  const overrides: CommitOverride[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const commit = shaFromChangesetFilename(entry.name);
    if (!commit) continue;
    const md = readFileSync(join(dir, entry.name), "utf8");
    const bump = changesetFrontmatterBump(md);
    const { type, breaking } = bump ? bumpToOverride(bump) : { type: "chore", breaking: false }; // package-less changeset → suppress
    const message = changesetBodyMessage(md);
    overrides.push({
      commit,
      type,
      ...(breaking ? { breaking: true } : {}),
      ...(message ? { message } : {}),
    });
  }
  return overrides;
}

/**
 * Release-worthy commits in `from..HEAD` that belong to `name`: conventional,
 * non-release, touching the package's files. Shared by the changeset generator
 * (for the bump) and the changelog grouper in version.mts.
 */
export function collectReleaseCommits(
  from: string,
  name: string,
  packageDirToName: Record<string, string>,
  // Pass overrides loaded once by the caller. Defaulting to [] (not loadOverrides())
  // keeps this FS-free and avoids a re-scan in version.mts after `changeset
  // version` has already deleted the SHA-named override files.
  overrides: CommitOverride[] = [],
): Commit[] {
  // SHA-named changeset overrides (.changeset/<sha>.md) reclassify a commit's
  // type before bump/changelog derivation — e.g. demote a mislabeled `feat:` to
  // a `fix:`. Non-bumping commits (chore/docs/…, incl. the "chore: version
  // packages" release commit) are excluded by parseBumpFromSubject → null.
  return applyOverrides(commitsInRange(from), overrides).filter(
    (c) =>
      parseBumpFromSubject(c.subject, c.body) != null &&
      affectedPackages(c.files, packageDirToName).includes(name),
  );
}

/** Resolve a package's diff range start (last release tag, or first commit). */
export function releaseRangeStart(name: string): string {
  const tagVersion = latestTagVersion(name);
  return tagVersion ? tagRefFor(name, tagVersion) : firstCommit();
}

/** Compute and write the auto changeset. Returns a summary; never throws on no-op. */
export function run(): { written: string | null; bumps: Record<string, Bump> } {
  const packageDirToName = discoverPublishablePackages();
  const overrides = loadOverrides();
  if (overrides.length > 0) {
    console.log(
      `[create-changeset] Applying ${overrides.length} SHA-named changeset override(s): ${overrides
        .map((o) => `${o.commit.slice(0, 7)}→${o.breaking ? `${o.type}!` : o.type}`)
        .join(", ")}`,
    );
  }

  // Per-package: decide generate-vs-skip and the diff range.
  const ranges = new Map<string, string>(); // name → `from` ref
  for (const [dir, name] of Object.entries(packageDirToName)) {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8"),
    ) as PackageJson;
    const decision = decideGeneration(pkg.version ?? "0.0.0", latestTagVersion(name));
    console.log(`[create-changeset] ${name}: ${decision.action} — ${decision.reason}`);
    if (decision.action === "generate") ranges.set(name, releaseRangeStart(name));
  }
  if (ranges.size === 0) {
    console.log("[create-changeset] Nothing to generate (guard active for all packages).");
    return { written: null, bumps: {} };
  }

  // A commit only counts toward the package whose files it touches.
  const pkgBumps: Record<string, Bump> = {};
  const summaryLines: string[] = [];
  const seen = new Set<string>();
  let rangeLo = "";
  for (const [name, from] of ranges) {
    if (!rangeLo) rangeLo = from;
    for (const commit of collectReleaseCommits(from, name, packageDirToName, overrides)) {
      const bump = parseBumpFromSubject(commit.subject, commit.body);
      const merged = maxBump(pkgBumps[name] ?? null, bump);
      if (merged) pkgBumps[name] = merged;
      if (!seen.has(commit.sha)) {
        seen.add(commit.sha);
        summaryLines.push(commit.subject);
      }
    }
  }
  if (Object.keys(pkgBumps).length === 0) {
    console.log("[create-changeset] No release-worthy commits in range.");
    return { written: null, bumps: {} };
  }

  let hiSha = "head";
  try {
    hiSha = git(["rev-parse", "HEAD"]).slice(0, 7);
  } catch {
    /* keep fallback */
  }
  const loSha = rangeLo.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = join(REPO_ROOT, ".changeset", `auto-${loSha}-${hiSha}.md`);
  const contents = renderChangeset(pkgBumps, summaryLines);
  writeFileSync(filePath, contents, "utf8");
  console.log(`[create-changeset] Wrote ${relative(REPO_ROOT, filePath)}:\n${contents}`);
  return { written: filePath, bumps: pkgBumps };
}

if (import.meta.url === `file://${process.argv[1]}`) run();
