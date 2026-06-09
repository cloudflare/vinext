/**
 * Custom `postcss-modules` Loader that preprocesses CSS preprocessor files
 * (SCSS, Sass, Less, Stylus) BEFORE PostCSS reads them.
 *
 * ── Why this exists ────────────────────────────────────────────────────
 *
 * When a CSS module uses `composes: foo from './other.module.scss'`,
 * postcss-modules' built-in `FileSystemLoader` resolves the imported file
 * with `fs.readFile` and feeds the raw text directly into PostCSS Core.
 * It does NOT know about the Vite pipeline, so `.scss`/`.sass`/`.less`/
 * `.styl` files are loaded as-is — Sass variables (`$var: red;`),
 * `@use`/`@forward` directives, Less variables (`@var: red;`), Stylus
 * indentation, etc. all leak through verbatim.
 *
 * The downstream `vite:css-post` plugin then concatenates that raw
 * preprocessor source into the final bundle and hands it to the CSS
 * minifier. In Vite 8, server environments default `cssMinify` to
 * `'lightningcss'` (see `resolveBuildOptions` in the Vite source),
 * which then fails with:
 *
 *   SyntaxError: [lightningcss minify] Invalid empty selector
 *   1  |  $var: red;._className_10j3d_2 {
 *
 * Webpack + Next.js avoids this because the `composes ... from` import
 * goes through the full webpack loader chain (sass-loader → css-loader),
 * which preprocesses before css-modules runs. Vite's
 * `postcss-modules`-based pipeline doesn't have that integration, so we
 * supply our own `Loader` class via `css.modules.Loader` to bridge the gap.
 *
 * ── How it works ───────────────────────────────────────────────────────
 *
 * postcss-modules accepts a `Loader` constructor in its options
 * (`opts.Loader`). The class must implement
 * `fetch(file, relativeTo, trace) → Promise<exportTokens>` and expose a
 * `finalSource` getter that returns the concatenated CSS to be prepended
 * to the resulting output.
 *
 * `postcss-modules` is bundled inside the Vite distribution (not exposed
 * as its own package), so we cannot import `FileSystemLoader` and
 * delegate. Instead we reimplement the file-load + recursive-import +
 * token-extraction flow from scratch using `postcss` (which IS a
 * regular package we depend on), and run Vite's `preprocessCSS` on
 * the source before feeding it to PostCSS.
 *
 * The plugin pipeline that `postcss-modules` builds (its
 * `getDefaultPluginsList` output: postcss-modules-local-by-default →
 * postcss-modules-extract-imports → postcss-modules-scope →
 * postcss-modules-values) is passed to our constructor unchanged via
 * the `plugins` argument. Those plugins emit the `:import` and
 * `:export` AST rules we walk below.
 *
 * ── Related ────────────────────────────────────────────────────────────
 *
 * - Issue: https://github.com/cloudflare/vinext/issues/1343
 * - Ported behaviour from Next.js:
 *   .nextjs-ref/packages/next/src/build/webpack/config/blocks/css/loaders/modules.ts
 *   .nextjs-ref/test/e2e/app-dir/scss/composes-external/composes-external.test.ts
 *   .nextjs-ref/test/e2e/app-dir/scss/nm-module-nested/nm-module-nested.test.ts
 */

import path from "node:path";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import postcss from "postcss";
import type { ResolvedConfig } from "vite";
// `vite` re-exports `preprocessCSS` (see `vite/dist/node/index.d.ts`).
// It is marked `@experimental` in Vite's source but has been stable for
// many minor versions and is the canonical way to invoke Vite's CSS
// preprocessor pipeline from outside a transform hook.
import { preprocessCSS } from "vite";

// vinext ships as ESM (`"type": "module"`), so bare `require` is not
// available at runtime. Build a real CommonJS `require` anchored at this
// module's URL so we can call `require.resolve()` for bare specifiers
// (e.g. `composes: foo from 'shared/styles.module.css'`). Matches the
// pattern used by the rest of the vinext source (see uses of
// `createRequire` in src/index.ts).
const nodeRequire = createRequire(import.meta.url);

