import { describe, expect, it } from "vite-plus/test";

import { prereleasePackages, releasePatchArgs, releaseTag } from "./promote-github-prereleases.mts";

describe("prereleasePackages", () => {
  it("selects only newly published prerelease versions", () => {
    expect(
      prereleasePackages(
        JSON.stringify([
          { name: "vinext", version: "1.0.0-beta.1" },
          { name: "@vinext/cloudflare", version: "1.0.0-beta.1" },
          { name: "stable", version: "1.0.0" },
        ]),
      ),
    ).toEqual([
      { name: "vinext", version: "1.0.0-beta.1" },
      { name: "@vinext/cloudflare", version: "1.0.0-beta.1" },
    ]);
  });

  it("rejects a non-array payload", () => {
    expect(() => prereleasePackages("{}")).toThrow("Published packages must be a JSON array");
  });
});

describe("releaseTag", () => {
  it("matches Changesets package tag names", () => {
    expect(releaseTag({ name: "@vinext/cloudflare", version: "1.0.0-beta.1" })).toBe(
      "@vinext/cloudflare@1.0.0-beta.1",
    );
  });
});

describe("releasePatchArgs", () => {
  it("clears prerelease status for every package", () => {
    expect(releasePatchArgs("cloudflare/vinext", 123, false)).toEqual([
      "api",
      "--method",
      "PATCH",
      "repos/cloudflare/vinext/releases/123",
      "-F",
      "prerelease=false",
    ]);
  });

  it("also marks the primary vinext release latest", () => {
    expect(releasePatchArgs("cloudflare/vinext", 123, true)).toEqual([
      "api",
      "--method",
      "PATCH",
      "repos/cloudflare/vinext/releases/123",
      "-F",
      "prerelease=false",
      "-f",
      "make_latest=true",
    ]);
  });
});
