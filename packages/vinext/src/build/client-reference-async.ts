import type { ESTree } from "vite";
import { parseProgram, walkAst } from "../plugins/ast-utils.js";

type AsyncModuleGraphInfo = { code: string | null; importedIds: readonly string[] };

/**
 * Whether `code` awaits at the top level of the module: an `await`, a
 * `for await` or an `await using` outside any function. Code that fails to
 * parse counts as synchronous.
 */
export function hasTopLevelAwait(code: string): boolean {
  if (!code.includes("await")) return false;
  let program: ESTree.Program;
  try {
    program = parseProgram(code, { sourceType: "module" });
  } catch {
    return false;
  }
  let found = false;
  walkAst(program, (node) => {
    if (found) return false;
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      return false;
    }
    if (node.type === "AwaitExpression") {
      found = true;
      return false;
    }
    if (
      (node.type === "ForOfStatement" && node.await) ||
      (node.type === "VariableDeclaration" && node.kind === "await using")
    ) {
      found = true;
    }
  });
  return found;
}

/**
 * The `roots` whose evaluation is asynchronous: the module, or a module it
 * statically imports at any depth, awaits at its top level. Webpack calls these
 * async modules, and React's Flight client suspends on them as they load.
 */
export function collectAsyncModules(options: {
  roots: readonly string[];
  getModuleInfo: (id: string) => AsyncModuleGraphInfo | null;
}): Set<string> {
  const importers = new Map<string, string[]>();
  const awaiting: string[] = [];
  const visited = new Set<string>();
  const stack = [...options.roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const info = options.getModuleInfo(id);
    if (!info) continue;
    if (info.code !== null && hasTopLevelAwait(info.code)) awaiting.push(id);
    for (const imported of info.importedIds) {
      let list = importers.get(imported);
      if (!list) importers.set(imported, (list = []));
      list.push(id);
      stack.push(imported);
    }
  }
  const asyncModules = new Set(awaiting);
  for (let index = 0; index < awaiting.length; index++) {
    for (const importer of importers.get(awaiting[index]!) ?? []) {
      if (asyncModules.has(importer)) continue;
      asyncModules.add(importer);
      awaiting.push(importer);
    }
  }
  return new Set(options.roots.filter((id) => asyncModules.has(id)));
}
