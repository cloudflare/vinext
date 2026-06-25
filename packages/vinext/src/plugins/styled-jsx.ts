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
  /(?:<style\s+jsx\b|from\s+["']styled-jsx\/css["']|require\(["']styled-jsx\/css["']\))/;

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
                refresh: development,
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
