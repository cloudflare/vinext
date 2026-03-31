import type { Plugin } from "vite";
import { parseAst } from "vite";
import MagicString from "magic-string";

/**
 * Fix file-level "use server" exports that wrap an inline async action.
 *
 * Libraries like next-safe-action expose server actions as wrapped call
 * expressions:
 *
 *   "use server";
 *   export const action = actionClient.action(async () => { ... });
 *
 * @vitejs/plugin-rsc's client proxy transform validates `export const`
 * declarations syntactically and rejects anything whose initializer is not a
 * direct async arrow/function expression. That makes wrapped server actions
 * fail in vinext even though Next.js accepts them.
 *
 * Fix: before plugin-rsc runs, rewrite only those exports to:
 *
 *   const action = actionClient.action(async () => { ... });
 *   export { action };
 *
 * The upstream proxy transform accepts export specifiers without re-validating
 * the initializer shape, while the server-side transform still registers the
 * correct local binding.
 */
export const fixUseServerWrappedExportsPlugin: Plugin = {
  name: "vinext:fix-use-server-wrapped-exports",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!code.includes("use server")) return null;
    if (!/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(id.split("?")[0])) return null;

    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    let ast: any;
    try {
      ast = parseAst(code);
    } catch {
      return null;
    }

    if (!hasTopLevelUseServerDirective(ast.body)) return null;

    const s = new MagicString(code);
    const topLevelBindings = collectTopLevelBindings(ast.body);
    let changed = false;

    for (const node of ast.body) {
      if (
        node.type === "ExportNamedDeclaration" &&
        node.declaration?.type === "VariableDeclaration" &&
        shouldRewriteNamedDeclaration(node.declaration)
      ) {
        const exportNames = new Set<string>();
        for (const decl of node.declaration.declarations) {
          collectPatternNames(decl.id, exportNames);
        }
        if (exportNames.size === 0) continue;

        s.overwrite(node.start, node.declaration.start, "");
        s.appendLeft(node.end, `\nexport { ${[...exportNames].join(", ")} };`);
        changed = true;
        continue;
      }

      if (node.type === "ExportDefaultDeclaration" && shouldRewriteValue(node.declaration)) {
        const localName = createUniqueName("__vinext_server_default__", topLevelBindings);
        s.overwrite(node.start, node.declaration.start, `const ${localName} = `);
        s.appendLeft(node.end, `\nexport default ${localName};`);
        changed = true;
      }
    }

    if (!changed) return null;
    return {
      code: s.toString(),
      map: s.generateMap({ hires: "boundary" }),
    };
  },
};

function shouldRewriteNamedDeclaration(
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  declaration: any,
): boolean {
  return declaration.declarations.some(
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    (decl: any) => decl.init && shouldRewriteValue(decl.init),
  );
}

function shouldRewriteValue(
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  node: any,
): boolean {
  return !isDirectAsyncFunctionNode(node) && containsInlineAsyncFunction(node);
}

function isDirectAsyncFunctionNode(
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  node: any,
): boolean {
  return (
    (node?.type === "FunctionDeclaration" ||
      node?.type === "FunctionExpression" ||
      node?.type === "ArrowFunctionExpression") &&
    node.async === true
  );
}

function containsInlineAsyncFunction(
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  node: any,
): boolean {
  if (!node || typeof node !== "object") return false;

  if (
    (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") &&
    node.async === true
  ) {
    return true;
  }

  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "parent") {
      continue;
    }
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (containsInlineAsyncFunction(item)) return true;
      }
    } else if (containsInlineAsyncFunction(child)) {
      return true;
    }
  }

  return false;
}

function hasTopLevelUseServerDirective(
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  body: any[],
): boolean {
  for (const stmt of body) {
    if (
      stmt.type === "ExpressionStatement" &&
      stmt.expression?.type === "Literal" &&
      typeof stmt.expression.value === "string"
    ) {
      if (stmt.expression.value === "use server") return true;
      continue;
    }
    break;
  }
  return false;
}

function createUniqueName(base: string, names: Set<string>): string {
  let candidate = base;
  let suffix = 0;
  while (names.has(candidate)) {
    suffix++;
    candidate = `${base}${suffix}`;
  }
  names.add(candidate);
  return candidate;
}

function collectTopLevelBindings(
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  body: any[],
): Set<string> {
  const names = new Set<string>();

  for (const node of body) {
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers ?? []) {
        if (specifier.local?.name) names.add(specifier.local.name);
      }
      continue;
    }

    if (node.type === "FunctionDeclaration" && node.id?.name) {
      names.add(node.id.name);
      continue;
    }

    if (node.type === "ClassDeclaration" && node.id?.name) {
      names.add(node.id.name);
      continue;
    }

    if (node.type === "VariableDeclaration") {
      for (const decl of node.declarations) collectPatternNames(decl.id, names);
      continue;
    }

    if (node.type === "ExportNamedDeclaration" && node.declaration) {
      if (node.declaration.type === "FunctionDeclaration" && node.declaration.id?.name) {
        names.add(node.declaration.id.name);
      } else if (node.declaration.type === "ClassDeclaration" && node.declaration.id?.name) {
        names.add(node.declaration.id.name);
      } else if (node.declaration.type === "VariableDeclaration") {
        for (const decl of node.declaration.declarations) collectPatternNames(decl.id, names);
      }
      continue;
    }
  }

  return names;
}

function collectPatternNames(
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  pattern: any,
  names: Set<string>,
) {
  if (!pattern) return;

  if (pattern.type === "Identifier") {
    names.add(pattern.name);
  } else if (pattern.type === "ObjectPattern") {
    for (const prop of pattern.properties) {
      collectPatternNames(prop.value ?? prop.argument, names);
    }
  } else if (pattern.type === "ArrayPattern") {
    for (const elem of pattern.elements) {
      collectPatternNames(elem, names);
    }
  } else if (pattern.type === "RestElement" || pattern.type === "AssignmentPattern") {
    collectPatternNames(pattern.left ?? pattern.argument, names);
  }
}
