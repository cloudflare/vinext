import { parseAst } from "vite";
import { createMiddlewareMissingExportError } from "../server/middleware-runtime.js";
import { stripViteModuleQuery } from "../utils/path.js";

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

function parserLanguage(id: string): "js" | "jsx" | "ts" | "tsx" {
  const cleanId = stripViteModuleQuery(id).toLowerCase();
  if (cleanId.endsWith(".tsx")) return "tsx";
  if (cleanId.endsWith(".ts") || cleanId.endsWith(".mts") || cleanId.endsWith(".cts")) {
    return "ts";
  }
  return "jsx";
}

function astName(value: AstName): string | null {
  if (!value) return null;
  if (typeof value.name === "string") return value.name;
  if (typeof value.value === "string") return value.value;
  return null;
}

export function hasValidMiddlewareModuleExport(
  source: string,
  id: string,
  isProxy: boolean,
): boolean {
  // Match Next.js's validateMiddlewareProxyExports static analysis: this
  // verifies that the expected export name exists, not that its value is
  // callable. The shared runtime validation remains authoritative for values
  // such as `export const proxy = 1` and re-exports from another module.
  const ast = parseAst(source, { lang: parserLanguage(id) });
  const expectedExport = isProxy ? "proxy" : "middleware";

  for (const statement of ast.body as Statement[]) {
    if (statement.type === "ExportDefaultDeclaration") return true;
    if (statement.type !== "ExportNamedDeclaration") continue;

    const declaration = statement.declaration;
    if (declaration?.type === "FunctionDeclaration" && astName(declaration.id) === expectedExport) {
      return true;
    }
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations ?? []) {
        if (astName(declarator.id) === expectedExport) return true;
      }
    }
    for (const specifier of statement.specifiers ?? []) {
      if (astName(specifier.exported ?? specifier.local) === expectedExport) return true;
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
