import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseAst, type Plugin } from "vite";

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
const NODE_MODULES_RE = /[\\/]node_modules[\\/]/;
const STYLED_JSX_SOURCE_RE =
  /(?:<style\b|from\s+["']styled-jsx\/css["']|require\s*\(\s*["']styled-jsx\/css["']\s*\))/;
const STYLED_JSX_CSS_RE =
  /(?:from\s+["']styled-jsx\/css["']|require\s*\(\s*["']styled-jsx\/css["']\s*\))/;

function hasStyledJsxTag(source: string, id: string): boolean {
  const cleanId = id.split("?")[0];
  const extension = path.extname(cleanId);
  const lang = extension === ".ts" || extension === ".mts" || extension === ".cts" ? "ts" : "tsx";
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(source, { lang });
  } catch {
    return false;
  }

  const pending: unknown[] = [ast];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);

    const node = value as Record<string, unknown>;
    if (node.type === "JSXOpeningElement") {
      const name = node.name as { type?: string; name?: string } | undefined;
      if (name?.type === "JSXIdentifier" && name.name === "style") {
        const attributes = node.attributes as Array<Record<string, unknown>> | undefined;
        if (
          attributes?.some((attribute) => {
            if (attribute.type !== "JSXAttribute") return false;
            const attributeName = attribute.name as { type?: string; name?: string } | undefined;
            return attributeName?.type === "JSXIdentifier" && attributeName.name === "jsx";
          })
        ) {
          return true;
        }
      }
    }

    for (const child of Object.values(node)) {
      if (Array.isArray(child)) pending.push(...child);
      else if (child && typeof child === "object") pending.push(child);
    }
  }
  return false;
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
          return getNextRequire()?.resolve(source) ?? null;
        } catch {}

        try {
          return createProjectRequire(projectRoot).resolve(source);
        } catch {
          return null;
        }
      },
    },
    transform: {
      filter: {
        id: {
          include: /\.[cm]?[jt]sx?(?:\?.*)?$/,
          exclude: NODE_MODULES_RE,
        },
        code: STYLED_JSX_SOURCE_RE,
      },
      async handler(source, id) {
        if (NODE_MODULES_RE.test(id.split("?")[0])) return null;
        const hasStyledJsxCss = STYLED_JSX_CSS_RE.test(source);
        const hasStyledJsxElement = !hasStyledJsxCss && hasStyledJsxTag(source, id);
        if (!hasStyledJsxCss && !hasStyledJsxElement) return null;
        if (!getNextRequire()) {
          throw new Error(
            "[vinext] styled-jsx requires an installed next package so vinext can use its matching compiler.",
          );
        }
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
