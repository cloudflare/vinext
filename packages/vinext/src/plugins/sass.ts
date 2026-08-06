/**
 * Map a Next.js `sassOptions` object onto Vite's
 * `css.preprocessorOptions.scss` / `.sass` shape.
 *
 * Next.js (webpack + sass-loader) accepts:
 * - `additionalData` (or legacy `prependData`) — prepended to every source
 * - `includePaths` — directories searched by `@import`
 * - `loadPaths`    — modern Sass equivalent of `includePaths`
 * - `implementation` — Sass implementation package name (e.g. `sass-embedded`)
 * - other Sass options that get forwarded as-is
 *
 * Reference (Next.js source — destructures the same keys before forwarding
 * the rest to sass-loader):
 *   .nextjs-ref/packages/next/src/build/webpack/config/blocks/css/index.ts#L150-L180
 *   https://github.com/vercel/next.js/blob/canary/packages/next/src/build/webpack/config/blocks/css/index.ts
 *
 * Vite expects:
 * - `additionalData` (string or function) on the preprocessor options
 * - modern Sass options (`loadPaths`, `importers`, `implementation`, …)
 *   flattened next to `additionalData`
 *
 * @see https://vite.dev/config/shared-options.html#css-preprocessoroptions
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path, { toSlash } from "pathslash";
import { fileURLToPath, pathToFileURL } from "node:url";
import { preprocessCSS, type PreprocessCSSResult, type ResolvedConfig } from "vite";
import { markCssUrlAssetReferences, rebaseCssUrlAssetReferences } from "../build/css-url-assets.js";

type AdditionalData = string | ((source: string, filename: string) => string | Promise<string>);

type VitePreprocessorOptions = {
  additionalData?: AdditionalData;
  loadPaths?: string[];
  // oxlint-disable-next-line typescript/no-explicit-any
  [key: string]: any;
};

/**
 * Create a Sass `FileImporter` that resolves webpack-style tilde (`~`) imports.
 *
 * Next.js (via sass-loader's `webpackImporter`) supports two tilde forms:
 *
 * 1. `~pkg/path` — resolves `pkg/path` from `node_modules`. Used for
 *    third-party SCSS/CSS, e.g. `@import '~nprogress/nprogress.css'`.
 *
 * 2. `~/path` — resolves relative to the **project root** (the `~` acts as
 *    an alias for the root). Used with Turbopack's `resolveAlias: { '~*': '*' }`
 *    convention, e.g. `@use '~/styles/variables' as *`.
 *
 * Vite's built-in Sass resolver does not strip the `~` prefix, so any SCSS
 * that uses tilde imports fails with "Can't find stylesheet to import" errors.
 * This `FileImporter` runs before Vite's internal importer (added at the end
 * of `importers[]` in the vite:css plugin) and canonicalises tilde URLs so
 * Sass can load them from the filesystem.
 *
 * The returned object implements the modern Sass `FileImporter` interface:
 * `findFileUrl` returns a `file://` URL and Sass automatically handles partial
 * resolution (`_variables.scss` for `variables`), index files, and extensions.
 *
 * @param root - Absolute path to the Vite project root (used as the base for
 *   `~/path` resolution and for locating `node_modules`).
 */
