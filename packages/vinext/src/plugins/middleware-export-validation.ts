import { parseAst } from "vite";
import { createMiddlewareMissingExportError } from "../server/middleware-runtime.js";
import { getAstName, scriptParserLanguage } from "./ast-utils.js";

type AstName = { name?: unknown; value?: unknown } | null | undefined;

type ExportSpecifier = {
  exported?: AstName;
  local?: AstName;
};

type Declaration = {
  type?: string;
  id?: AstName;
  declarations?: Array<{ id?: AstName }>;
};

type Statement = {
  type?: string;
  declaration?: Declaration | null;
  specifiers?: ExportSpecifier[];
};

export function hasValidMiddlewareModuleExport(
  source: string,
  id: string,
  isProxy: boolean,
): boolean {
  // Match Next.js's validateMiddlewareProxyExports static analysis: this
  // verifies that the expected export name exists, not that its value is
  // callable. The shared runtime validation remains authoritative for values
  // such as `export const proxy = 1` and re-exports from another module.
  const ast = parseAst(source, { lang: scriptParserLanguage(id) ?? "jsx" });
  const expectedExport = isProxy ? "proxy" : "middleware";

  for (const statement of ast.body as Statement[]) {
    if (statement.type === "ExportDefaultDeclaration") return true;
    if (statement.type !== "ExportNamedDeclaration") continue;

    const declaration = statement.declaration;
    if (
      declaration?.type === "FunctionDeclaration" &&
      getAstName(declaration.id) === expectedExport
    ) {
      return true;
    }
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations ?? []) {
        if (getAstName(declarator.id) === expectedExport) return true;
      }
    }
    for (const specifier of statement.specifiers ?? []) {
      if (getAstName(specifier.exported ?? specifier.local) === expectedExport) return true;
    }
  }

  return false;
}

export function validateMiddlewareModuleExports(
  source: string,
  id: string,
  filePath: string,
  isProxy: boolean,
): void {
  if (!hasValidMiddlewareModuleExport(source, id, isProxy)) {
    throw createMiddlewareMissingExportError(filePath, isProxy);
  }
}
