import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  affectedPackages,
  applyOverrides,
  bumpToOverride,
  changesetBodyMessage,
  changesetFrontmatterBump,
  type Commit,
  type CommitOverride,
  compareVersions,
  decideGeneration,
  findOverride,
  latestTagVersionFromTags,
  loadOverrides,
  maxBump,
  parseBumpFromSubject,
  renderChangeset,
  rewriteSubjectType,
  shaFromChangesetFilename,
  TYPE_BUMP,
} from "./create-changeset.mts";

describe("parseBumpFromSubject", () => {
  it("maps feat → minor", () => {
    expect(parseBumpFromSubject("feat: add thing")).toBe("minor");
    expect(parseBumpFromSubject("feat(scope): add thing (#1)")).toBe("minor");
  });

  it("maps fix → patch", () => {
    expect(parseBumpFromSubject("fix: correct thing")).toBe("patch");
    expect(parseBumpFromSubject("fix(link): correct thing (#2)")).toBe("patch");
  });

  it("maps perf → patch", () => {
    expect(parseBumpFromSubject("perf: speed up build")).toBe("patch");
  });

  it("maps revert → patch", () => {
    expect(parseBumpFromSubject("revert: bad change")).toBe("patch");
  });

  it("treats `feat!` and `fix!` as major", () => {
    expect(parseBumpFromSubject("feat!: drop node 18")).toBe("major");
    expect(parseBumpFromSubject("fix(api)!: change signature")).toBe("major");
  });

  it("treats a BREAKING CHANGE footer as major regardless of type", () => {
    expect(parseBumpFromSubject("fix: tweak", "body\n\nBREAKING CHANGE: removes API")).toBe(
      "major",
    );
    expect(parseBumpFromSubject("chore: stuff", "BREAKING CHANGE: x")).toBe("major");
    expect(parseBumpFromSubject("feat: add", "BREAKING-CHANGE: hyphen variant")).toBe("major");
  });

  it("skips non-release types", () => {
    for (const type of ["chore", "docs", "test", "ci", "build", "refactor", "style"]) {
      expect(parseBumpFromSubject(`${type}: something`)).toBeNull();
    }
  });

  it("skips non-conventional subjects", () => {
    expect(parseBumpFromSubject("just a normal commit")).toBeNull();
    expect(parseBumpFromSubject("Merge branch main")).toBeNull();
    expect(parseBumpFromSubject("")).toBeNull();
  });

  it("has a documented, stable type→bump table", () => {
    expect(TYPE_BUMP.feat).toBe("minor");
    expect(TYPE_BUMP.fix).toBe("patch");
    expect(TYPE_BUMP.perf).toBe("patch");
    expect(TYPE_BUMP.chore).toBeNull();
  });
});

describe("maxBump", () => {
  it("returns the higher-precedence bump", () => {
    expect(maxBump("patch", "minor")).toBe("minor");
    expect(maxBump("minor", "major")).toBe("major");
    expect(maxBump("major", "patch")).toBe("major");
    expect(maxBump("patch", "patch")).toBe("patch");
  });

  it("handles null operands", () => {
    expect(maxBump(null, "patch")).toBe("patch");
    expect(maxBump("minor", null)).toBe("minor");
    expect(maxBump(null, null)).toBeNull();
  });
});

describe("affectedPackages", () => {
  const map = {
    "packages/vinext": "vinext",
    "packages/other": "other",
  };

  it("attributes a path to the single owning package", () => {
    expect(affectedPackages(["packages/vinext/src/index.ts"], map)).toEqual(["vinext"]);
  });

  it("attributes paths across multiple packages", () => {
    expect(affectedPackages(["packages/vinext/src/a.ts", "packages/other/src/b.ts"], map)).toEqual([
      "other",
      "vinext",
    ]);
  });

  it("returns nothing for paths outside any publishable package", () => {
    expect(affectedPackages(["tests/foo.test.ts", "README.md"], map)).toEqual([]);
  });

  it("normalizes backslashes", () => {
    expect(affectedPackages(["packages\\vinext\\src\\x.ts"], map)).toEqual(["vinext"]);
  });

  it("matches the most specific (longest) package dir first", () => {
    const nested = {
      "packages/vinext": "vinext",
      "packages/vinext/plugins/sub": "vinext-sub",
    };
    expect(affectedPackages(["packages/vinext/plugins/sub/x.ts"], nested)).toEqual(["vinext-sub"]);
  });
});