export function createSassTildeImporter(root: string): { findFileUrl(url: string): URL | null } {
  // Base URL for root-relative (~/) imports. Must end with "/" so new URL()
  // treats it as a directory and resolves relative paths correctly.
  const rootBaseUrl = pathToFileURL(root.endsWith("/") ? root : root + "/");

  // Base URL for node_modules imports. The trailing "/" is critical for
  // new URL(spec, base) to keep the spec as a relative path inside the dir.
  const nodeModulesBaseUrl = pathToFileURL(path.join(root, "node_modules") + "/");

  return {
    findFileUrl(url: string): URL | null {
      if (!url.startsWith("~")) return null;

      const stripped = url.slice(1); // Remove the leading "~"

      if (stripped.startsWith("/")) {
        // Form: ~/path/to/file  →  root-relative
        // stripped = "/path/to/file", we want "<root>/path/to/file"
        // Slice the leading "/" to make it a relative-to-base URL.
        return new URL(stripped.slice(1), rootBaseUrl);
      }

      if (!stripped) {
        // Bare "~" with nothing after it — not a valid import, skip.
        return null;
      }

      // Form: ~pkg/path  →  node_modules resolution
      // Try the simple path first: root/node_modules/pkg/path
      const simpleResolved = new URL(stripped, nodeModulesBaseUrl);

      // Verify the package directory exists in root's node_modules before
      // returning; if not found there, fall back to Node.js module resolution
      // which walks up the directory tree (handles hoisted pnpm graphs, etc.).
      const pkgName = stripped.startsWith("@")
        ? stripped.split("/").slice(0, 2).join("/")
        : (stripped.split("/")[0] ?? "");

      const directPkgDir = path.join(root, "node_modules", pkgName);
      if (pkgName && fs.existsSync(directPkgDir)) {
        // Fast path: package is at root/node_modules/<pkg>
        return simpleResolved;
      }

      // Slow path: use Node.js module resolution to locate the package.
      // This handles pnpm's virtual store layout, yarn PnP, and workspaces
      // where packages aren't necessarily at <root>/node_modules/<pkg>.
      const req = createRequire(path.join(root, "package.json"));
      try {
        const pkgJsonPath = req.resolve(`${pkgName}/package.json`);
        const pkgDir = path.dirname(pkgJsonPath);
        // Build the URL by replacing the package-name segment with the
        // resolved absolute package directory path.
        const afterPkg = stripped.startsWith("@")
          ? stripped.split("/").slice(2).join("/")
          : stripped.split("/").slice(1).join("/");
        const resolvedPath = afterPkg ? path.join(pkgDir, afterPkg) : pkgDir;
        return pathToFileURL(resolvedPath);
      } catch {
        // Package not found via Node.js resolution either — let Sass/Vite's
        // default resolver handle (or report an error for) this import.
        return null;
      }
    },
  };
}

type SassLoadedStylesheet = {
  contents: string;
  syntax: "scss" | "indented" | "css";
};

function sassStylesheetCandidates(importPath: string): string[] {
  const extension = path.extname(importPath);
  const directory = path.dirname(importPath);
  const basename = path.basename(importPath, extension);
  const candidates: string[] = [];
  const extensions = extension ? [extension] : [".scss", ".sass", ".css"];

  for (const candidateExtension of extensions) {
    const basePath = extension ? importPath : `${importPath}${candidateExtension}`;
    candidates.push(basePath);
    candidates.push(path.join(directory, `_${basename}${candidateExtension}`));
  }
  for (const candidateExtension of extensions) {
    candidates.push(path.join(importPath, `index${candidateExtension}`));
    candidates.push(path.join(importPath, `_index${candidateExtension}`));
  }
  return candidates;
}

function deriveSassNamespace(importUrl: string): string {
  const normalized = toSlash(importUrl).replace(/\/$/, "");
  const parts = normalized.split("/");
  let basename = parts.pop() ?? "stylesheet";
  basename = basename.replace(/^_/, "").replace(/\..*$/, "");
  if (basename === "index" && parts.length > 0) {
    basename = (parts.pop() ?? basename).replace(/^_/, "").replace(/\..*$/, "");
  }
  return basename;
}

/**
 * Preserve source-asset provenance for `url()` references inside imported Sass
 * partials. Vite's transform hook only sees the entry stylesheet after Sass has
 * flattened its imports, at which point relative URLs from a partial have lost
 * the partial's source filename. Marking the partial before compilation keeps
 * byte-identical assets associated with their original basenames.
 */
