/**
 * vinext:edge-asset-import-meta-url
 *
 * Inlines static/blob assets referenced via `new URL("./asset", import.meta.url)`
 * (or a bare-specifier form like `new URL("my-pkg/data.json", import.meta.url)`)
 * in the Cloudflare Workers / Nitro worker build so they can be fetched at
 * runtime.
 *
 * Why this is needed
 * ------------------
 * Vite's built-in `vite:asset-import-meta-url` plugin only runs in the
 * `client` environment. Server-side code that builds an asset URL from
 * `import.meta.url` and fetches it — e.g. an edge API route:
 *
 *   const url = new URL('../../src/text-file.txt', import.meta.url)
 *   return fetch(url)
 *
 * is therefore left untransformed in the worker bundle. Worse, on Cloudflare
 * Workers `import.meta.url` is the literal string `"worker"` (not a URL), so
 * `new URL('./x', import.meta.url)` throws `TypeError: Invalid URL` and the
 * whole `edge-compiler-can-import-blob-assets` suite fails (cloudflare/vinext#1824).
 *
 * Approach
 * --------
 * Rewrite the entire `new URL("<spec>", import.meta.url)` expression to a
 * `data:` URL literal (`new URL("data:<mime>;base64,<bytes>")`) computed at
 * build time from the referenced file. A `data:` URL:
 *
 *   - is a valid absolute URL, so `new URL(...)` never throws (no dependency
 *     on the runtime value of `import.meta.url`);
 *   - can be bound to a variable and `fetch()`ed later, matching the
 *     fixture's `const url = new URL(...); return fetch(url)` pattern that the
 *     `fetch(new URL(...))`-only OG inliner (vinext:og-inline-fetch-assets)
 *     does not cover;
 *   - is fetchable in workerd, so no asset file needs to be emitted to (and
 *     served from) the worker output.
 *
 * Scope: only the bundled-worker build (Cloudflare `vite-plugin-cloudflare`
 * or Nitro), where `import.meta.url` is `"worker"`. In a plain Node SSR build
 * `import.meta.url` is already a valid `file://` URL, so rewriting to a data
 * URL there would needlessly change URL semantics — e.g.
 * `fileURLToPath(new URL(...))` throws on a `data:` URL, and `.pathname`
 * would no longer be a filesystem path. The Node SSR asset-emit path is
 * handled separately (cloudflare/vinext#1346).
 *
 * This mirrors the existing `vinext:og-inline-fetch-assets` plugin, which
 * already base64-inlines `fetch(new URL(...))` font/wasm assets for the same
 * "import.meta.url is not a URL in workerd" reason.
 *
 * Relation to #1346 / PR #1640 (vinext:server-asset-import-meta-url): that
 * (still-open) work targets the Node SSR path, where it emits the asset to
 * disk and rewrites the URL to a chunk-relative `file://` path. That strategy
 * does not work on Cloudflare Workers (no filesystem, `import.meta.url` is
 * `"worker"`), which is why the edge path inlines instead.
 *
 * Honours `/* @vite-ignore *\/` to match Vite's upstream contract.
 */

import type { Plugin } from "vite";
import path from "node:path";
import fs from "node:fs";
import { CONTENT_TYPES } from "../server/static-file-cache.js";

