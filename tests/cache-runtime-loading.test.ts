import fs from "node:fs";
import path from "node:path";
import { parseSync } from "vite";
import type { ESTree } from "vite";
import { describe, expect, it } from "vite-plus/test";

describe("cache runtime loading", () => {
  it("uses cache leaf modules without importing the public cache facade", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "../packages/vinext/src/shims/cache-runtime.ts"),
      "utf8",
    );
    const parsed = parseSync("cache-runtime.ts", source, {
      astType: "ts",
      lang: "ts",
      sourceType: "module",
    });
    const runtimeImports = parsed.program.body
      .filter(
        (statement): statement is ESTree.ImportDeclaration =>
          statement.type === "ImportDeclaration" && statement.importKind !== "type",
      )
      .map((statement) => statement.source.value);

    expect(runtimeImports).toContain("./cache-handler.js");
    expect(runtimeImports).toContain("./cache-request-state.js");
    expect(runtimeImports).not.toContain("./cache.js");
  });
});