export function createSassCssUrlAssetImporter(): {
  canonicalize(url: string): URL | null;
  load(canonicalUrl: URL): SassLoadedStylesheet | null;
  rewriteImports(source: string, filename: string): string;
} {
  const markedStylesheets = new Map<string, SassLoadedStylesheet>();
  const importUrlPrefix = "vinext-css-url-asset:";

  const prepareStylesheet = (
    filename: string,
    entryDirectory: string,
  ): SassLoadedStylesheet | null => {
    const contents = fs.readFileSync(filename, "utf8");
    const rebased =
      rebaseCssUrlAssetReferences(contents, path.dirname(filename), entryDirectory) ?? contents;
    const marked = markCssUrlAssetReferences(rebased, filename);
    if (marked === null) return null;
    const extension = path.extname(filename).toLowerCase();
    return {
      contents: rewriteImports(marked, filename, entryDirectory),
      syntax: extension === ".sass" ? "indented" : extension === ".css" ? "css" : "scss",
    };
  };

  const rewriteImports = (
    source: string,
    filename: string,
    entryDirectory = path.dirname(filename),
  ): string =>
    source.replace(
      /(@(import|use|forward)\s+)(["'])(\.[^"']+)\3([^;]*;?)/g,
      (
        match,
        prefix: string,
        rule: "import" | "use" | "forward",
        quote: string,
        importUrl: string,
        suffix: string,
      ) => {
        const importPath = path.resolve(path.dirname(filename), importUrl);
        for (const candidate of sassStylesheetCandidates(importPath)) {
          if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) continue;
          const prepared = prepareStylesheet(candidate, entryDirectory);
          if (prepared === null) return match;
          markedStylesheets.set(candidate, prepared);
          const namespace =
            rule === "use" && !/\bas\s+(?:\*|[-\w]+)/.test(suffix)
              ? ` as ${deriveSassNamespace(importUrl)}`
              : "";
          return `${prefix}${quote}${importUrlPrefix}${encodeURIComponent(candidate)}${quote}${namespace}${suffix}`;
        }
        return match;
      },
    );

  return {
    canonicalize(url) {
      if (!url.startsWith(importUrlPrefix)) return null;
      return pathToFileURL(decodeURIComponent(url.slice(importUrlPrefix.length)));
    },

    load(canonicalUrl) {
      return markedStylesheets.get(toSlash(fileURLToPath(canonicalUrl))) ?? null;
    },

    rewriteImports,
  };
}

export function buildSassPreprocessorOptions(
  sassOptions: Record<string, unknown> | null | undefined,
): VitePreprocessorOptions | undefined {
  if (!sassOptions || typeof sassOptions !== "object") return undefined;

  const {
    prependData,
    additionalData,
    includePaths,
    loadPaths,
    // oxlint-disable-next-line typescript/no-explicit-any
    ...rest
  } = sassOptions as Record<string, unknown>;

  const out: VitePreprocessorOptions = { ...rest };

  // Next.js forwards `sassPrependData || sassAdditionalData` to sass-loader's
  // `additionalData` (truthy-OR, see
  // .nextjs-ref/packages/next/src/build/webpack/config/blocks/css/index.ts:178),
  // so falsy values like `prependData: ""` fall through to `additionalData`.
  // Mirror that precedence exactly so users migrating from Next.js 12
  // (`prependData`) continue to work.
  const data = prependData || additionalData;
  if (typeof data === "string" || typeof data === "function") {
    out.additionalData = data as AdditionalData;
  }

  // Merge legacy `includePaths` into modern `loadPaths`. Modern Sass dropped
  // `includePaths` in favour of `loadPaths`; Vite uses the modern API, so we
  // alias for users who still configure the legacy name.
  const mergedLoadPaths: string[] = [];
  if (Array.isArray(loadPaths)) {
    for (const p of loadPaths) if (typeof p === "string") mergedLoadPaths.push(p);
  }
  if (Array.isArray(includePaths)) {
    for (const p of includePaths) if (typeof p === "string") mergedLoadPaths.push(p);
  }
  if (mergedLoadPaths.length > 0) {
    out.loadPaths = mergedLoadPaths;
  }

  // If nothing useful was extracted, signal "no override needed" so callers
  // can skip injecting an empty preprocessorOptions object.
  if (Object.keys(out).length === 0) return undefined;

  return out;
}

// ── Sass-aware CSS Modules Loader ─────────────────────────────────────────────
//
// postcss-modules' built-in FileSystemLoader reads files referenced by
// `composes: className from './other.module.scss'` as raw text and runs
// them through PostCSS's CSS-module scoping plugins directly — without Sass
// preprocessing.  For `.scss`/`.sass` files this leaves SCSS variables
// (`$var: red;`) and bare `@import 'file.scss'` directives in the CSS output,
// which then causes LightningCSS to fail during the production minification
// step ("Invalid empty selector").
//
// The fix: provide a custom `Loader` class via `css.modules.Loader` in the
// Vite config.  The custom Loader uses Vite's `preprocessCSS` for every
// file referenced by `composes:` so that Sass preprocessing (for `.scss`/
// `.sass`) runs before the CSS-module scoping step.  `preprocessCSS` is
// marked @experimental in Vite but has been stable in practice across Vite
// 5/6/7.
//
// Relates to: https://github.com/cloudflare/vinext/issues/1825
//
// Reference: https://vite.dev/guide/api-javascript#preprocesscss

/**
 * Sort key comparator used by postcss-modules' FileSystemLoader to determine
 * the order in which dependency CSS is prepended to the output.
 * Mirrors the original `traceKeySorter` from postcss-modules source.
 */
function traceKeySorter(a: string, b: string): number {
  if (a.length < b.length) return a < b.substring(0, a.length) ? -1 : 1;
  if (a.length > b.length) return a.substring(0, b.length) <= b ? -1 : 1;
  return a < b ? -1 : 1;
}

/**
 * Mirrors Vite's internal `cssModuleRE` (`/\.module\.(css|less|sass|scss|…)/`).
 *
 * postcss-modules treats *every* `composes: x from './file'` dependency as a
 * CSS module regardless of its filename, but Vite's pipeline only applies
 * CSS-module scoping to `*.module.*` files. When a dependency is not named
 * `*.module.*` (e.g. `composes: x from './plain.css'`), we hand
 * `preprocessCSS` a virtual `*.module.*` filename (same directory, so Sass
 * imports and relative resolution are unaffected) so the dependency's classes
 * are scoped and its export tokens extracted — matching what postcss-modules'
 * built-in `FileSystemLoader` did.
 */
const CSS_MODULE_RE = /\.module\.\w+$/;

/**
 * Sass-aware replacement for postcss-modules' `FileSystemLoader`.
 *
 * Implements the same constructor + `fetch` + `finalSource` interface that
 * postcss-modules calls when resolving `composes: className from 'file'`
 * dependencies.
 *
 * For every dependency file, Vite's `preprocessCSS` is used so that:
 * - `.scss`/`.sass` files are compiled through Sass *before* CSS-module
 *   scoping runs (fixing the "Invalid empty selector" LightningCSS crash).
 * - `.module.css` and `.module.scss` files have their class names scoped and
 *   export tokens extracted in exactly the same way as the top-level file.
 *
 * Failure handling: a missing Sass implementation is downgraded to a logged
 * warning and an empty token map so the build continues (class composition
 * will be incomplete); any other preprocessing error (e.g. a syntax error in
 * the composed dependency) propagates and fails the build, matching the
 * built-in `FileSystemLoader`. When no resolved config has been bound —
 * only reachable if the Loader is used outside vinext's `configResolved`
 * wiring — the Loader silently returns an empty token map.
 *
 * Recursion boundary: nested `composes` chains are handled by delegating to
 * `preprocessCSS`, which re-applies postcss-modules (and therefore this
 * Loader) for each dependency — every composed subtree gets its own inner
 * Loader instance rather than sharing this instance's `tokensByFile`/
 * `sources` state. Two intentional consequences, versus the built-in
 * single-loader recursion:
 * - A dependency reached from two sibling `composes` branches is inlined
 *   once per subtree; the duplicate identical rules are collapsed by
 *   LightningCSS during minification (bloat-free in practice, but the
 *   pre-minification CSS differs from the built-in loader's single pass).
 * - Circular `composes` chains are not short-circuited across the
 *   `preprocessCSS` boundary (the built-in loader's shared cache caught
 *   them). Cycles are invalid CSS-module inputs — webpack/Next.js errors on
 *   them too — so no cycle bookkeeping is layered on here.
 *
 * Not exported directly: postcss-modules constructs the Loader itself with a
 * fixed `(root, plugins, fileResolve)` signature, so the resolved Vite config
 * cannot be a constructor argument. `createSassAwareFileSystemLoader` returns
 * a subclass with the config bound per factory call (i.e. per vinext plugin
 * instance) instead of a module-level singleton, so multiple builds in one
 * process (monorepos, programmatic multi-build runners) each preprocess
 * `composes` dependencies with their own root/sass options/scoped-name
 * generator.
 */
class SassAwareFileSystemLoader {
  readonly root: string;
  private readonly fileResolve:
    | ((newPath: string, relativeTo: string) => Promise<string>)
    | undefined;
  private readonly sources: Record<string, string>;
  private readonly traces: Record<string, string>;
  private importNr: number;
  private readonly tokensByFile: Record<string, Record<string, string>>;

  constructor(
    root: string,
    // The `plugins` parameter is the postcss-modules plugin list; passed by
    // postcss-modules but not needed here since we delegate to `preprocessCSS`.
    _plugins: unknown[],
    fileResolve?: (newPath: string, relativeTo: string) => Promise<string>,
  ) {
    if (root === "/" && process.platform === "win32") {
      const cwdDrive = process.cwd().slice(0, 3);
      if (!/^[A-Za-z]:\\$/.test(cwdDrive))
        throw new Error(`Failed to obtain root from "${process.cwd()}".`);
      root = cwdDrive;
    }
    this.root = root;
    this.fileResolve = fileResolve;
    this.sources = {};
    this.traces = {};
    this.importNr = 0;
    this.tokensByFile = {};
  }

  /**
   * The resolved Vite config used to preprocess `composes` dependencies.
   * The base implementation has no config (`fetch` silently returns empty
   * tokens); `createSassAwareFileSystemLoader` overrides this with the
   * config bound to that factory call.
   */
  protected getResolvedConfig(): ResolvedConfig | null {
    return null;
  }

  async fetch(
    _newPath: string,
    relativeTo: string,
    _trace?: string,
  ): Promise<Record<string, string>> {
    const newPath = _newPath.replace(/^["']|["']$/g, "");
    const trace = _trace ?? String.fromCharCode(this.importNr++);

    const useFileResolve = typeof this.fileResolve === "function";
    const fileResolvedPath = useFileResolve
      ? await this.fileResolve(newPath, relativeTo)
      : undefined;

    if (fileResolvedPath !== undefined && !path.isAbsolute(fileResolvedPath)) {
      throw new Error('The returned path from the "fileResolve" option must be absolute.');
    }

    const relativeDir = path.dirname(relativeTo);
    const fileRelativePath =
      fileResolvedPath ??
      (() => {
        let resolved = path.resolve(path.resolve(this.root, relativeDir), newPath);
        // Handle bare package imports (e.g. `composes: foo from 'pkg/styles.css'`).
        if (!useFileResolve && newPath[0] !== "." && !path.isAbsolute(newPath)) {
          try {
            // Resolve bare specifiers via Node's module algorithm,
            // rooted at this module's URL so the lookup traverses
            // the project's node_modules tree.
            resolved = createRequire(import.meta.url).resolve(newPath);
          } catch {
            // ignore — bare specifier may not be a Node package
          }
        }
        return resolved;
      })();

    const cached = this.tokensByFile[fileRelativePath];
    if (cached) return cached;

    const config = this.getResolvedConfig();
    // Reading the file up front (rather than inside the try below) preserves
    // the original FileSystemLoader contract: a missing/unreadable dependency
    // rejects and fails the build.
    const rawSource = await fs.promises.readFile(fileRelativePath, "utf-8");

    if (config) {
      try {
        // postcss-modules scopes every `composes` dependency, but Vite's
        // pipeline only scopes `*.module.*` filenames — virtually rename
        // other deps (e.g. `composes: x from './plain.css'`) so they are
        // scoped too. Extensionless deps (`composes: x from './plain'`)
        // get a virtual `.module.css` suffix: the built-in FileSystemLoader
        // piped their raw text through the CSS-module scoping plugins as
        // CSS, so plain CSS is the parity-preserving interpretation. See
        // `CSS_MODULE_RE` above.
        const ext = path.extname(fileRelativePath);
        const preprocessFilename = CSS_MODULE_RE.test(fileRelativePath)
          ? fileRelativePath
          : ext === ""
            ? `${fileRelativePath}.module.css`
            : `${fileRelativePath.slice(0, -ext.length)}.module${ext}`;

        // `preprocessCSS` handles Sass compilation (for .scss/.sass) AND
        // postcss-modules scoping in one shot, using the same resolved
        // config as the main Vite build so hashes and scoped-name
        // generation are consistent.
        const result: PreprocessCSSResult = await preprocessCSS(
          rawSource,
          preprocessFilename,
          config,
        );
        const exportTokens: Record<string, string> = result.modules ?? {};

        this.sources[fileRelativePath] = result.code;
        this.traces[trace] = fileRelativePath;
        this.tokensByFile[fileRelativePath] = exportTokens;
        return exportTokens;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Only downgrade a missing Sass implementation ("Preprocessor
        // dependency \"sass-embedded\" not found...") to a warning: that is
        // an environment problem the user can fix without touching their
        // styles, and crashing would take down builds that never hit the
        // Sass path at runtime. Anything else (e.g. a syntax error in the
        // composed dependency) failed the build with postcss-modules'
        // built-in FileSystemLoader too — keep failing loudly rather than
        // shipping a green build with silently-missing classes.
        if (!message.includes("Preprocessor dependency")) throw error;
        config.logger.warn(
          `[vinext] Failed to preprocess \`composes\` dependency ${fileRelativePath}: ` +
            `${message}. ` +
            `Classes composed from this file will be missing from the build output.`,
        );
      }
    }

    // Fallback when a missing Sass implementation was downgraded to a warning
    // above, or the resolved config has not been provided (only reachable
    // when the Loader is used outside vinext's `configResolved` wiring).
    // Record empty source/tokens; class composition will be incomplete but
    // the build will not crash.
    this.sources[fileRelativePath] = "";
    this.traces[trace] = fileRelativePath;
    this.tokensByFile[fileRelativePath] = {};
    return {};
  }

  get finalSource(): string {
    const { traces, sources } = this;
    const written = new Set<string>();
    return Object.keys(traces)
      .sort(traceKeySorter)
      .map((key) => {
        const filename = traces[key];
        if (!filename || written.has(filename)) return null;
        written.add(filename);
        return sources[filename];
      })
      .join("");
  }
}

/**
 * Create a per-build binding of {@link SassAwareFileSystemLoader}.
 *
 * Returns:
 * - `Loader` — a class to inject as postcss-modules' `css.modules.Loader`
 *   option. postcss-modules instantiates it with the fixed
 *   `(root, plugins, fileResolve)` signature, so the resolved Vite config is
 *   captured in this factory's closure rather than passed to the constructor.
 * - `setResolvedConfig` — called from vinext's `configResolved` hook to bind
 *   that build's resolved config.
 *
 * One binding is created per vinext plugin instance, so concurrent or
 * back-to-back builds in a single process never observe another build's
 * config (root, sass options, `generateScopedName`, logger, …).
 */
export function createSassAwareFileSystemLoader(): {
  Loader: new (
    root: string,
    plugins: unknown[],
    fileResolve?: (newPath: string, relativeTo: string) => Promise<string>,
  ) => {
    fetch(newPath: string, relativeTo: string, trace?: string): Promise<Record<string, string>>;
    readonly finalSource: string;
  };
  setResolvedConfig: (config: ResolvedConfig) => void;
} {
  let resolvedConfig: ResolvedConfig | null = null;

  return {
    Loader: class extends SassAwareFileSystemLoader {
      protected override getResolvedConfig(): ResolvedConfig | null {
        return resolvedConfig;
      }
    },
    setResolvedConfig(config: ResolvedConfig): void {
      resolvedConfig = config;
    },
  };
}
