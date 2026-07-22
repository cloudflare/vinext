#!/usr/bin/env node
/**
 * `changeset version` + a grouped, conventional-commits changelog with a bottom
 * `## Contributors` list. Used as the `version:` command for `changesets/action`
 * (see .github/workflows/release.yml).
 *
 * Changesets' default changelog groups by bump level (Minor/Patch Changes), not
 * by commit type, and has no end-of-release contributor hook. So after running
 * `changeset version` we rewrite each bumped package's newest CHANGELOG section:
 * the release commits are regrouped into `### Features` / `### Bug Fixes` / etc.
 * and a deduped, bot-filtered `## Contributors` list is appended. The pure
 * builders (groupedChangelogBody, rewriteReleaseSection, dedupeSortLogins) are
 * unit-tested; the git/gh glue is CI-only.
 *
 * Runs on Node >=24 via native type stripping: `node scripts/version.mts`.
 * Env: GITHUB_TOKEN (for `gh api`), GITHUB_REPOSITORY ("owner/repo").
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Commit,
  type ConventionalParts,
  collectReleaseCommits,
  conventionalParts,
  discoverPublishablePackages,
  loadOverrides,
  releaseRangeStart,
} from "./create-changeset.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

/** Conventional-commit type → changelog section heading (### level), in order. */
const GROUPS: { type: string; heading: string }[] = [
  { type: "feat", heading: "Features" },
  { type: "fix", heading: "Bug Fixes" },
  { type: "perf", heading: "Performance" },
  { type: "revert", heading: "Reverts" },
];

/** An area (commit scope) needs at least this many items for its own sub-group. */
const AREA_MIN = 3;

/** Special-cased area names that shouldn't be naively title-cased. */
const AREA_ACRONYMS: Record<string, string> = {
  i18n: "i18n",
  css: "CSS",
  ppr: "PPR",
  rsc: "RSC",
  cdn: "CDN",
  ssr: "SSR",
  api: "API",
  og: "OG",
  url: "URL",
  html: "HTML",
  cli: "CLI",
};

