import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path, { toSlash } from "pathslash";
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

const STYLED_JSX_RUNTIME_ID = "styled-jsx";
const STYLED_JSX_STYLE_ID = "styled-jsx/style";
const STYLED_JSX_RUNTIME_PUBLIC_ID = "virtual:vinext-styled-jsx-runtime";
const STYLED_JSX_RUNTIME_RESOLVED_ID = "\0vinext-styled-jsx-runtime";
const STYLED_JSX_STYLE_FACADE_ID = "\0vinext-styled-jsx-style";
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

function resolveProjectRoot(projectRoot: string): string {
  const normalizedRoot = toSlash(projectRoot);
  return path.isAbsolute(normalizedRoot)
    ? normalizedRoot
    : path.resolve(toSlash(process.cwd()), normalizedRoot);
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

function convertStyledJsxRuntimeToEsm(source: string): string {
  const withoutClientOnlyRequire = source.replace(
    /^require\(["']client-only["']\);/m,
    'import "client-only";',
  );
  const withReactImport = withoutClientOnlyRequire.replace(
    /^var React = require\(["']react["']\);/m,
    'import * as React from "react";',
  );
  const withEsmExports = withReactImport.replace(
    /exports\.StyleRegistry = StyleRegistry;\s*exports\.createStyleRegistry = createStyleRegistry;\s*exports\.style = JSXStyle;\s*exports\.useStyleRegistry = useStyleRegistry;\s*$/,
    "export { StyleRegistry, createStyleRegistry, JSXStyle as style, useStyleRegistry };\n",
  );

  if (
    withoutClientOnlyRequire === source ||
    withReactImport === withoutClientOnlyRequire ||
    withEsmExports === withReactImport
  ) {
    throw new Error(
      "[vinext] The installed styled-jsx runtime has an unsupported module wrapper shape.",
    );
  }
  return withEsmExports;
}

export function createStyledJsxPlugin(
  initialProjectRoot: string,
  options: StyledJsxPluginOptions = {},
): Plugin {
  let projectRoot = resolveProjectRoot(initialProjectRoot);
  let development = false;
  let nextRequire: NodeJS.Require | null | undefined;
  let compilerPromise: Promise<NextSwcModule> | null = null;
  const importModule = options.importModule ?? ((url: string) => import(url));

  function getNextRequire(): NodeJS.Require | null {
    nextRequire ??= resolveNextRequire(projectRoot);
    return nextRequire;
  }

  function getRuntimeDistPath(): string | null {
    const requireFromNext = getNextRequire();
    if (!requireFromNext) return null;
    const runtimePath = toSlash(requireFromNext.resolve(STYLED_JSX_RUNTIME_ID));
    return path.join(path.dirname(runtimePath), "dist/index/index.js");
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
      const configRoot = resolveProjectRoot(config.root);
      if (configRoot !== projectRoot) {
        projectRoot = configRoot;
        nextRequire = undefined;
        compilerPromise = null;
      }
    },
    resolveId: {
      filter: { id: /^(?:styled-jsx(?:\/.*)?|virtual:vinext-styled-jsx-runtime)$/ },
      handler(source) {
        if (source === STYLED_JSX_RUNTIME_ID || source === STYLED_JSX_RUNTIME_PUBLIC_ID) {
          return STYLED_JSX_RUNTIME_RESOLVED_ID;
        }
        if (source === STYLED_JSX_STYLE_ID) return STYLED_JSX_STYLE_FACADE_ID;
        try {
          return getNextRequire()?.resolve(source) ?? null;
        } catch {
          return null;
        }
      },
    },
    load(id) {
      if (id === STYLED_JSX_RUNTIME_RESOLVED_ID) {
        const runtimeDistPath = getRuntimeDistPath();
        if (!runtimeDistPath) return null;
        this.addWatchFile(runtimeDistPath);
        return convertStyledJsxRuntimeToEsm(readFileSync(runtimeDistPath, "utf8"));
      }
      if (id === STYLED_JSX_STYLE_FACADE_ID) {
        return `export { style as default } from ${JSON.stringify(STYLED_JSX_RUNTIME_PUBLIC_ID)};`;
      }
      return null;
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
          // Vinext's server and client entries inspect these exports directly.
          // Next's client-page compilation replaces them with __N_SSG/__N_SSP,
          // but running that tree-shaker here would also affect vinext's server
          // module graph and make the data functions disappear at runtime.
          disableNextSsg: true,
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
