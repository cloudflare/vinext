import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { publishArgs, withHiddenPrereleaseState } from "./publish.mts";

function prereleaseRepo(): { root: string; preStatePath: string; contents: string } {
  const root = mkdtempSync(join(tmpdir(), "vinext-publish-"));
  const changesetDir = join(root, ".changeset");
  const preStatePath = join(changesetDir, "pre.json");
  const contents = '{\n  "mode": "pre",\n  "tag": "beta"\n}\n';
  mkdirSync(changesetDir);
  writeFileSync(preStatePath, contents);
  return { root, preStatePath, contents };
}

describe("withHiddenPrereleaseState", () => {
  it("hides pre.json while publishing and restores it afterward", () => {
    const { root, preStatePath, contents } = prereleaseRepo();

    const result = withHiddenPrereleaseState(root, () => {
      expect(() => readFileSync(preStatePath)).toThrow();
      return "published";
    });

    expect(result).toBe("published");
    expect(readFileSync(preStatePath, "utf8")).toBe(contents);
  });

  it("restores pre.json when publishing fails", () => {
    const { root, preStatePath, contents } = prereleaseRepo();

    expect(() =>
      withHiddenPrereleaseState(root, () => {
        throw new Error("publish failed");
      }),
    ).toThrow("publish failed");

    expect(readFileSync(preStatePath, "utf8")).toBe(contents);
  });

  it("publishes normally when prerelease state is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "vinext-publish-"));
    expect(withHiddenPrereleaseState(root, () => "published")).toBe("published");
  });
});

describe("publishArgs", () => {
  it("publishes prereleases under latest", () => {
    expect(publishArgs(true)).toEqual(["exec", "changeset", "publish", "--tag", "latest"]);
  });

  it("leaves stable publishing unchanged", () => {
    expect(publishArgs(false)).toEqual(["exec", "changeset", "publish"]);
  });
});