// Matches `new URL("<spec>", import.meta.url)` (and the optional-chained
// `import.meta?.url` form) with a quoted string literal — no template
// literals — for the spec. Both relative (`./`, `../`) and bare specifiers
// (`my-pkg/data.json`) are accepted. Only the `new URL(...)` expression is
// replaced, so a trailing accessor such as `.href` is left untouched and
// still works (it reads off the rewritten data URL).
//
// Specifiers that already look like an absolute/runtime URL are filtered out
// in the handler, not the regex.
//
// Intentionally NOT global: this object is reused as a `transform.filter`. A
// global (`/g`) regex is stateful (`lastIndex` persists across `.test()`
// calls), so the handler builds its own fresh `/g` copy via
// `new RegExp(re, "g")`.
const ASSET_IMPORT_META_URL_RE =
  /\bnew\s+URL\s*\(\s*(['"])([^'"`\n]+)\1\s*,\s*import\.meta\??\.url\s*(?:,\s*)?\)/;
const VITE_IGNORE_RE = /\/\*\s*@vite-ignore\s*\*\//;

// A few common asset extensions that `CONTENT_TYPES` (tuned for the static
// file server) does not carry but `new URL(...)` assets routinely use. The
// content type is best-effort metadata for the `data:` URL; the bytes are
// always exact, so an unknown type degrades to `application/octet-stream`.
const EXTRA_CONTENT_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
  ".csv": "text/csv",
};

function mimeTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return CONTENT_TYPES[ext] ?? EXTRA_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Create the `vinext:edge-asset-import-meta-url` Vite plugin.
 *
 * Inlines assets referenced via `new URL("<spec>", import.meta.url)` as
 * `data:` URLs so they remain fetchable on Cloudflare Workers, where
 * `import.meta.url` is the literal string `"worker"` (not a real URL).
 *
 * @param options.isWorkerTarget - Returns true when the build targets a
 *   bundled worker runtime (Cloudflare `vite-plugin-cloudflare` or Nitro).
 *   The flag is resolved during Vite's `config` hook, before
 *   `applyToEnvironment` runs, so the getter is populated by the time the
 *   gate is evaluated.
 */
export function createEdgeAssetImportMetaUrlPlugin(options: {
  isWorkerTarget: () => boolean;
}): Plugin {
  // Build-only cache: absolute resolved path -> data URL string. Dev skips the
  // cache so asset edits are picked up without a restart.
  const cache = new Map<string, string>();
  let isBuild = false;

  return {
    name: "vinext:edge-asset-import-meta-url",
    enforce: "pre",
    // Only the non-client server environments (App Router RSC/SSR, Pages
    // Router SSR) of a bundled worker build. Vite's upstream plugin already
    // covers `client`; a plain Node SSR build keeps a real `file://`
    // `import.meta.url` and must not be rewritten (see the file header).
    applyToEnvironment(environment) {
      return environment.config.consumer !== "client" && options.isWorkerTarget();
    },
    configResolved(config) {
      isBuild = config.command === "build";
    },
    buildStart() {
      if (isBuild) cache.clear();
    },
    transform: {
      filter: { code: ASSET_IMPORT_META_URL_RE },
      async handler(code, id) {
        // Virtual modules have no real filesystem path to resolve relative
        // specifiers against, so skip them.
        if (id.startsWith("\0") || id.startsWith("virtual:")) return null;

        const moduleDir = path.dirname(id.split("?")[0]!);
        const re = new RegExp(ASSET_IMPORT_META_URL_RE, "g");
        let result = "";
        let lastIndex = 0;
        let didReplace = false;
        let match: RegExpExecArray | null;

        // Read the asset (resolving bare specifiers via the bundler's
        // resolver) and return its `data:` URL, or null if it can't be
        // resolved/read — in which case the expression is left untouched.
        const toDataUrl = async (spec: string): Promise<string | null> => {
          let file: string | undefined;
          if (spec.startsWith("./") || spec.startsWith("../")) {
            // Strip any `?query`/`#hash` suffix so the path resolves to a real
            // file on disk (mirrors the bare-specifier branch, which splits on
            // `?` after resolution).
            file = path.resolve(moduleDir, spec.split(/[?#]/, 1)[0]!);
          } else {
            // Bare specifier (e.g. `my-pkg/hello/world.json`). Resolve it
            // through the bundler so node_modules assets work.
            const resolved = await this.resolve(spec, id, { skipSelf: true });
            file = resolved?.id?.split("?")[0];
          }
          if (!file) return null;

          const cached = isBuild ? cache.get(file) : undefined;
          if (cached !== undefined) return cached;

          let buffer: Buffer;
          try {
            buffer = await fs.promises.readFile(file);
          } catch {
            return null;
          }
          const dataUrl = `data:${mimeTypeFor(file)};base64,${buffer.toString("base64")}`;
          if (isBuild) cache.set(file, dataUrl);
          return dataUrl;
        };

        while ((match = re.exec(code))) {
          const fullMatch = match[0];
          const quote = match[1]!;
          const spec = match[2]!;
          const matchStart = match.index;
          const matchEnd = matchStart + fullMatch.length;

          // Skip specifiers that are already absolute/runtime URLs — these are
          // not build-time assets (e.g. `new URL("https://example.com")` is
          // matched by a separate code path, but a two-arg form pointing at an
          // absolute URL should be left alone).
          if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(spec) || spec.startsWith("//")) {
            continue;
          }

          // Honour `/* @vite-ignore */` between `new URL(` and the literal.
          const literalStart = code.indexOf(quote, matchStart);
          if (literalStart !== -1 && VITE_IGNORE_RE.test(code.slice(matchStart, literalStart))) {
            continue;
          }

          const dataUrl = await toDataUrl(spec);
          if (dataUrl === null) continue;

          if (matchStart > lastIndex) result += code.slice(lastIndex, matchStart);
          // A single-argument `new URL(<absolute>)` is enough: the data URL is
          // absolute, so no base is needed and the runtime never touches
          // `import.meta.url`.
          result += `new URL(${JSON.stringify(dataUrl)})`;
          lastIndex = matchEnd;
          didReplace = true;
        }

        if (!didReplace) return null;
        if (lastIndex < code.length) result += code.slice(lastIndex);
        return { code: result, map: null };
      },
    },
  } satisfies Plugin;
}
