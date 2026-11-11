import { createRequire } from "node:module";
import path, { toSlash } from "pathslash";
import { pathToFileURL } from "node:url";
import type { ESTree, Plugin } from "vite";
import { NODE_MODULES_PATH_RE, stripViteModuleQuery } from "../utils/path.js";
import { parseProgram, SCRIPT_MODULE_ID_RE, walkAst } from "./ast-utils.js";

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
// Browser-side entry points: compiled `<style jsx>` imports `styled-jsx/style`,
// and App Router style registries import `styled-jsx`.
const STYLED_JSX_RUNTIME_IDS = ["styled-jsx", "styled-jsx/style"];
const STYLED_JSX_SOURCE_RE =
  /(?:<style\b|from\s+["']styled-jsx\/css["']|require\s*\(\s*["']styled-jsx\/css["']\s*\))/;
const STYLED_JSX_CSS_RE =
  /(?:from\s+["']styled-jsx\/css["']|require\s*\(\s*["']styled-jsx\/css["']\s*\))/;

function hasStyledJsxTag(source: string, id: string): boolean {
  const cleanId = stripViteModuleQuery(id);
  const extension = path.extname(cleanId);
  const lang = extension === ".ts" || extension === ".mts" || extension === ".cts" ? "ts" : "tsx";
  let ast: ESTree.Program;
  try {
    ast = parseProgram(source, { lang });
  } catch {
    return false;
  }

  let found = false;
  walkAst(ast, (node) => {
    if (found) return false;
    if (node.type === "JSXOpeningElement") {
      const name = node.name;
      if (name.type === "JSXIdentifier" && name.name === "style") {
        if (
          node.attributes.some((attribute) => {
            if (attribute.type !== "JSXAttribute") return false;
            return attribute.name.type === "JSXIdentifier" && attribute.name.name === "jsx";
          })
        ) {
          found = true;
          return false;
        }
      }
    }
  });
  return found;
}

function createProjectRequire(projectRoot: string) {
  return createRequire(path.join(projectRoot, "package.json"));
}

function resolveNextPackageJson(projectRoot: string): string | null {
  try {
    return toSlash(createProjectRequire(projectRoot).resolve("next/package.json"));
  } catch {
    return null;
  }
}

function parserOptions(id: string): Record<string, unknown> {
  const extension = path.extname(stripViteModuleQuery(id));
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
  let nextPackageJson: string | null | undefined;
  let nextRequire: NodeJS.Require | null | undefined;
  let compilerPromise: Promise<NextSwcModule> | null = null;
  const importModule = options.importModule ?? ((url: string) => import(url));

  function getNextPackageJson(): string | null {
    if (nextPackageJson === undefined) nextPackageJson = resolveNextPackageJson(projectRoot);
    return nextPackageJson;
  }

  function getNextRequire(): NodeJS.Require | null {
    if (nextRequire === undefined) {
      const packageJson = getNextPackageJson();
      nextRequire = packageJson ? createRequire(packageJson) : null;
    }
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
        nextPackageJson = undefined;
        nextRequire = undefined;
        compilerPromise = null;
      }

      const clientOptimizeDeps = config.environments.client?.optimizeDeps;
      const requireFromNext = development && clientOptimizeDeps ? getNextRequire() : null;
      if (!clientOptimizeDeps || !requireFromNext) return;
      // styled-jsx ships CommonJS, so the browser needs the prebundled copy.
      // The client resolveId below resolves it from Next's package, and Vite
      // never discovers deps imported from inside node_modules, so without
      // these startup includes the browser gets the raw CommonJS file.
      for (const id of STYLED_JSX_RUNTIME_IDS) {
        const include = `next > ${id}`;
        if (clientOptimizeDeps.include?.includes(include)) continue;
        try {
          requireFromNext.resolve(id);
        } catch {
          continue;
        }
        (clientOptimizeDeps.include ??= []).push(include);
      }
    },
    resolveId: {
      filter: { id: STYLED_JSX_IMPORT_RE },
      async handler(source, _importer, resolveOptions) {
        const packageJson = getNextPackageJson();
        if (development && packageJson && this.environment.name === "client") {
          // An absolute path would bypass the dev dependency optimizer and
          // serve the raw CommonJS file. Resolving the bare id as Next would
          // import it picks up the copy prebundled by configResolved instead.
          return this.resolve(source, packageJson, { ...resolveOptions, skipSelf: true });
        }

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
          include: SCRIPT_MODULE_ID_RE,
          exclude: NODE_MODULES_PATH_RE,
        },
        code: STYLED_JSX_SOURCE_RE,
      },
      async handler(source, id) {
        if (NODE_MODULES_PATH_RE.test(stripViteModuleQuery(id))) return null;
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
          filename: stripViteModuleQuery(id),
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
