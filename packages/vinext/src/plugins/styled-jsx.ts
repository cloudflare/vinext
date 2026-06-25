import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";

type NextSwcModule = {
  loadBindings(): Promise<unknown>;
  transform(
    source: string,
    options: Record<string, unknown>,
  ): Promise<{ code: string; map?: string }>;
};

type StyledJsxPluginOptions = {
  importModule?: (url: string) => Promise<NextSwcModule>;
};

const STYLED_JSX_IMPORT_RE = /^styled-jsx(?:\/.*)?$/;
const STYLED_JSX_SOURCE_RE =
  /(?:<style\b|from\s+["']styled-jsx\/css["']|require\s*\(\s*["']styled-jsx\/css["']\s*\))/;
const STYLED_JSX_CSS_RE =
  /(?:from\s+["']styled-jsx\/css["']|require\s*\(\s*["']styled-jsx\/css["']\s*\))/;

function skipJsxExpression(source: string, start: number): number {
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return index + 1;
  }
  return source.length;
}

function hasStyledJsxTag(source: string): boolean {
  for (
    let tagStart = source.indexOf("<style");
    tagStart !== -1;
    tagStart = source.indexOf("<style", tagStart + 6)
  ) {
    const boundary = source[tagStart + 6];
    if (boundary && !/[\s/>]/.test(boundary)) continue;

    let index = tagStart + 6;
    while (index < source.length) {
      while (/\s/.test(source[index] ?? "")) index++;
      if (source[index] === ">" || (source[index] === "/" && source[index + 1] === ">")) break;
      if (source[index] === "{") {
        index = skipJsxExpression(source, index);
        continue;
      }

      const attribute = /^[A-Za-z_:][\w:.-]*/.exec(source.slice(index))?.[0];
      if (!attribute) {
        index++;
        continue;
      }
      if (attribute === "jsx") return true;
      index += attribute.length;
      while (/\s/.test(source[index] ?? "")) index++;
      if (source[index] !== "=") continue;
      index++;
      while (/\s/.test(source[index] ?? "")) index++;
      if (source[index] === "{") index = skipJsxExpression(source, index);
      else if (source[index] === '"' || source[index] === "'") {
        const quote = source[index++];
        while (index < source.length && source[index] !== quote) {
          if (source[index] === "\\") index++;
          index++;
        }
        index++;
      }
    }
  }
  return false;
}

function hasStyledJsxSource(source: string): boolean {
  return STYLED_JSX_CSS_RE.test(source) || hasStyledJsxTag(source);
}

function createProjectRequire(projectRoot: string) {
  return createRequire(path.join(projectRoot, "package.json"));
}

function resolveNextRequire(projectRoot: string): NodeJS.Require | null {
  try {
    const projectRequire = createProjectRequire(projectRoot);
    return createRequire(projectRequire.resolve("next/package.json"));
  } catch {
    return null;
  }
}

function parserOptions(id: string): Record<string, unknown> {
  const extension = path.extname(id.split("?")[0]);
  if (extension === ".ts" || extension === ".tsx") {
    return { syntax: "typescript", tsx: extension === ".tsx", decorators: true };
  }
  return { syntax: "ecmascript", jsx: true };
}

export function createStyledJsxPlugin(
  initialProjectRoot: string,
  options: StyledJsxPluginOptions = {},
): Plugin {
  let projectRoot = initialProjectRoot;
  let development = false;
  let nextRequire: NodeJS.Require | null | undefined;
  let compilerPromise: Promise<NextSwcModule> | null = null;
  const importModule = options.importModule ?? ((url: string) => import(url));

  function getNextRequire(): NodeJS.Require | null {
    nextRequire ??= resolveNextRequire(projectRoot);
    return nextRequire;
  }

  async function getCompiler(): Promise<NextSwcModule> {
    if (!compilerPromise) {
      const requireFromNext = getNextRequire();
      if (!requireFromNext) {
        throw new Error(
          "[vinext] styled-jsx requires an installed next package so vinext can use its matching compiler.",
        );
      }
      const compilerPath = requireFromNext.resolve("next/dist/build/swc");
      compilerPromise = importModule(pathToFileURL(compilerPath).href).then(async (compiler) => {
        await compiler.loadBindings();
        return compiler;
      });
    }
    return compilerPromise;
  }

  return {
    name: "vinext:styled-jsx",
    enforce: "pre",
    configResolved(config) {
      development = config.command === "serve";
      if (config.root !== projectRoot) {
        projectRoot = config.root;
        nextRequire = undefined;
        compilerPromise = null;
      }
    },
    resolveId: {
      filter: { id: STYLED_JSX_IMPORT_RE },
      handler(source) {
        try {
          return createProjectRequire(projectRoot).resolve(source);
        } catch {}

        try {
          return getNextRequire()?.resolve(source) ?? null;
        } catch {
          return null;
        }
      },
    },
    transform: {
      filter: {
        id: /\.[cm]?[jt]sx?(?:\?.*)?$/,
        code: STYLED_JSX_SOURCE_RE,
      },
      async handler(source, id) {
        if (!hasStyledJsxSource(source)) return null;
        const compiler = await getCompiler();
        const result = await compiler.transform(source, {
          filename: id.split("?")[0],
          sourceMaps: true,
          module: { type: "es6" },
          styledJsx: { useLightningcss: false },
          jsc: {
            parser: parserOptions(id),
            transform: {
              react: {
                runtime: "automatic",
                development,
                useBuiltins: true,
              },
              optimizer: { simplify: false },
            },
          },
        });
        return { code: result.code, map: result.map ?? null };
      },
    },
  };
}
