import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toSlash } from "pathslash";
import { describe, expect, it } from "vite-plus/test";
import {
  booleanLiteralValue,
  getAstName,
  SCRIPT_MODULE_ID_RE,
  scriptParserLanguage,
  staticStringValue,
  stringLiteralValue,
  unwrapExpression,
  walkAst,
} from "../packages/vinext/src/plugins/ast-utils.js";
import { isServerEnvironment } from "../packages/vinext/src/plugins/environment.js";
import {
  BARE_PACKAGE_SPECIFIER_RE,
  packageNameFromSpecifier,
} from "../packages/vinext/src/utils/package-name.js";
import {
  canonicalizeFilePath,
  isPathInside,
  isPathInsideOrEqual,
  NODE_MODULES_PATH_RE,
  stripViteModuleQuery,
} from "../packages/vinext/src/utils/path.js";

describe("plugin AST utilities", () => {
  it.each([
    ["/app/page.js", "jsx"],
    ["/app/page.jsx?direct", "jsx"],
    ["/app/page.cjs#fragment", "jsx"],
    ["/app/page.ts", "ts"],
    ["/app/page.mts?direct", "ts"],
    ["/app/page.cts", "ts"],
    ["/app/page.tsx", "tsx"],
    ["/app/page.json", null],
  ] as const)("classifies %s as %s", (id, expected) => {
    expect(scriptParserLanguage(id)).toBe(expected);
    expect(SCRIPT_MODULE_ID_RE.test(id)).toBe(expected !== null);
  });

  it("reads literal values and syntax-only expression wrappers", () => {
    const literal = { type: "Literal", value: "value" };
    const template = {
      type: "TemplateLiteral",
      expressions: [],
      quasis: [{ type: "TemplateElement", value: { cooked: "cooked", raw: "raw" } }],
    };
    const wrapped = { type: "TSAsExpression", expression: literal };

    expect(getAstName({ type: "Identifier", name: "binding" })).toBe("binding");
    expect(stringLiteralValue(literal)).toBe("value");
    expect(staticStringValue(template)).toBe("cooked");
    expect(booleanLiteralValue({ type: "Literal", value: false })).toBe(false);
    expect(unwrapExpression(wrapped)).toBe(literal);
    expect(staticStringValue({ ...template, expressions: [literal] })).toBeNull();
  });

  it("walks children without following parent cycles and supports pruning", () => {
    const prunedChild = { type: "Literal", value: "hidden" };
    const pruned = { type: "CallExpression", arguments: [prunedChild] };
    const visible = { type: "Identifier", name: "visible" };
    const direct = {
      type: "ExpressionStatement",
      expression: { type: "Identifier", name: "direct" },
    };
    const root = { type: "Program", body: [pruned, visible] } as Record<string, unknown>;
    root.parent = root;
    root.direct = direct;

    const visited: string[] = [];
    walkAst(root, (node) => {
      visited.push(node.type);
      return node === pruned ? false : undefined;
    });

    expect(visited).toEqual([
      "Program",
      "CallExpression",
      "Identifier",
      "ExpressionStatement",
      "Identifier",
    ]);
  });
});

describe("plugin module utilities", () => {
  it.each([
    ["react", "react", true],
    ["react/jsx-runtime", "react", true],
    ["@scope/pkg/subpath", "@scope/pkg", true],
    ["node:fs", null, false],
    ["fs/promises", null, true],
    ["virtual:module", null, false],
    ["#internal", null, false],
    ["./local", null, false],
    ["@scope", null, false],
  ] as const)("extracts the package name from %s", (specifier, expected, isBare) => {
    expect(packageNameFromSpecifier(specifier)).toBe(expected);
    expect(BARE_PACKAGE_SPECIFIER_RE.test(specifier)).toBe(isBare);
  });

  it("recognizes node_modules as a complete path segment", () => {
    expect(NODE_MODULES_PATH_RE.test("/app/node_modules/pkg/index.js")).toBe(true);
    expect(NODE_MODULES_PATH_RE.test("node_modules\\pkg\\index.js")).toBe(true);
    expect(NODE_MODULES_PATH_RE.test("/app/my_node_modules/pkg/index.js")).toBe(false);
  });

  it("classifies server-consumed Vite environments", () => {
    expect(isServerEnvironment({ name: "ssr", config: { consumer: "server" } })).toBe(true);
    expect(isServerEnvironment({ name: "rsc", config: {} })).toBe(true);
    expect(isServerEnvironment({ name: "client", config: { consumer: "server" } })).toBe(false);
    expect(isServerEnvironment({ name: "worker", config: { consumer: "client" } })).toBe(false);
  });
});

describe("plugin path utilities", () => {
  it("strips Vite queries and fragments and checks directory boundaries", () => {
    const root = path.join(os.tmpdir(), "vinext-plugin-utils-root");
    const child = path.join(root, "nested", "page.tsx");
    const dotDotNamedChild = path.join(root, "..cache", "page.tsx");
    const sibling = path.join(os.tmpdir(), "vinext-plugin-utils-root-sibling", "page.tsx");

    expect(stripViteModuleQuery(`${child}?direct#fragment`)).toBe(child);
    expect(isPathInside(root, child)).toBe(true);
    expect(isPathInside(root, dotDotNamedChild)).toBe(true);
    expect(isPathInside(root, root)).toBe(false);
    expect(isPathInsideOrEqual(root, root)).toBe(true);
    expect(isPathInsideOrEqual(root, sibling)).toBe(false);
  });

  it("canonicalizes existing files and preserves missing paths", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-plugin-utils-"));
    const file = path.join(directory, "module.ts");
    fs.writeFileSync(file, "export {};");
    try {
      expect(canonicalizeFilePath(file)).toBe(toSlash(fs.realpathSync.native(file)));
      expect(canonicalizeFilePath(path.join(directory, "missing.ts"))).toBe(
        toSlash(path.join(directory, "missing.ts")),
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