/** File extensions Vite's `preprocessCSS` knows how to handle. */
const PREPROCESSOR_EXT_RE = /\.(scss|sass|less|styl|stylus)$/i;

/** `:import("relative/path")` selector matcher used by postcss-modules. */
const IMPORT_RE = /^:import\((.+)\)$/;

/**
 * Constructor signature postcss-modules passes to a custom Loader.
 *
 *   new opts.Loader(root, plugins, opts.resolve)
 *
 * `plugins` is the array of PostCSS plugins postcss-modules built via
 * `getDefaultPluginsList(opts, inputFile)` — they emit the `:import`
 * and `:export` rules we walk below. We treat them as opaque values to
 * avoid pulling postcss type machinery into our plugin's public API.
 */
type LoaderPlugins = unknown[];
type ResolveFn = ((id: string, importer: string) => string | Promise<string>) | undefined;

/** Minimal interface postcss-modules expects from a Loader instance. */
type PostcssModulesLoader = {
  fetch(newPath: string, relativeTo: string, trace?: string): Promise<Record<string, string>>;
  readonly finalSource: string;
};

/**
 * Sort trace keys exactly the way postcss-modules' built-in
 * `FileSystemLoader` does (see `traceKeySorter`). The order determines
 * the relative position of each composed file's CSS in the final
 * concatenated output. Shorter (= earlier) traces come first, with
 * lexical fallback for equal lengths.
 */
function traceKeySorter(a: string, b: string): number {
  if (a.length < b.length) {
    return a < b.substring(0, a.length) ? -1 : 1;
  }
  if (a.length > b.length) {
    return a.substring(0, b.length) <= b ? -1 : 1;
  }
  return a < b ? -1 : 1;
}

/**
 * Build a `Loader` class suitable for `css.modules.Loader`.
 *
 * The Vite `ResolvedConfig` is captured in the closure via `getConfig`
 * (rather than being passed to the constructor) because postcss-modules
 * instantiates the Loader with a fixed signature `(root, plugins,
 * resolve)`. We need extra state, and a closure is the clean way to
 * thread it.
 */
