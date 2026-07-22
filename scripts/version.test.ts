import { describe, expect, it } from "vite-plus/test";

import type { Commit } from "./create-changeset.mts";
import {
  contributorsForCommits,
  dedupeSortLogins,
  groupedChangelogBody,
  humanizeArea,
  rewriteReleaseSection,
} from "./version.mts";

const commit = (subject: string): Commit => ({ sha: subject, subject, body: "", files: [] });

const commitSha = (sha: string): Commit => ({ sha, subject: sha, body: "", files: [] });

describe("dedupeSortLogins", () => {
  it("strips @, dedupes case-insensitively, and sorts", () => {
    expect(dedupeSortLogins(["@bob", "Alice", "@alice", "bob", "carol"])).toEqual([
      "Alice",
      "bob",
      "carol",
    ]);
  });

  it("keeps only valid login shapes — drops empties, bots, and git display names", () => {
    expect(
      // @ts-expect-error testing runtime robustness
      dedupeSortLogins(["@x", "", "  ", null, undefined, 5, "dependabot[bot]", "Full Name"]),
    ).toEqual(["x"]);
  });
});

describe("contributorsForCommits", () => {
  it("returns only the authors of the package's own commits", () => {
    const shaToLogin = new Map([
      ["a", "alice"],
      ["b", "bob"],
      ["c", "carol"], // commit outside this package's set
    ]);
    expect(contributorsForCommits(shaToLogin, [commitSha("a"), commitSha("b")])).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("dedupes across multiple commits by the same author and sorts", () => {
    const shaToLogin = new Map([
      ["a", "Bob"],
      ["b", "alice"],
      ["c", "bob"],
    ]);
    expect(
      contributorsForCommits(shaToLogin, [commitSha("a"), commitSha("b"), commitSha("c")]),
    ).toEqual(["alice", "Bob"]);
  });

  it("drops commits with no mapped login or an empty login", () => {
    const shaToLogin = new Map([
      ["a", "alice"],
      ["b", ""], // empty login
      // "c" has no mapping at all
    ]);
    expect(
      contributorsForCommits(shaToLogin, [commitSha("a"), commitSha("b"), commitSha("c")]),
    ).toEqual(["alice"]);
  });
});

describe("humanizeArea", () => {
  it("title-cases hyphenated scopes and respects acronyms", () => {
    expect(humanizeArea("app-router")).toBe("App Router");
    expect(humanizeArea("pages-router")).toBe("Pages Router");
    expect(humanizeArea("cache")).toBe("Cache");
    expect(humanizeArea("i18n")).toBe("i18n");
    expect(humanizeArea("css")).toBe("CSS");
    expect(humanizeArea("ppr")).toBe("PPR");
  });
});

describe("groupedChangelogBody", () => {
  it("groups by type under headings, in order, ignoring non-release types", () => {
    const out = groupedChangelogBody([
      commit("feat(cache): add adapter (#1)"),
      commit("fix(link): correct prefetch (#2)"),
      commit("perf(rsc): faster transport (#3)"),
      commit("chore: noise"),
    ]);
    expect(out.indexOf("### Features")).toBeLessThan(out.indexOf("### Bug Fixes"));
    expect(out.indexOf("### Bug Fixes")).toBeLessThan(out.indexOf("### Performance"));
    expect(out).not.toContain("noise");
  });

  it("stays flat (humanized scope prefix) when no area has >3 items", () => {
    const out = groupedChangelogBody([
      commit("feat(cache): add adapter (#1)"),
      commit("feat: top-level feature (#2)"),
    ]);
    expect(out).not.toContain("####");
    expect(out).toContain("- **Cache:** add adapter (#1)");
    expect(out).toContain("- top-level feature (#2)");
  });

  it("gives areas with 3+ items their own sub-group; the rest go under Misc", () => {
    const out = groupedChangelogBody([
      commit("fix(app-router): a (#1)"),
      commit("fix(app-router): b (#2)"),
      commit("fix(app-router): c (#3)"),
      commit("fix(i18n): sticky locale (#4)"), // 1 item → Misc
      commit("fix(link): two (#5)"),
      commit("fix(link): items (#6)"), // 2 items → Misc
      commit("fix: bare fix (#7)"),
    ]);
    // App Router (3 items) → own sub-group, no per-item scope prefix
    expect(out).toContain("#### App Router");
    expect(out).toContain("- a (#1)");
    expect(out).not.toContain("**App Router:**");
    // areas with <3 items → Misc, humanized bold prefix; bare commit stays plain
    expect(out).toContain("#### Misc");
    expect(out).toContain("- **i18n:** sticky locale (#4)");
    expect(out).toContain("- **Link:** two (#5)");
    expect(out).toContain("- bare fix (#7)");
    expect(out.indexOf("#### App Router")).toBeLessThan(out.indexOf("#### Misc"));
  });
});

describe("rewriteReleaseSection", () => {
  const base = [
    "# vinext",
    "",
    "## 0.1.0",
    "",
    "### Minor Changes",
    "",
    "- - feat: raw changeset dump",
    "",
    "## 0.0.55",
    "",
    "### Patch Changes",
    "",
    "- fix: earlier bug (#1)",
    "",
  ].join("\n");

  const body = "### Features\n\n- **cache:** add adapter (#1733)";

  it("replaces the newest section body and appends Contributors, leaving older sections", () => {
    const out = rewriteReleaseSection(base, body, ["@bob", "@alice"]);
    expect(out).toContain("### Features");
    expect(out).not.toContain("Minor Changes"); // raw dump replaced
    expect(out).toContain("### Contributors");
    expect(out.indexOf("- @alice")).toBeLessThan(out.indexOf("- @bob"));
    // older section untouched
    expect(out).toContain("## 0.0.55");
    expect(out).toContain("- fix: earlier bug (#1)");
  });

  it("is idempotent — only `## <digit>` is a section boundary", () => {
    const once = rewriteReleaseSection(base, body, ["@bob"]);
    const twice = rewriteReleaseSection(once, body, ["@bob", "@carol"]);
    expect(twice.match(/### Contributors/g)?.length).toBe(1);
    expect(twice.match(/## 0\.0\.55/g)?.length).toBe(1);
    expect(twice).toContain("- @carol");
  });

  it("returns input unchanged when there is no version section", () => {
    const noSection = "# vinext\n\nNothing released yet.\n";
    expect(rewriteReleaseSection(noSection, body, ["@bob"])).toBe(noSection);
  });
});
