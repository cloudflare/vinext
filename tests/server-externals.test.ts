import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  mergeServerExternalPackages,
  resolveServerExternalPackageImport,
} from "../packages/vinext/src/utils/server-externals.js";

describe("server external package defaults", () => {
  it("externalizes common native addon packages for Node server builds", () => {
    expect(mergeServerExternalPackages(undefined, [])).toEqual([
      "better-sqlite3",
      "sqlite3",
      "typescript",
    ]);
  });

  it("preserves user and Next.js server externals without duplicates", () => {
    expect(
      mergeServerExternalPackages(["sqlite3", "typescript", "payload"], ["payload", "sharp"]),
    ).toEqual(["better-sqlite3", "sqlite3", "typescript", "payload", "sharp"]);
  });

  it("preserves ssr.external true", () => {
    expect(mergeServerExternalPackages(true, ["sqlite3"])).toBe(true);
  });

  it("resolves server externals from the importing package for transitive versions", () => {
    // Ported from Next.js: test/e2e/externals-transitive/externals-transitive.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/externals-transitive/externals-transitive.test.ts
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-server-externals-"));
    try {
      fs.mkdirSync(path.join(root, "node_modules", "lodash"), { recursive: true });
      fs.mkdirSync(path.join(root, "node_modules", "dep-b", "node_modules", "lodash"), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, "package.json"), "{}\n");
      fs.writeFileSync(
        path.join(root, "node_modules", "lodash", "package.json"),
        JSON.stringify({ exports: { ".": { import: "./import.js", require: "./require.js" } } }) +
          "\n",
      );
      fs.writeFileSync(path.join(root, "node_modules", "lodash", "import.js"), "\n");
      fs.writeFileSync(path.join(root, "node_modules", "lodash", "require.js"), "\n");
      fs.writeFileSync(
        path.join(root, "node_modules", "dep-b", "node_modules", "lodash", "package.json"),
        JSON.stringify({ exports: { ".": { import: "./import.js", require: "./require.js" } } }) +
          "\n",
      );
      fs.writeFileSync(
        path.join(root, "node_modules", "dep-b", "node_modules", "lodash", "import.js"),
        "\n",
      );
      fs.writeFileSync(
        path.join(root, "node_modules", "dep-b", "node_modules", "lodash", "require.js"),
        "\n",
      );
      const importer = path.join(root, "node_modules", "dep-b", "index.js");
      fs.writeFileSync(importer, "import lodash from 'lodash';\n");

      expect(resolveServerExternalPackageImport("lodash", importer, ["lodash"], root)).toBe(
        fs.realpathSync(
          path.join(root, "node_modules", "dep-b", "node_modules", "lodash", "import.js"),
        ),
      );
      expect(
        resolveServerExternalPackageImport("lodash/package.json", importer, ["lodash"], root),
      ).toBeNull();
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