export function createCssModulesPreprocessingLoader(
  getConfig: () => ResolvedConfig | undefined,
): new (root: string, plugins: LoaderPlugins, resolve?: ResolveFn) => PostcssModulesLoader {
  return class PreprocessingLoader implements PostcssModulesLoader {
    #root: string;
    #plugins: LoaderPlugins;
    #resolve: ResolveFn;
    /** Per-file injectable CSS, keyed by absolute file path. */
    #sources: Record<string, string> = {};
    /** Map from trace key (load order) to absolute file path. */
    #traces: Record<string, string> = {};
    /** Tokens per absolute file path, for cache + recursion. */
    #tokensByFile: Record<string, Record<string, string>> = {};
    #importNr = 0;

    constructor(root: string, plugins: LoaderPlugins, resolve?: ResolveFn) {
      this.#root = root;
      this.#plugins = plugins;
      this.#resolve = resolve;
    }

    /**
     * Resolve the requested path the same way postcss-modules' default
     * FileSystemLoader does (see `FileSystemLoader.fetch` in
     * `vite/dist/node/chunks/build.js`, postcss-modules @6.0.1).
     */
    async #resolveImportPath(newPath: string, relativeTo: string): Promise<string> {
      const unquoted = newPath.replace(/^["']|["']$/g, "");
      const useResolve = typeof this.#resolve === "function";
      const resolved = useResolve ? await this.#resolve!(unquoted, relativeTo) : undefined;
      if (resolved && !path.isAbsolute(resolved)) {
        throw new Error('The returned path from the "fileResolve" option must be absolute.');
      }
      const relativeDir = path.dirname(relativeTo);
      if (resolved) return resolved;
      // Bare module specifiers go through Node's resolver (e.g.
      // `composes: foo from 'shared/styles.module.css'`).
      if (unquoted[0] !== "." && !path.isAbsolute(unquoted)) {
        try {
          return nodeRequire.resolve(unquoted);
        } catch {
          // Fall through to the path.resolve below — matches the
          // built-in loader's behaviour of swallowing the require
          // error and trying a path-relative resolve.
        }
      }
      return path.resolve(path.resolve(this.#root, relativeDir), unquoted);
    }

    /**
     * Read the file from disk and run Vite's CSS preprocessor on it if
     * the extension calls for it. Returns plain CSS ready for PostCSS.
     */
    async #readSource(filePath: string): Promise<string> {
      const raw = await fs.readFile(filePath, "utf-8");
      if (!PREPROCESSOR_EXT_RE.test(filePath)) return raw;

      const config = getConfig();
      if (!config) return raw; // Should not happen post-configResolved.

      // `preprocessCSS` picks sass/less/stylus from the filename
      // extension and applies the user's `css.preprocessorOptions`
      // (including any `sassOptions` forwarded from `next.config`).
      const { code } = await preprocessCSS(raw, filePath, config);
      return code;
    }

    /**
     * Walk a parsed CSS root and process `:import(...)` and `:export`
     * rules the same way postcss-modules' Parser does:
     *
     *  - `:import('relative/path') { localKey: exportedKey }` rules
     *    name the file to recurse into and the symbols to alias.
     *  - `:export { localKey: scopedClass }` rules are the public
     *    output of the module.
     *
     * Both rule types are removed from the AST after processing —
     * matching `linkImportedSymbols` + `extractExports` behaviour.
     */
    async #processImportsAndExports(
      root: postcss.Root,
      relativeTo: string,
      trace: string,
    ): Promise<Record<string, string>> {
      const translations: Record<string, string> = {};
      const exportTokens: Record<string, string> = {};

      // Collect `:import` rules in declaration order so the trace keys
      // we generate match the order downstream PostCSS sees them.
      const importRules: { node: postcss.Rule; importPath: string; depNr: number }[] = [];
      let depNr = 0;
      root.each((node) => {
        if (node.type === "rule") {
          const match = node.selector.match(IMPORT_RE);
          if (match) {
            importRules.push({ node, importPath: match[1]!, depNr });
            depNr += 1;
          }
        }
      });

      // Recurse into each import, capturing exported tokens, then
      // build the local→imported translation table from the rule's
      // declarations (`localKey: exportedKey`).
      //
      // Intentional divergence from the built-in `FileSystemLoader`,
      // which fetches imports sequentially via `fetchAllImports` →
      // `Promise.all`. Each import's `depTrace` is pre-assigned from
      // the declaration's index, and each import writes to distinct
      // `translations[decl.prop]` keys, so parallel fetches are safe
      // and let independent file reads / preprocessor invocations
      // overlap. The per-file token cache (`#tokensByFile`) ensures
      // we still de-duplicate transitive imports.
      await Promise.all(
        importRules.map(async ({ node, importPath, depNr }) => {
          const depTrace = trace + String.fromCharCode(depNr);
          const imported = await this.fetch(importPath, relativeTo, depTrace);
          node.walkDecls((decl) => {
            translations[decl.prop] = imported[decl.value]!;
          });
          node.remove();
        }),
      );

      // Substitute translations into the rest of the AST. Declarations,
      // rule selectors, and at-rule params all may reference imported
      // symbols. Mirrors `icss-utils` `replaceValueSymbols`.
      const tokenRe = /[$]?[\w-]+/g;
      const substitute = (value: string): string => {
        let out = value;
        let m: RegExpExecArray | null;
        tokenRe.lastIndex = 0;
        while ((m = tokenRe.exec(out))) {
          const replacement = translations[m[0]];
          if (replacement) {
            out = out.slice(0, m.index) + replacement + out.slice(tokenRe.lastIndex);
            tokenRe.lastIndex -= m[0].length - replacement.length;
          }
        }
        return out;
      };
      root.walk((node) => {
        if (node.type === "decl" && node.value) node.value = substitute(node.value);
        else if (node.type === "rule" && node.selector) node.selector = substitute(node.selector);
        else if (node.type === "atrule" && node.params) node.params = substitute(node.params);
      });

      // Extract `:export` rules into our exportTokens map. The export
      // rule's declarations may still reference local class names that
      // got renamed by the import-translation pass above, so we apply
      // translations one more time (matching the built-in Parser's
      // `handleExport` loop).
      //
      // We use `replaceAll` with a function replacement so that:
      //   1. Every occurrence of `key` is substituted (string-pattern
      //      `replace` only handles the first match).
      //   2. `$&` / `$1` / etc. in `translations[key]` (which can contain
      //      `$` after Sass processing) are NOT interpreted as
      //      replacement-string special patterns — function replacements
      //      bypass that escaping.
      root.each((node) => {
        if (node.type === "rule" && node.selector === ":export") {
          node.each((decl) => {
            if (decl.type === "decl") {
              let value = decl.value;
              for (const key of Object.keys(translations)) {
                value = value.replaceAll(key, () => translations[key]!);
              }
              exportTokens[decl.prop] = value;
            }
          });
          node.remove();
        }
      });

      return exportTokens;
    }

    /**
     * Build a small PostCSS plugin that drives `processImportsAndExports`
     * on the AST. We use a plugin (rather than walking the result
     * directly) because the upstream plugins postcss-modules supplies
     * to us — local-by-default, scope, extract-imports, values — run
     * via PostCSS's normal pipeline. We need them to mutate the AST
     * BEFORE we walk for `:import` / `:export`, and the cleanest way
     * to enforce ordering is to append our own plugin.
     */
    #parserPlugin(
      relativeTo: string,
      trace: string,
      exportSink: Record<string, string>,
    ): postcss.Plugin {
      // oxlint-disable-next-line typescript/no-this-alias
      const self = this;
      return {
        postcssPlugin: "vinext-css-modules-parser",
        async OnceExit(root) {
          const tokens = await self.#processImportsAndExports(root, relativeTo, trace);
          for (const [k, v] of Object.entries(tokens)) exportSink[k] = v;
        },
      };
    }

    async fetch(
      newPath: string,
      relativeTo: string,
      trace?: string,
    ): Promise<Record<string, string>> {
      const effectiveTrace = trace ?? String.fromCharCode(this.#importNr++);
      const fileAbsPath = await this.#resolveImportPath(newPath, relativeTo);

      // Return cached tokens if this file has already been fetched.
      // Matches `tokensByFile` short-circuit in the built-in loader.
      const cached = this.#tokensByFile[fileAbsPath];
      if (cached) return cached;

      const sourceString = await this.#readSource(fileAbsPath);
      const exportSink: Record<string, string> = {};
      // postcss-modules-* plugins arrive opaquely typed; postcss accepts
      // any AcceptedPlugin shape at runtime.
      const plugins = [
        ...(this.#plugins as postcss.AcceptedPlugin[]),
        this.#parserPlugin(fileAbsPath, effectiveTrace, exportSink),
      ];
      const result = await postcss(plugins).process(sourceString, { from: fileAbsPath });

      this.#sources[fileAbsPath] = result.css;
      this.#traces[effectiveTrace] = fileAbsPath;
      this.#tokensByFile[fileAbsPath] = exportSink;
      return exportSink;
    }

    get finalSource(): string {
      // Concatenate per-file injectable sources in trace order, skipping
      // files we've already emitted. Mirrors `FileSystemLoader.finalSource`.
      const written = new Set<string>();
      const parts: string[] = [];
      for (const key of Object.keys(this.#traces).sort(traceKeySorter)) {
        const filename = this.#traces[key]!;
        if (written.has(filename)) continue;
        written.add(filename);
        parts.push(this.#sources[filename] ?? "");
      }
      return parts.join("");
    }
  };
}