/** Turn a commit scope like `app-router` into a human-readable area ("App Router"). */
export function humanizeArea(scope: string): string {
  return scope
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((w) => AREA_ACRONYMS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

const itemLine = (p: ConventionalParts): string =>
  p.scope ? `- **${humanizeArea(p.scope)}:** ${p.description}` : `- ${p.description}`;

/**
 * Within a type section, give every area with 3+ items its own `#### <Area>`
 * sub-group (items listed without the now-redundant scope prefix); everything
 * else goes under `#### Misc`. If no area qualifies, the list stays flat.
 */
function renderAreaGroups(items: ConventionalParts[]): string {
  const byArea = new Map<string, ConventionalParts[]>();
  for (const it of items) pushTo(byArea, it.scope ?? "", it);

  const big = [...byArea.entries()]
    .filter(([scope, v]) => scope !== "" && v.length >= AREA_MIN)
    .sort((a, b) => humanizeArea(a[0]).localeCompare(humanizeArea(b[0])));
  if (big.length === 0) return items.map(itemLine).join("\n");

  const bigScopes = new Set(big.map(([scope]) => scope));
  const sub = big.map(
    ([scope, v]) =>
      `#### ${humanizeArea(scope)}\n\n${v.map((p) => `- ${p.description}`).join("\n")}`,
  );
  const other = items.filter((it) => !(it.scope && bigScopes.has(it.scope)));
  if (other.length) sub.push(`#### Misc\n\n${other.map(itemLine).join("\n")}`);
  return sub.join("\n\n");
}

/**
 * Group release commits into `### <Heading>` type sections, each sub-grouped by
 * area. Only the known release types (GROUPS) are rendered; in practice callers
 * pass collectReleaseCommits output, which is already bump-worthy.
 */
export function groupedChangelogBody(commits: Commit[]): string {
  const byType = new Map<string, ConventionalParts[]>();
  for (const c of commits) {
    const parts = conventionalParts(c.subject);
    if (parts) pushTo(byType, parts.type, parts);
  }
  return GROUPS.filter((g) => byType.get(g.type)?.length)
    .map((g) => `### ${g.heading}\n\n${renderAreaGroups(byType.get(g.type) ?? [])}`)
    .join("\n\n");
}

/**
 * Replace the body of the newest `## <version>` section with `body`, then append
 * a `### Contributors` list. Older sections are untouched. Only `## <digit>`
 * counts as a section boundary, so re-running is idempotent. Pure.
 *
 * Contributors is `###` (not `##`) deliberately: changesets' getChangelogEntry
 * extracts the GitHub Release body by slicing from the `## <version>` heading to
 * the next *same-depth* (`##`) heading, so a `## Contributors` would truncate
 * the release notes and drop the list. `###` keeps it inside the release body.
 */
export function rewriteReleaseSection(
  changelog: string,
  body: string,
  contributors: string[],
): string {
  const lines = changelog.split("\n");
  const isVersionHeading = (l: string) => /^##\s+\d/.test(l);
  const start = lines.findIndex(isVersionHeading);
  if (start === -1) return changelog;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isVersionHeading(lines[i])) {
      end = i;
      break;
    }
  }

  const block = [lines[start]]; // the `## <version>` heading
  if (body.trim()) block.push("", body);
  const logins = dedupeSortLogins(contributors);
  if (logins.length) block.push("", "### Contributors", "", ...logins.map((l) => `- @${l}`));
  block.push("");

  const rebuilt = [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
  return `${rebuilt.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "")}\n`;
}

/**
 * Strip a leading `@`, keep only valid GitHub login shapes, dedupe (ci) and
 * sort. The `[a-zA-Z0-9-]` check drops `[bot]` accounts and any non-login
 * fallback (e.g. a git display name with spaces) that would render a broken
 * `@`-mention.
 */
export function dedupeSortLogins(logins: string[]): string[] {
  const byLower = new Map<string, string>();
  for (const raw of logins ?? []) {
    if (typeof raw !== "string") continue;
    const login = raw.trim().replace(/^@+/, "");
    if (!/^[a-zA-Z0-9-]+$/.test(login)) continue;
    if (!byLower.has(login.toLowerCase())) byLower.set(login.toLowerCase(), login);
  }
  return [...byLower.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// ───────────────────────────── CI glue ─────────────────────────────

function readVersions(packageDirToName: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [dir, name] of Object.entries(packageDirToName)) {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8")) as {
      version?: string;
    };
    out[name] = pkg.version ?? "";
  }
  return out;
}

/**
 * Pick the deduped, sorted GitHub logins for exactly `commits`, looking each
 * commit's sha up in a `sha → login` map. Commits with no mapped login (or an
 * empty one) are dropped. Pure — no git/gh. Bots and non-login shapes are
 * filtered by dedupeSortLogins.
 */
export function contributorsForCommits(
  shaToLogin: Map<string, string>,
  commits: Commit[],
): string[] {
  const logins = commits.map((c) => shaToLogin.get(c.sha)).filter((l): l is string => !!l);
  return dedupeSortLogins(logins);
}

/**
 * GitHub contributor logins for exactly `commits` (the same per-package set used
 * to build the changelog body), not the whole `from..HEAD` range. One paginated
 * compare call builds a `sha → login` map; only the package's own commits are
 * then selected. Returns [] on any failure.
 */
function resolveContributors(from: string, repository: string, commits: Commit[]): string[] {
  try {
    const out = execFileSync(
      "gh",
      [
        "api",
        "--paginate",
        `repos/${repository}/compare/${from}...HEAD`,
        // sha/login pairs for the whole range; `// ""` keeps a placeholder for
        // commits whose author is an unlinked email (no valid login).
        "--jq",
        '.commits[] | [.sha, (.author.login // "")] | @tsv',
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const shaToLogin = new Map<string, string>();
    for (const line of out.split("\n")) {
      if (!line) continue;
      const [sha, login = ""] = line.split("\t");
      if (sha && login) shaToLogin.set(sha, login);
    }
    return contributorsForCommits(shaToLogin, commits);
  } catch {
    return [];
  }
}

function main(): void {
  const repository = process.env.GITHUB_REPOSITORY || "";
  const packages = discoverPublishablePackages();
  // Load the same SHA-named changeset overrides the generator uses, so a commit
  // reclassified there (e.g. feat → fix) lands in the matching changelog section.
  // Must happen BEFORE `changeset version` below, which consumes and deletes the
  // `.changeset/<sha>.md` files; the grouping later reads this in-memory copy.
  const overrides = loadOverrides();
  const before = readVersions(packages);

  console.log("[version] Running `changeset version`...");
  // `vp exec` runs the pinned, installed @changesets/cli — not a floating `dlx` fetch.
  execFileSync("vp", ["exec", "changeset", "version"], { cwd: REPO_ROOT, stdio: "inherit" });

  const after = readVersions(packages);

  for (const [dir, name] of Object.entries(packages)) {
    if (!after[name] || after[name] === before[name]) continue; // not bumped
    const changelogPath = join(REPO_ROOT, dir, "CHANGELOG.md");
    if (!existsSync(changelogPath)) {
      console.warn(`[version] ${name}: bumped but no CHANGELOG.md; skipping rewrite.`);
      continue;
    }

    // Resolve the range from the latest *existing* tag (or first commit when the
    // package has never been released), matching the changeset generator. Using
    // before[name] would derive a ref like `v0.0.1` that need not exist — for a
    // brand-new package that throws and yields an empty changelog (see #1759).
    const from = releaseRangeStart(name);
    const commits = collectReleaseCommits(from, name, packages, overrides);
    const body = groupedChangelogBody(commits);
    const contributors = repository ? resolveContributors(from, repository, commits) : [];

    const original = readFileSync(changelogPath, "utf8");
    const updated = rewriteReleaseSection(original, body, contributors);
    if (updated !== original) {
      writeFileSync(changelogPath, updated, "utf8");
      console.log(`[version] ${name}: grouped changelog + ${contributors.length} contributors.`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
