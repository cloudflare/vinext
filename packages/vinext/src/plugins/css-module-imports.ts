import type { Plugin } from "vite";
import { parseAst } from "vite";
import MagicString from "magic-string";

const CSS_MODULE_RE = /\.module\.(?:css|scss|sass)$/i;
const SCRIPT_RE = /\.(?:[cm]?[jt]sx?)(?:[?#].*)?$/i;

type AstImportSpecifier = {
  type?: string;
  start?: number;
  end?: number;
};

type AstImportDeclaration = {
  type?: string;
  source?: { value?: unknown };
  specifiers?: AstImportSpecifier[];
};

type ScriptLanguage = "js" | "jsx" | "ts" | "tsx";

function scriptLanguage(id: string): ScriptLanguage {
  const cleanId = id.split("?", 1)[0];
  if (cleanId.endsWith(".tsx")) return "tsx";
  if (cleanId.endsWith(".ts") || cleanId.endsWith(".mts") || cleanId.endsWith(".cts")) return "ts";
  if (cleanId.endsWith(".jsx")) return "jsx";
  return "js";
}

export function rewriteCssModuleNamespaceImports(
  code: string,
  lang: ScriptLanguage = "js",
): {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
} | null {
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code, { lang });
  } catch {
    return null;
  }

  let output: MagicString | null = null;
  for (const statement of ast.body as AstImportDeclaration[]) {
    if (statement.type !== "ImportDeclaration") continue;
    if (typeof statement.source?.value !== "string") continue;
    if (!CSS_MODULE_RE.test(statement.source.value)) continue;
    if (statement.specifiers?.length !== 1) continue;

    const specifier = statement.specifiers[0];
    if (specifier.type !== "ImportNamespaceSpecifier") continue;
    if (typeof specifier.start !== "number" || typeof specifier.end !== "number") continue;

    const namespaceBinding = code
      .slice(specifier.start, specifier.end)
      .match(/^\*\s+as\s+(.+)$/s)?.[1];
    if (!namespaceBinding) continue;

    output ??= new MagicString(code);
    output.overwrite(specifier.start, specifier.end, namespaceBinding);
  }

  if (!output) return null;
  return {
    code: output.toString(),
    map: output.generateMap({ hires: true }),
  };
}

export function createCssModuleImportCompatibilityPlugin(): Plugin {
  return {
    name: "vinext:css-module-import-compatibility",
    enforce: "pre",
    transform(code, id) {
      if (!SCRIPT_RE.test(id) || !code.includes(".module.")) return null;
      return rewriteCssModuleNamespaceImports(code, scriptLanguage(id));
    },
  };
}
