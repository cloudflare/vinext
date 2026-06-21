import { extname } from "node:path";
import { transformWithOxc, type Plugin } from "vite";
import { extractPackageName } from "./client-reference-dedup.js";

const STYLE_JSX_RE = /<style\s+[^>]*\bjsx(?:\s|=|>)/;
const STYLE_JSX_CSS_RE = /["']styled-jsx\/css["']/;

type BabelCore = {
  transformAsync(
    code: string,
    options: Record<string, unknown>,
  ): Promise<{
    code?: string | null;
    map?: {
      version: number;
      sources: string[];
      names: string[];
      mappings: string;
      file?: string;
      sourceRoot?: string;
      sourcesContent?: Array<string | null>;
    } | null;
  } | null>;
};

let compilerPromise: Promise<{
  babel: BabelCore;
  styledJsxPlugin: unknown;
}> | null = null;

type StyledJsxPluginOptions = {
  getTranspilePackages?: () => readonly string[] | undefined;
};

async function loadCompiler() {
  if (!compilerPromise) {
    compilerPromise = Promise.all([import("@babel/core"), import("styled-jsx/babel")]).then(
      ([babel, styledJsx]) => ({
        babel: babel as BabelCore,
        styledJsxPlugin: styledJsx.default,
      }),
    );
  }
  return compilerPromise;
}

export function createStyledJsxPlugin(options: StyledJsxPluginOptions = {}): Plugin {
  return {
    name: "vinext:styled-jsx",
    enforce: "pre",
    transform: {
      filter: { id: /\.(?:[cm]?[jt]sx?)(?:\?.*)?$/ },
      async handler(code, id) {
        if (id.includes("?")) return;
        if (id.includes("/node_modules/")) {
          const packageName = extractPackageName(id);
          if (
            packageName === null ||
            packageName === "styled-jsx" ||
            !options.getTranspilePackages?.()?.includes(packageName)
          ) {
            return;
          }
        }
        if (!STYLE_JSX_RE.test(code) && !STYLE_JSX_CSS_RE.test(code)) return;

        const { babel, styledJsxPlugin } = await loadCompiler();
        const extension = extname(id);
        const parserPlugins: string[] = [];
        if ([".ts", ".mts", ".cts", ".tsx"].includes(extension)) {
          parserPlugins.push("typescript");
        }
        if ([".js", ".jsx", ".tsx"].includes(extension)) {
          parserPlugins.push("jsx");
        }
        const result = await babel.transformAsync(code, {
          filename: id,
          babelrc: false,
          configFile: false,
          sourceMaps: true,
          parserOpts: {
            plugins: parserPlugins,
          },
          plugins: [[styledJsxPlugin, { styleModule: "styled-jsx/style" }]],
        });

        if (!result?.code) return;
        if ([".ts", ".mts", ".cts"].includes(extension)) {
          const transformed = await transformWithOxc(
            result.code,
            `${id}x`,
            {
              lang: "tsx",
              jsx: { runtime: "automatic" },
              sourcemap: true,
            },
            result.map ?? undefined,
          );
          return { code: transformed.code, map: transformed.map };
        }
        return { code: result.code, map: result.map ?? null };
      },
    },
  };
}
