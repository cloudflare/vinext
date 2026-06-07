/**
 * Pages Router SSR asset-tag helpers.
 *
 * Builds the `<link rel="modulepreload">`, `<link rel="stylesheet">`, and
 * `<script type="module">` tags injected into the SSR HTML response.
 *
 * Extracted from `entries/pages-server-entry.ts` so the logic is
 * unit-testable and lives in a normal typed module rather than a codegen
 * template string.
 */

import { createNonceAttribute } from "./html.js";

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the effective SSR manifest: prefer the caller-supplied object (dev
 * or test) and fall back to the Worker-embedded `globalThis.__VINEXT_SSR_MANIFEST__`
 * injected by `vinext:cloudflare-build` at build time.
 */
export function resolveSsrManifest(
  manifest: Record<string, string[]> | null | undefined,
): Record<string, string[]> | null {
  if (manifest && Object.keys(manifest).length > 0) return manifest;
  return (typeof globalThis !== "undefined" ? globalThis.__VINEXT_SSR_MANIFEST__ : null) ?? null;
}

/**
 * Look up the asset-file list for a module ID in the SSR manifest.
 *
 * The manifest keys may use relative paths while callers supply absolute
 * paths, so a suffix-match fallback is used when an exact-key lookup fails.
 */
export function getManifestFilesForModule(
  manifest: Record<string, string[]> | null | undefined,
  moduleId: string | null | undefined,
): string[] | null {
  if (!manifest || !moduleId) return null;

  const files = manifest[moduleId];
  if (files) return files;

  for (const key in manifest) {
    if (moduleId.endsWith("/" + key) || moduleId === key) {
      return manifest[key];
    }
  }
  return null;
}

/**
 * Find the first `.js` file in the manifest for `moduleId` and return its
 * URL-path form (with a leading `/`). Used to resolve the hydration URL for
 * the matched page or the `_app` module.
 */
