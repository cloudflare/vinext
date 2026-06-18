import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vite-plus/test";

describe("cache runtime loading", () => {
  it("uses cache leaf modules without importing the public cache facade", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "../packages/vinext/src/shims/cache-runtime.ts"),
      "utf8",
    );
    const sourceFile = ts.createSourceFile(
      "cache-runtime.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const runtimeImports = sourceFile.statements
      .filter(
        (statement): statement is ts.ImportDeclaration =>
          ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly,
      )
      .map((statement) =>
        ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "",
      );

    expect(runtimeImports).toContain("./cache-handler.js");
    expect(runtimeImports).toContain("./cache-request-state.js");
    expect(runtimeImports).not.toContain("./cache.js");
  });
});