describe("compareVersions", () => {
  it("orders semver-ish strings", () => {
    expect(compareVersions("0.0.55", "0.0.5")).toBe(1);
    expect(compareVersions("0.0.5", "0.0.55")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
  });
});

describe("decideGeneration (THE CORRECTNESS RULE)", () => {
  it("skips when package.json version > tag version (release merged, awaiting publish)", () => {
    expect(decideGeneration("0.1.0", "0.0.55").action).toBe("skip");
  });

  it("generates when package.json version == tag version (normal accumulation)", () => {
    expect(decideGeneration("0.0.55", "0.0.55").action).toBe("generate");
  });

  it("generates when there is no tag yet", () => {
    expect(decideGeneration("0.0.1", null).action).toBe("generate");
  });

  it("generates when package.json somehow lags the tag (not a skip case)", () => {
    // Only strictly-greater package version triggers the publish guard.
    expect(decideGeneration("0.0.5", "0.0.55").action).toBe("generate");
  });
});

describe("latestTagVersionFromTags (release range source)", () => {
  const tags = [
    "v0.0.54",
    "v0.0.55",
    "vinext@0.0.55",
    "@vinext/cloudflare@1.0.0",
    "@vinext/cloudflare@1.1.0",
    "some-other-tag",
  ];

  it("picks the highest scoped tag for a package with the `<name>@<version>` scheme", () => {
    expect(latestTagVersionFromTags(tags, "@vinext/cloudflare")).toBe("1.1.0");
  });

  it("falls back to the legacy global `v<version>` tag for the root package", () => {
    // vinext has both schemes here; scoped/global versions agree, highest wins.
    expect(latestTagVersionFromTags(tags, "vinext")).toBe("0.0.55");
  });

  it("falls back to the latest legacy global `v` tag for a never-scoped new package", () => {
    // The #1759 case: a brand-new package (no `<name>@<version>` tag of its own)
    // still resolves a real range from the latest global `v` tag, instead of the
    // non-existent `v<pkg.version>` ref that produced an empty changelog.
    expect(latestTagVersionFromTags(tags, "@vinext/brand-new")).toBe("0.0.55");
  });

  it("returns null when there is no scoped or global tag at all (firstCommit fallback)", () => {
    // No matching tag → null, so releaseRangeStart falls back to firstCommit().
    expect(latestTagVersionFromTags([], "@vinext/cloudflare")).toBeNull();
    expect(latestTagVersionFromTags(["some-other-tag"], "@vinext/cloudflare")).toBeNull();
  });
});

describe("renderChangeset", () => {
  it("renders frontmatter sorted by package and a bullet body", () => {
    const out = renderChangeset({ vinext: "minor", other: "patch" }, [
      "feat: a (#1)",
      "fix: b (#2)",
    ]);
    expect(out).toContain('"other": patch');
    expect(out).toContain('"vinext": minor');
    // other sorts before vinext in frontmatter
    expect(out.indexOf('"other"')).toBeLessThan(out.indexOf('"vinext"'));
    expect(out).toContain("- feat: a (#1)");
    expect(out).toContain("- fix: b (#2)");
    expect(out.startsWith("---\n")).toBe(true);
  });

  it("falls back to a placeholder body when there are no summary lines", () => {
    const out = renderChangeset({ vinext: "patch" }, []);
    expect(out).toContain("Automated changeset.");
  });
});

describe("shaFromChangesetFilename", () => {
  it("recognizes a SHA-named changeset (7–40 hex), lowercasing it", () => {
    expect(shaFromChangesetFilename("6005541.md")).toBe("6005541");
    expect(shaFromChangesetFilename("ABCDEF0123.md")).toBe("abcdef0123");
    expect(shaFromChangesetFilename(`${"a".repeat(40)}.md`)).toBe("a".repeat(40));
  });

  it("ignores normal changesets, generated files, and docs", () => {
    expect(shaFromChangesetFilename("tame-rabbits-sneeze.md")).toBeNull();
    expect(shaFromChangesetFilename("auto-vinext_0.1.0-6005541.md")).toBeNull();
    expect(shaFromChangesetFilename("README.md")).toBeNull();
    expect(shaFromChangesetFilename("config.json")).toBeNull();
  });

  it("rejects hex strings outside the 7–40 length window or with non-hex chars", () => {
    expect(shaFromChangesetFilename("abc12.md")).toBeNull(); // too short
    expect(shaFromChangesetFilename(`${"a".repeat(41)}.md`)).toBeNull(); // too long
    expect(shaFromChangesetFilename("abcdefg.md")).toBeNull(); // 'g' is not hex
  });
});

describe("changesetFrontmatterBump", () => {
  it("reads a single declared bump", () => {
    expect(changesetFrontmatterBump('---\n"vinext": patch\n---\n\nbody')).toBe("patch");
  });

  it("takes the highest bump across multiple packages", () => {
    expect(
      changesetFrontmatterBump('---\n"vinext": patch\n"@vinext/cloudflare": minor\n---\n'),
    ).toBe("minor");
  });

  it("tolerates unquoted names and trailing whitespace", () => {
    expect(changesetFrontmatterBump("---\nvinext: major \n---\n")).toBe("major");
  });

  it("only scans frontmatter, never the body", () => {
    expect(changesetFrontmatterBump('---\n"vinext": patch\n---\n\nbumps to minor someday')).toBe(
      "patch",
    );
  });

  it("returns null for a package-less or frontmatter-less changeset (suppression)", () => {
    expect(changesetFrontmatterBump("---\n---\n\nsuppress this commit")).toBeNull();
    expect(changesetFrontmatterBump("no frontmatter here")).toBeNull();
  });
});

describe("changesetBodyMessage", () => {
  it("returns the body after the frontmatter, collapsed to one line", () => {
    expect(changesetBodyMessage('---\n"vinext": patch\n---\n\nFix the thing (#9).')).toBe(
      "Fix the thing (#9).",
    );
  });

  it("collapses internal whitespace and newlines into single spaces", () => {
    expect(changesetBodyMessage('---\n"vinext": patch\n---\n\nLine one\nLine two\n\n- a   b')).toBe(
      "Line one Line two - a b",
    );
  });

  it("returns null for an empty body or missing frontmatter", () => {
    expect(changesetBodyMessage('---\n"vinext": patch\n---\n')).toBeNull();
    expect(changesetBodyMessage('---\n"vinext": patch\n---\n\n   \n')).toBeNull();
    expect(changesetBodyMessage("no frontmatter here")).toBeNull();
  });
});

describe("bumpToOverride", () => {
  it("maps bump level → conventional type for grouping", () => {
    expect(bumpToOverride("patch")).toEqual({ type: "fix", breaking: false });
    expect(bumpToOverride("minor")).toEqual({ type: "feat", breaking: false });
    expect(bumpToOverride("major")).toEqual({ type: "feat", breaking: true });
  });
});

describe("loadOverrides", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vinext-overrides-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] when the directory is absent", () => {
    expect(loadOverrides(join(dir, "does-not-exist"))).toEqual([]);
  });

  it("derives overrides (type + message) from SHA-named changesets, ignoring everything else", () => {
    writeFileSync(join(dir, "6005541.md"), '---\n"vinext": patch\n---\n\nWas only a fix (#9).');
    writeFileSync(join(dir, "abcdef0123.md"), '---\n"vinext": minor\n---\n'); // no body
    writeFileSync(join(dir, "deadbeef.md"), "---\n---\n\nSuppress this one."); // no bump
    writeFileSync(join(dir, "tame-rabbits-sneeze.md"), '---\n"vinext": major\n---\n'); // normal changeset
    writeFileSync(join(dir, "auto-vinext_0.1.0-6005541.md"), '---\n"vinext": minor\n---\n'); // generated
    writeFileSync(join(dir, "README.md"), "# Changesets");

    const overrides = loadOverrides(dir);
    const byCommit = Object.fromEntries(overrides.map((o) => [o.commit, o]));
    expect(Object.keys(byCommit).sort()).toEqual(["6005541", "abcdef0123", "deadbeef"]);
    // patch → fix, body → message
    expect(byCommit["6005541"]).toEqual({
      commit: "6005541",
      type: "fix",
      message: "Was only a fix (#9).",
    });
    expect(byCommit.abcdef0123).toEqual({ commit: "abcdef0123", type: "feat" }); // minor → feat, no body
    // no bump → suppress (chore). A suppressed commit is dropped from the
    // changelog, so its body message is irrelevant and not captured.
    expect(byCommit.deadbeef).toEqual({ commit: "deadbeef", type: "chore" });
  });
});

