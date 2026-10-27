import MagicString from "magic-string";
import { parseAst, type ESTree, type Plugin } from "vite";
import { SCRIPT_MODULE_ID_RE, scriptParserLanguage, walkAst } from "./ast-utils.js";
import { magicStringTransformResult } from "./transform-result.js";

/**
 * Cheap pre-parse gate: a module can only carry a JSON import attribute if
 * its source contains `type: "json"` (or `'json'`). Errs toward over-matching;
 * a false positive costs one parse.
 */
const JSON_TYPE_ATTRIBUTE_PRESCAN = /\btype\s*:\s*["']json["']/;

/** A specifier Vite already loads as JSON, judged by its extension. */
const JSON_EXTENSION_RE = /\.json5?(?:$|[?#])/i;

/**
 * Query suffix that routes the module through Vite's JSON plugin: its filter
 * only looks for a `.json` extension, which `?lang.json` provides without
 * changing the file Vite reads (queries are stripped before loading).
 */
const JSON_LANG_QUERY = "lang.json";

type SourceLiteral = { start: number; end: number; value: string };

function hasJsonTypeAttribute(attributes: readonly ESTree.ImportAttribute[] | undefined): boolean {
  if (!attributes) return false;
  return attributes.some((attribute) => {
    const key = attribute.key.type === "Identifier" ? attribute.key.name : attribute.key.value;
    return key === "type" && attribute.value.value === "json";
  });
}

/** `import(spec, { with: { type: "json" } })` (or the legacy `assert` key). */
function dynamicImportHasJsonType(options: ESTree.Expression | null | undefined): boolean {
  if (!options || options.type !== "ObjectExpression") return false;
  for (const property of options.properties) {
    if (property.type !== "Property" || property.computed) continue;
    const key = property.key.type === "Identifier" ? property.key.name : null;
    if ((key !== "with" && key !== "assert") || property.value.type !== "ObjectExpression")
      continue;
    for (const inner of property.value.properties) {
      if (inner.type !== "Property" || inner.computed) continue;
      const innerKey =
        inner.key.type === "Identifier"
          ? inner.key.name
          : inner.key.type === "Literal"
            ? inner.key.value
            : null;
      if (innerKey === "type" && inner.value.type === "Literal" && inner.value.value === "json") {
        return true;
      }
    }
  }
  return false;
}

function asSourceLiteral(node: ESTree.Node | null | undefined): SourceLiteral | null {
  if (!node || node.type !== "Literal" || typeof node.value !== "string") return null;
  return { start: node.start, end: node.end, value: node.value };
}

/**
 * Find every import whose `with { type: "json" }` attribute names a specifier
 * Vite would not load as JSON on its own (no `.json` extension).
 */
export function collectJsonAttributeImports(code: string, id: string): SourceLiteral[] {
  const lang = scriptParserLanguage(id);
  if (!lang) return [];
  let ast: ESTree.Program;
  try {
    ast = parseAst(code, { lang });
  } catch {
    return [];
  }
  const found: SourceLiteral[] = [];
  const consider = (source: SourceLiteral | null) => {
    if (source && !JSON_EXTENSION_RE.test(source.value)) found.push(source);
  };
  for (const statement of ast.body) {
    if (
      (statement.type === "ImportDeclaration" ||
        statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportAllDeclaration") &&
      hasJsonTypeAttribute(statement.attributes)
    ) {
      consider(asSourceLiteral(statement.source));
    }
  }
  walkAst(ast, (node) => {
    if (node.type === "ImportExpression" && dynamicImportHasJsonType(node.options)) {
      consider(asSourceLiteral(node.source));
    }
  });
  return found;
}

/**
 * Honour `with { type: "json" }` on imports of files without a `.json`
 * extension, as webpack and Turbopack do in Next.js
 * (`import data from "./data" with { type: "json" }`).
 *
 * Vite and Rolldown pick the JSON loader from the file extension alone and do
 * not pass import attributes to `resolveId`, so such a file is parsed as
 * JavaScript and the build fails with a parse error. Rewriting the specifier
 * to carry a `?lang.json` query sends it through Vite's own JSON plugin; the
 * file on disk and the import's attribute are unchanged.
 */
export function createJsonImportAttributesPlugin(): Plugin {
  return {
    name: "vinext:json-import-attributes",
    enforce: "pre",
    transform: {
      filter: {
        id: { include: SCRIPT_MODULE_ID_RE },
        code: JSON_TYPE_ATTRIBUTE_PRESCAN,
      },
      handler(code, id) {
        if (id.startsWith("\0")) return null;
        const imports = collectJsonAttributeImports(code, id);
        if (imports.length === 0) return null;
        const output = new MagicString(code);
        for (const source of imports) {
          const separator = source.value.includes("?") ? "&" : "?";
          output.overwrite(
            source.start,
            source.end,
            JSON.stringify(`${source.value}${separator}${JSON_LANG_QUERY}`),
          );
        }
        return magicStringTransformResult(output);
      },
    },
  };
}
