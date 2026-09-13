import type { Plugin } from "vite";
import { parseAst } from "vite";
import MagicString from "magic-string";
import {
  SCRIPT_MODULE_ID_RE,
  scriptParserLanguage,
  type ScriptParserLanguage,
} from "./ast-utils.js";
import { magicStringTransformResult } from "./transform-result.js";

const CSS_MODULE_RE = /\.module\.(?:css|scss|sass)$/i;
const CSS_MODULE_HINT_RE = /\.module\.(?:css|scss|sass)/i;
const MDX_RE = /\.mdx$/i;

type AstImportSpecifier = {
  type?: string;
  start?: number;
  end?: number;
  local?: { name?: unknown };
};

type AstImportDeclaration = {
  type?: string;
  importKind?: string;
  source?: { value?: unknown };
  specifiers?: AstImportSpecifier[];
  attributes?: unknown[];
};

export function rewriteCssModuleNamespaceImports(
  code: string,
  lang: ScriptParserLanguage = "js",
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
    if (statement.importKind === "type") continue;
    if (typeof statement.source?.value !== "string") continue;
    if (!CSS_MODULE_RE.test(statement.source.value)) continue;
    if (statement.attributes && statement.attributes.length > 0) continue;
    if (statement.specifiers?.length !== 1) continue;

    const specifier = statement.specifiers[0];
    if (specifier.type !== "ImportNamespaceSpecifier") continue;
    if (typeof specifier.start !== "number" || typeof specifier.end !== "number") continue;

    if (typeof specifier.local?.name !== "string") continue;

    output ??= new MagicString(code);
    output.overwrite(specifier.start, specifier.end, specifier.local.name);
  }

  if (!output) return null;
  return magicStringTransformResult(output, { hires: true });
}

export function createCssModuleImportCompatibilityPlugin(
  options: { compiledMdx?: boolean } = {},
): Plugin {
  const idFilter = options.compiledMdx ? MDX_RE : SCRIPT_MODULE_ID_RE;
  return {
    name: options.compiledMdx
      ? "vinext:css-module-import-compatibility-mdx"
      : "vinext:css-module-import-compatibility",
    enforce: options.compiledMdx ? "post" : "pre",
    transform: {
      filter: { id: idFilter, code: CSS_MODULE_HINT_RE },
      handler(code, id) {
        return rewriteCssModuleNamespaceImports(
          code,
          options.compiledMdx ? "jsx" : (scriptParserLanguage(id) ?? "jsx"),
        );
      },
    },
  };
}