describe("findOverride", () => {
  const overrides: CommitOverride[] = [{ commit: "abc1234", type: "fix" }];

  it("matches an exact SHA case-insensitively", () => {
    expect(findOverride("abc1234", overrides)?.type).toBe("fix");
    expect(findOverride("ABC1234", overrides)?.type).toBe("fix");
  });

  it("matches a full SHA by its stored prefix", () => {
    expect(findOverride("abc1234def567890", overrides)?.type).toBe("fix");
  });

  it("returns null when nothing matches", () => {
    expect(findOverride("def5678", overrides)).toBeNull();
    // a SHA shorter than the stored prefix is not a prefix match
    expect(findOverride("abc12", overrides)).toBeNull();
  });
});

describe("rewriteSubjectType", () => {
  it("swaps the type token, preserving scope, description, and PR ref", () => {
    expect(rewriteSubjectType("feat(router): add streaming (#123)", "fix", false)).toBe(
      "fix(router): add streaming (#123)",
    );
  });

  it("drops a scope-less type cleanly", () => {
    expect(rewriteSubjectType("feat: add thing", "fix", false)).toBe("fix: add thing");
  });

  it("adds a breaking marker when asked and drops a stale one when not", () => {
    expect(rewriteSubjectType("feat(api): change", "fix", true)).toBe("fix(api)!: change");
    expect(rewriteSubjectType("feat(api)!: change", "fix", false)).toBe("fix(api): change");
  });

  it("synthesizes a prefix for a non-conventional subject", () => {
    expect(rewriteSubjectType("just a normal message", "fix", false)).toBe(
      "fix: just a normal message",
    );
  });

  it("replaces the description and drops the scope when given a message", () => {
    expect(
      rewriteSubjectType(
        "feat(router): add streaming (#123)",
        "fix",
        false,
        "correct prefetch (#9)",
      ),
    ).toBe("fix: correct prefetch (#9)");
    // message + breaking
    expect(rewriteSubjectType("feat(api): x", "feat", true, "drop the old API (#9)")).toBe(
      "feat!: drop the old API (#9)",
    );
    // an empty message is ignored (falls back to preserving the subject)
    expect(rewriteSubjectType("feat(router): add streaming (#123)", "fix", false, "")).toBe(
      "fix(router): add streaming (#123)",
    );
  });
});

