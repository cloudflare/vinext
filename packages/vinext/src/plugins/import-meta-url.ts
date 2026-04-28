import path from "node:path";
import { pathToFileURL } from "node:url";
import MagicString from "magic-string";
import type { Plugin, TransformResult } from "vite";

type TransformOptions = {
  environmentName?: string;
  root: string;
  turbopackRootPlaceholder?: boolean;
};

function cleanModuleId(id: string): string {
  const cleanId = id.startsWith("\0") ? id.slice(1) : id;
  const queryIndex = cleanId.search(/[?#]/);
  return queryIndex === -1 ? cleanId : cleanId.slice(0, queryIndex);
}

function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

function findEnclosingParen(code: string, index: number): number {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const char = code[i];
    if (char === ")") {
      depth++;
    } else if (char === "(") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

function isNewUrlImportMetaBase(code: string, index: number): boolean {
  const parenIndex = findEnclosingParen(code, index);
  if (parenIndex === -1) return false;

  const beforeParen = code.slice(Math.max(0, parenIndex - 32), parenIndex).trimEnd();
  if (!/(^|[^\w$])new\s+URL$/.test(beforeParen)) return false;

  return code.slice(parenIndex + 1, index).includes(",");
}

function findImportMetaUrlRanges(code: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const needle = "import.meta.url";
  let i = 0;

  while (i < code.length) {
    const char = code[i];
    const next = code[i + 1];

    if (char === "/" && next === "/") {
      i = code.indexOf("\n", i + 2);
      if (i === -1) break;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      i++;
      while (i < code.length) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (
      code.startsWith(needle, i) &&
      !isIdentifierChar(code[i - 1]) &&
      !isIdentifierChar(code[i + needle.length]) &&
      !isNewUrlImportMetaBase(code, i)
    ) {
      ranges.push([i, i + needle.length]);
      i += needle.length;
      continue;
    }

    i++;
  }

  return ranges;
}

function sourceUrlForModule(id: string, options: TransformOptions): string {
  const filepath = cleanModuleId(id);
  const normalizedFilepath = filepath.replace(/\\/g, "/");
  const normalizedRoot = options.root.replace(/\\/g, "/");

  if (options.environmentName === "client" && options.turbopackRootPlaceholder === true) {
    const relativePath = path.posix.relative(normalizedRoot, normalizedFilepath);
    if (!relativePath.startsWith("../") && relativePath !== "..") {
      return `file:///ROOT/${relativePath}`;
    }
  }

  return pathToFileURL(filepath).href;
}

export function transformNextImportMetaUrl(
  code: string,
  id: string,
  options: TransformOptions,
): TransformResult | null {
  if (!code.includes("import.meta.url")) return null;
  if (id.includes("node_modules")) return null;
  if (id.startsWith("\0")) return null;
  if (!/\.(tsx?|jsx?|mjs)$/.test(cleanModuleId(id))) return null;

  const ranges = findImportMetaUrlRanges(code);
  if (ranges.length === 0) return null;

  const replacement = JSON.stringify(sourceUrlForModule(id, options));
  const output = new MagicString(code);
  for (const [start, end] of ranges) {
    output.overwrite(start, end, replacement);
  }

  return {
    code: output.toString(),
    map: output.generateMap({ hires: "boundary" }) as TransformResult["map"],
  };
}

export function createImportMetaUrlPlugin(getRoot: () => string): Plugin {
  return {
    name: "vinext:import-meta-url",
    enforce: "pre",
    transform(code, id) {
      return transformNextImportMetaUrl(code, id, {
        environmentName: this.environment?.name,
        root: getRoot(),
        turbopackRootPlaceholder: process.env.IS_TURBOPACK_TEST === "1",
      });
    },
  };
}
