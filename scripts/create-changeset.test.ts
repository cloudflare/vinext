import { describe, expect, it } from "vite-plus/test";

import {
  affectedPackages,
  compareVersions,
  decideGeneration,
  latestTagVersionFromTags,
  maxBump,
  parseBumpFromSubject,
  renderChangeset,
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