describe("applyOverrides", () => {
  const commit = (sha: string, subject: string, body = ""): Commit => ({
    sha,
    subject,
    body,
    files: ["packages/vinext/src/index.ts"],
  });

  it("returns the same list when there are no overrides", () => {
    const commits = [commit("abc1234", "feat: add thing")];
    expect(applyOverrides(commits, [])).toBe(commits);
  });

  it("rewrites a matched commit's subject and leaves others untouched", () => {
    const commits = [
      commit("abc1234def", "feat(router): add streaming (#123)"),
      commit("999aaaa", "fix(link): correct prefetch (#124)"),
    ];
    const overrides: CommitOverride[] = [{ commit: "abc1234d", type: "fix" }];
    const [first, second] = applyOverrides(commits, overrides);
    expect(first.subject).toBe("fix(router): add streaming (#123)");
    expect(second.subject).toBe("fix(link): correct prefetch (#124)");
  });

  it("demotes a feat to a patch bump (the headline use case)", () => {
    const commits = [commit("abc1234", "feat(router): add streaming (#123)")];
    const overrides: CommitOverride[] = [{ commit: "abc1234", type: "fix" }];
    const [demoted] = applyOverrides(commits, overrides);
    expect(parseBumpFromSubject(demoted.subject, demoted.body)).toBe("patch");
  });

  it("can suppress a commit entirely by reclassifying it as chore", () => {
    const commits = [commit("abc1234", "feat: experimental thing")];
    const overrides: CommitOverride[] = [{ commit: "abc1234", type: "chore" }];
    const [suppressed] = applyOverrides(commits, overrides);
    expect(parseBumpFromSubject(suppressed.subject, suppressed.body)).toBeNull();
  });

  it("clears the body so a stale BREAKING CHANGE footer no longer escalates the bump", () => {
    const commits = [commit("abc1234", "feat: thing", "body\n\nBREAKING CHANGE: removes API")];
    // Without the override this would be a major bump.
    expect(parseBumpFromSubject(commits[0].subject, commits[0].body)).toBe("major");
    const overrides: CommitOverride[] = [{ commit: "abc1234", type: "fix" }];
    const [demoted] = applyOverrides(commits, overrides);
    expect(demoted.body).toBe("");
    expect(parseBumpFromSubject(demoted.subject, demoted.body)).toBe("patch");
  });

  it("honors an explicit breaking override (major)", () => {
    const commits = [commit("abc1234", "fix: small thing")];
    const overrides: CommitOverride[] = [{ commit: "abc1234", type: "feat", breaking: true }];
    const [escalated] = applyOverrides(commits, overrides);
    expect(escalated.subject).toBe("feat!: small thing");
    expect(parseBumpFromSubject(escalated.subject, escalated.body)).toBe("major");
  });

  it("overrides the changelog message from the changeset body, keeping the demoted bump", () => {
    const commits = [commit("abc1234", "feat(interception): sibling-style routes (#1804)")];
    const overrides: CommitOverride[] = [
      { commit: "abc1234", type: "fix", message: "correct interception route matching (#1804)" },
    ];
    const [overridden] = applyOverrides(commits, overrides);
    // message replaces the description and drops the scope → plain bullet
    expect(overridden.subject).toBe("fix: correct interception route matching (#1804)");
    expect(parseBumpFromSubject(overridden.subject, overridden.body)).toBe("patch");
  });
});
