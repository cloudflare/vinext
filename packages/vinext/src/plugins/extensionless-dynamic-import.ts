import MagicString from "magic-string";
import { parseAst, type Plugin } from "vite";
import { forEachAstChild, hasRange, isAstRecord, nodeArray, type AstRecord } from "./ast-utils.js";

const MODULE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"];
const TRANSFORMABLE_EXTENSIONS = new Set(MODULE_EXTENSIONS);

type ExtensionlessImport = {
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
  globPattern: string;
};

export function createExtensionlessDynamicImportPlugin(): Plugin {
  return {
    name: "vinext:extensionless-dynamic-import",
    enforce: "pre",
    transform(code, id) {
      if (!code.includes("import(") && !code.includes("import (")) return null;
      const lang = langForId(id);
      if (!lang) return null;

      let ast: unknown;
      try {
        ast = parseAst(code, { lang });
      } catch {
        return null;
      }

      const imports = collectExtensionlessImports(ast);
      if (imports.length === 0) return null;

      const output = new MagicString(code);
      for (const dynamicImport of imports) {
        const source = code.slice(dynamicImport.sourceStart, dynamicImport.sourceEnd);
        output.overwrite(
          dynamicImport.start,
          dynamicImport.end,
          buildReplacement(source, dynamicImport.globPattern),
        );
      }

      return {
        code: output.toString(),
        map: output.generateMap({ hires: "boundary" }),
      };
    },
  };
}

function langForId(id: string): "js" | "jsx" | "ts" | "tsx" | null {
  const clean = id.split("?", 1)[0];
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = clean.slice(dot).toLowerCase();
  if (!TRANSFORMABLE_EXTENSIONS.has(ext)) return null;
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return "ts";
  if (ext === ".tsx") return "tsx";
  return "jsx";
}

function collectExtensionlessImports(ast: unknown): ExtensionlessImport[] {
  const imports: ExtensionlessImport[] = [];

  function visit(value: unknown): void {
    if (!isAstRecord(value)) return;
    const parsed = parseExtensionlessImport(value);
    if (parsed) {
      imports.push(parsed);
      return;
    }
    forEachAstChild(value, visit);
  }

  visit(ast);
  return imports;
}

function parseExtensionlessImport(node: AstRecord): ExtensionlessImport | null {
  if (node.type !== "ImportExpression" || !hasRange(node)) return null;
  if (node.options != null) return null;
  const source = node.source;
  if (!isAstRecord(source) || source.type !== "TemplateLiteral" || !hasRange(source)) return null;
  if (nodeArray(source.expressions).length === 0) return null;

  const quasis = nodeArray(source.quasis);
  const first = templateElementText(quasis[0]);
  const last = templateElementText(quasis.at(-1));
  if (first == null || last == null) return null;
  if (!(first.startsWith("./") || first.startsWith("../"))) return null;
  if (!first.endsWith("/")) return null;
  if (last.includes(".")) return null;

  return {
    start: node.start,
    end: node.end,
    sourceStart: source.start,
    sourceEnd: source.end,
    globPattern: `${first}**/*{${MODULE_EXTENSIONS.join(",")}}`,
  };
}

function templateElementText(value: unknown): string | null {
  if (!isAstRecord(value) || value.type !== "TemplateElement") return null;
  const templateValue = value.value;
  if (typeof templateValue !== "object" || templateValue === null) return null;
  const cooked = Reflect.get(templateValue, "cooked");
  return typeof cooked === "string" ? cooked : null;
}

function buildReplacement(source: string, globPattern: string): string {
  const extensions = JSON.stringify(MODULE_EXTENSIONS);
  return `((__vinextPath, __vinextModules = import.meta.glob(${JSON.stringify(globPattern)})) => { const __vinextLoader = __vinextModules[__vinextPath] ?? ${extensions}.map((__vinextExtension) => __vinextModules[__vinextPath + __vinextExtension]).find(Boolean); return __vinextLoader ? __vinextLoader() : Promise.reject(new Error("Cannot find module '" + __vinextPath + "'")); })(${source})`;
}