export function resolveClientModuleUrl(
  manifest: Record<string, string[]> | null | undefined,
  moduleId: string | null | undefined,
): string | undefined {
  const files = getManifestFilesForModule(resolveSsrManifest(manifest), moduleId);
  if (!files) return undefined;
  for (let i = 0; i < files.length; i++) {
    let file = files[i];
    if (!file || !file.endsWith(".js")) continue;
    if (file.charAt(0) !== "/") file = "/" + file;
    return file;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// collectAssetTags
// ---------------------------------------------------------------------------

type CollectAssetTagsOptions = {
  /**
   * SSR manifest mapping module file paths to their associated asset list.
   * When empty/null the Worker-embedded `__VINEXT_SSR_MANIFEST__` is used.
   */
  manifest: Record<string, string[]> | null | undefined;
  /**
   * Module IDs whose assets should be injected (page + `_app`). When empty
   * all manifest assets are injected.
   */
  moduleIds: (string | null | undefined)[];
  /** Script nonce for CSP. */
  scriptNonce?: string;
  /**
   * When `false` (default), page scripts are emitted with the `defer`
   * attribute mirroring Next.js's `experimental.disableOptimizedLoading`
   * default.
   */
  disableOptimizedLoading: boolean;
};

/**
 * Build the HTML `<link>` and `<script>` tag string for the SSR response.
 *
 * Mirrors Next.js `_document` behaviour:
 * - CSS files → `<link rel="stylesheet">`.
 * - JS files → `<link rel="modulepreload">` + `<script type="module" defer>`.
 * - Lazy chunks (behind `React.lazy` / `next/dynamic`) are skipped.
 * - The Worker-embedded client-entry bootstrap (`__VINEXT_CLIENT_ENTRY__`) is
 *   injected first so hydration starts as early as possible.
 * - Shared framework / vinext runtime chunks are always included alongside
 *   page-specific chunks.
 *
 * Extracted from `entries/pages-server-entry.ts`.
 */
export function collectAssetTags(options: CollectAssetTagsOptions): string {
  const m = resolveSsrManifest(options.manifest);
  const tags: string[] = [];
  const seen = new Set<string>();
  const nonceAttr = createNonceAttribute(options.scriptNonce);
  // Mirrors Next.js `_document` behaviour: when `experimental.disableOptimizedLoading`
  // is false (the default), page scripts are emitted with `defer` in <head>. See
  // .nextjs-ref/packages/next/src/pages/_document.tsx getScripts().
  // vinext always emits `type="module"` (which already defers implicitly), but
  // upstream tests (e.g. test/e2e/optimized-loading) assert the literal `defer`
  // attribute, and adding it preserves parity without changing browser behaviour.
  const deferAttr = options.disableOptimizedLoading ? "" : " defer";

  // Load the set of lazy chunk filenames (only reachable via dynamic imports).
  // These should NOT get <link rel="modulepreload"> or <script type="module">
  // tags — they are fetched on demand when the dynamic import() executes.
  const lazyChunks =
    (typeof globalThis !== "undefined" && globalThis.__VINEXT_LAZY_CHUNKS__) || null;
  const lazySet = lazyChunks && lazyChunks.length > 0 ? new Set(lazyChunks) : null;

  // Inject the client entry script if embedded by vinext:cloudflare-build.
  if (typeof globalThis !== "undefined" && globalThis.__VINEXT_CLIENT_ENTRY__) {
    const entry = globalThis.__VINEXT_CLIENT_ENTRY__;
    seen.add(entry);
    tags.push('<link rel="modulepreload"' + nonceAttr + ' href="/' + entry + '" />');
    tags.push(
      '<script type="module"' +
        deferAttr +
        nonceAttr +
        ' src="/' +
        entry +
        '" crossorigin></script>',
    );
  }

  if (m) {
    const allFiles: string[] = [];
    const moduleIds = options.moduleIds;

    if (moduleIds && moduleIds.length > 0) {
      // Collect assets for the requested page modules.
      for (let mi = 0; mi < moduleIds.length; mi++) {
        const id = moduleIds[mi];
        const files = getManifestFilesForModule(m, id);
        if (files) {
          for (let fi = 0; fi < files.length; fi++) allFiles.push(files[fi]);
        }
      }

      // Also inject shared chunks that every page needs: framework,
      // vinext runtime, and the entry bootstrap. These are identified
      // by scanning all manifest values for chunk filenames containing
      // known prefixes.
      for (const key in m) {
        const vals = m[key];
        if (!vals) continue;
        for (let vi = 0; vi < vals.length; vi++) {
          const file = vals[vi];
          const basename = file.split("/").pop() || "";
          if (
            basename.startsWith("framework-") ||
            basename.startsWith("vinext-") ||
            basename.includes("vinext-client-entry") ||
            basename.includes("vinext-app-browser-entry")
          ) {
            allFiles.push(file);
          }
        }
      }
    } else {
      // No specific modules — include all assets from manifest.
      for (const akey in m) {
        const avals = m[akey];
        if (avals) {
          for (let ai = 0; ai < avals.length; ai++) allFiles.push(avals[ai]);
        }
      }
    }

    for (let ti = 0; ti < allFiles.length; ti++) {
      let tf = allFiles[ti];
      // Normalize: Vite's SSR manifest values include a leading '/'
      // (from base path), but we prepend '/' ourselves when building
      // href/src attributes. Strip any existing leading slash to avoid
      // producing protocol-relative URLs like "//assets/chunk.js".
      if (tf.charAt(0) === "/") tf = tf.slice(1);
      if (seen.has(tf)) continue;
      seen.add(tf);
      if (tf.endsWith(".css")) {
        tags.push('<link rel="stylesheet"' + nonceAttr + ' href="/' + tf + '" />');
      } else if (tf.endsWith(".js")) {
        // Skip lazy chunks — they are behind dynamic import() boundaries
        // (React.lazy, next/dynamic) and should only be fetched on demand.
        if (lazySet && lazySet.has(tf)) continue;
        tags.push('<link rel="modulepreload"' + nonceAttr + ' href="/' + tf + '" />');
        tags.push(
          '<script type="module"' +
            deferAttr +
            nonceAttr +
            ' src="/' +
            tf +
            '" crossorigin></script>',
        );
      }
    }
  }

  return tags.join("\n  ");
}
