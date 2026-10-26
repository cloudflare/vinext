import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "pathslash";
import type { Plugin } from "vite";
import type { NextIntlCatalogLoader } from "../config/next-config.js";
import { canonicalizeFilePath, stripViteModuleQuery } from "../utils/path.js";
import { escapeRegExp } from "../utils/regex.js";

type WebpackLoader = (this: unknown, source: string) => unknown;

// Like vite:json, leave explicit raw/url/worker imports of a catalog to Vite.
const SPECIAL_QUERY_RE = /[?&](?:worker|sharedworker|raw|url)\b/;

/**
 * Runs next-intl's catalog loader on its `experimental.messages` catalogs, as
 * Next.js does through the webpack/Turbopack rule `createNextIntlPlugin` adds.
 * With `precompile: true` the plugin also aliases use-intl's formatter to one
 * that only formats precompiled messages, so raw catalogs would render their
 * ICU placeholders literally.
 */
export function createNextIntlCatalogPlugin(
  getRoot: () => string,
  getCatalogLoader: () => NextIntlCatalogLoader | null,
): Plugin {
  return {
    name: "vinext:next-intl-catalog",
    enforce: "pre",
    applyToEnvironment() {
      const catalogLoader = getCatalogLoader();
      if (!catalogLoader) return false;
      return createCatalogLoadPlugin(getRoot(), catalogLoader);
    },
  };
}

function createCatalogLoadPlugin(root: string, catalogLoader: NextIntlCatalogLoader): Plugin {
  const catalogDirs = catalogLoader.include.map(
    (dir) => `${escapeRegExp(canonicalizeFilePath(dir))}/`,
  );
  let loaderPromise: Promise<WebpackLoader> | undefined;

  return {
    name: "vinext:next-intl-catalog",
    load: {
      filter: { id: new RegExp(`^(?:${catalogDirs.join("|")})`) },
      async handler(id) {
        if (SPECIAL_QUERY_RE.test(id)) return null;
        const file = stripViteModuleQuery(id);
        catalogLoader.test.lastIndex = 0;
        if (!catalogLoader.test.test(file)) return null;

        loaderPromise ??= importCatalogLoader(root);
        const code = await runLoader(await loaderPromise, await fs.readFile(file, "utf8"), {
          resourcePath: file,
          rootContext: root,
          options: catalogLoader.options,
        });
        return { code, moduleType: "js" };
      },
    },
  };
}

async function importCatalogLoader(root: string): Promise<WebpackLoader> {
  const require = createRequire(path.join(root, "package.json"));
  const loaderPath = require.resolve("next-intl/extractor/catalogLoader");
  const loaderModule: { default?: unknown } = await import(pathToFileURL(loaderPath).href);
  if (typeof loaderModule.default !== "function") {
    throw new Error(`[vinext] ${loaderPath} does not export a webpack loader`);
  }
  return loaderModule.default as WebpackLoader;
}

// The part of webpack's loader context next-intl's catalog loader reads.
function runLoader(
  loader: WebpackLoader,
  source: string,
  context: { resourcePath: string; rootContext: string; options: Record<string, unknown> },
): Promise<string> {
  return new Promise((resolve, reject) => {
    let isAsync = false;
    const callback = (error: unknown, result?: unknown) => {
      if (error) reject(error);
      else resolve(String(result));
    };
    try {
      const result = loader.call(
        {
          resourcePath: context.resourcePath,
          rootContext: context.rootContext,
          getOptions: () => context.options,
          async: () => {
            isAsync = true;
            return callback;
          },
          callback,
        },
        source,
      );
      if (!isAsync) callback(null, result);
    } catch (error) {
      reject(error);
    }
  });
}
