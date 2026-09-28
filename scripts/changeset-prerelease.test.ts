import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vite-plus/test";

import { versionPackages } from "./version.mts";

// Regression for https://github.com/changesets/changesets/issues/2024.
it.each([false, true])(
  "exits prereleases without bumping skipped packages (private versioning: %s)",
  async (versionPrivatePackages) => {
    const root = mkdtempSync(join(tmpdir(), "vinext-changeset-pre-exit-"));
    const packages = [
      { name: "public-beta", version: "1.0.0-beta.2" },
      { name: "public-stable", version: "1.2.3" },
      { name: "private-fixture", private: true },
      { name: "private-stable", private: true, version: "0.2.0" },
      { name: "private-beta", private: true, version: "1.0.0-beta.1" },
      { name: "ignored-beta", version: "1.0.0-beta.1" },
      {
        name: "private-dependent",
        private: true,
        dependencies: { "public-beta": "workspace:^1.0.0-beta.2" },
      },
    ];

    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "test-workspace", private: true, workspaces: ["packages/*"] }),
      );
      mkdirSync(join(root, ".changeset"));
      writeFileSync(
        join(root, ".changeset/config.json"),
        JSON.stringify({
          changelog: "@changesets/cli/changelog",
          ignore: ["ignored-beta"],
          privatePackages: { version: versionPrivatePackages, tag: false },
        }),
      );
      writeFileSync(
        join(root, ".changeset/pre.json"),
        JSON.stringify({ mode: "exit", tag: "beta", initialVersions: {}, changesets: [] }),
      );
      const changesetPath = join(root, ".changeset/public-beta.md");
      writeFileSync(
        changesetPath,
        '---\n"public-beta": patch\n---\n\nRelease the public package.\n',
      );
      for (const pkg of packages) {
        const dir = join(root, "packages", pkg.name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
      }
      const existingChangelog = join(root, "packages/private-stable/CHANGELOG.md");
      writeFileSync(existingChangelog, "# Existing private changelog\n");

      await versionPackages(root);

      for (const pkg of packages) {
        const shouldGraduate =
          pkg.name === "public-beta" || (pkg.name === "private-beta" && versionPrivatePackages);
        const actual = JSON.parse(
          readFileSync(join(root, "packages", pkg.name, "package.json"), "utf8"),
        );
        const expected = shouldGraduate ? { ...pkg, version: "1.0.0" } : { ...pkg };
        if (pkg.name === "private-dependent") {
          expected.dependencies = { "public-beta": "workspace:^1.0.0" };
        }
        expect(actual, pkg.name).toEqual(expected);
        const changelogPath = join(root, "packages", pkg.name, "CHANGELOG.md");
        if (shouldGraduate) {
          expect(readFileSync(changelogPath, "utf8")).toContain("## 1.0.0");
        } else if (pkg.name === "private-stable") {
          expect(readFileSync(changelogPath, "utf8")).toBe("# Existing private changelog\n");
        } else {
          expect(existsSync(changelogPath), pkg.name).toBe(false);
        }
      }
      expect(existsSync(join(root, ".changeset/pre.json"))).toBe(false);
      expect(existsSync(changesetPath)).toBe(false);

      writeFileSync(changesetPath, '---\n"public-beta": patch\n---\n\nNext stable release.\n');
      await versionPackages(root);
      expect(
        JSON.parse(readFileSync(join(root, "packages/public-beta/package.json"), "utf8")).version,
      ).toBe("1.0.1");
      expect(
        JSON.parse(readFileSync(join(root, "packages/private-dependent/package.json"), "utf8")),
      ).toEqual({
        name: "private-dependent",
        private: true,
        dependencies: { "public-beta": "workspace:^1.0.1" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each(["dependencies", "devDependencies"])(
  "validates expanded ignore globs for %s before writing releases",
  async (dependencyType) => {
    const root = mkdtempSync(join(tmpdir(), "vinext-changeset-ignore-"));
    const pkg = {
      name: "public-package",
      version: "1.0.0",
      [dependencyType]: { "ignored-package": "workspace:^1.0.0" },
    };
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "test-workspace", private: true, workspaces: ["packages/*"] }),
      );
      mkdirSync(join(root, ".changeset"));
      writeFileSync(
        join(root, ".changeset/config.json"),
        JSON.stringify({ changelog: false, ignore: ["ignored-*"] }),
      );
      const changesetPath = join(root, ".changeset/public-package.md");
      writeFileSync(changesetPath, '---\n"public-package": patch\n---\n\nPublic package fix.\n');
      for (const manifest of [pkg, { name: "ignored-package", version: "1.0.0" }]) {
        const dir = join(root, "packages", manifest.name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
      }

      const manifestPath = join(root, "packages/public-package/package.json");
      if (dependencyType === "dependencies") {
        await expect(versionPackages(root)).rejects.toThrow(
          '"public-package" depends on the skipped package "ignored-package"',
        );
        expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual(pkg);
        expect(existsSync(changesetPath)).toBe(true);
      } else {
        await versionPackages(root);
        expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual({
          ...pkg,
          version: "1.0.1",
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
