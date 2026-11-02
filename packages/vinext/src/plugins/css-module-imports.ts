import type { Plugin } from "vite";
import MagicString from "magic-string";
import {
  hasImportAttributes,
  LEADING_TRIVIA_RE,
  parseModuleRecord,
  SCRIPT_MODULE_ID_RE,
  scriptParserLanguage,
  type ScriptParserLanguage,
} from "./ast-utils.js";
import { magicStringTransformResult } from "./transform-result.js";

const CSS_MODULE_RE = /\.module\.(?:css|scss|sass)$/i;
const CSS_MODULE_HINT_RE = /\.module\.(?:css|scss|sass)/i;
const MDX_RE = /\.mdx$/i;

export function rewriteCssModuleNamespaceImports(
  code: string,
  lang: ScriptParserLanguage = "js",
): {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
} | null {
  const record = parseModuleRecord(code, lang);
  if (!record) return null;

  let output: MagicString | null = null;
  for (const statement of record.staticImports) {
    if (!CSS_MODULE_RE.test(statement.moduleRequest.value)) continue;
    if (hasImportAttributes(code, statement.moduleRequest.end, statement.end)) continue;
    if (statement.entries.length !== 1) continue;

    const [entry] = statement.entries;
    if (entry.isType || entry.importName.kind !== "NamespaceObject") continue;

    // The record only spans the local name, so find the `*` after `import`.
    const afterImport = statement.start + "import".length;
    const starIndex =
      afterImport +
      (LEADING_TRIVIA_RE.exec(code.slice(afterImport, entry.localName.start))?.[0].length ?? 0);
    if (code[starIndex] !== "*") continue;

    output ??= new MagicString(code);
    output.overwrite(starIndex, entry.localName.end, entry.localName.value);
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
