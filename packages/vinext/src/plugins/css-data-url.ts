/**
 * vinext CSS data URL plugin
 *
 * Rewrites `data:text/css,...` and `data:text/css+module,...` imports so the
 * usual Vite CSS pipeline (LightningCSS, CSS modules, asset extraction) can
 * process them.
 *
 * ## Background
 *
 * Turbopack supports importing inline CSS via data URLs:
 *
 *   import styles from 'data:text/css+module,.home{font-weight:700}'
 *
 * The `text/css+module` MIME variant marks the import as a CSS module so
 * Turbopack returns the class-name map (`styles.home`) rather than a raw
 * stylesheet. Plain `text/css` returns the stylesheet's side-effect import.
 *
 * Vite/Rolldown does not recognise either form. Rolldown's resolver treats
 * `data:` specifiers as external (passed through verbatim to the output),
 * so `resolveId` hooks never see them. The literal `data:text/css+module,...`
 * string ends up in the bundled output, where Node and `workerd` fail with
 * `ERR_UNKNOWN_MODULE_FORMAT: Unknown module format: text/css+module`. This
 * breaks the entire build for projects that adopt the Turbopack-only syntax
 * (see issue #1363).
 *
 * Next.js itself only honours these imports under Turbopack; the official
 * test (`test/e2e/app-dir/css-modules-data-urls/`) skips outside
 * `IS_TURBOPACK_TEST`. vinext aims to match Turbopack behaviour here so apps
 * authored against the Next.js 16+ App Router build cleanly.
 *
 * ## Strategy
 *
 * Because Rolldown short-circuits `data:` specifiers before plugin
 * resolution, we cannot intercept them via `resolveId`. Instead we run a
 * pre-transform that rewrites the source: every `import ... from
 * 'data:text/css[+module],...'` (and the `import 'data:text/css,...'`
 * side-effect form) is replaced with an import of a synthetic
 * `\0vinext-data-css/<sha1>.module.css` (or `.css`) specifier. The synthetic
 * id ends in `.module.css` / `.css` so Vite's `vite:css` plugin matches it
 * via its `CSS_LANGS_RE` / `cssModuleRE` filters and the normal CSS pipeline
 * takes over.
 *
 * `resolveId` then claims those synthetic ids (Vite's resolver won't
 * recognise them on its own because they don't exist on disk), and `load`
 * returns the decoded CSS payload. From there Vite's CSS-modules and
 * LightningCSS pipeline owns the rest: class-name hashing, JS export map
 * generation, and stylesheet asset emission.
 *
 * The decoded payload is cached by synthetic id so subsequent transforms
 * (e.g. across the RSC, SSR, and client environments) reuse the same
 * virtual module, mirroring how Vite deduplicates real CSS imports.
 */

import type { Plugin } from "vite";
import { createHash } from "node:crypto";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Virtual module prefix. The leading `\0` is the Rollup/Vite convention for
 * synthetic ids; it suppresses on-disk lookups and signals to other plugins
 * that the module is virtual. The `.module.css` / `.css` suffix is required so
 * Vite's built-in `vite:css` plugin matches the id via its `CSS_LANGS_RE` /
 * `cssModuleRE` filters.
 */
const VIRTUAL_PREFIX = "\0vinext-data-css/";

/**
 * Matches a CSS data URL string anywhere in source code. The match is bounded
 * by the surrounding string quotes (`'` or `"`) so we only rewrite literal
 * import specifiers, never identifiers or comments that happen to contain
 * `data:text/css`. The closing quote uses a backreference (`\1`) to the
 * opening quote, so mixed-quote spans cannot match accidentally.
 *
 * Groups:
 *   1. opening quote (preserved on output; the closing quote is `\1`)
 *   2. `+module` MIME suffix, or empty for plain stylesheets
 *   3. `;base64` flag, or empty for percent-encoded payloads
 *   4. encoded CSS payload
 */
const DATA_URL_IMPORT_RE = /(['"])data:text\/css(\+module)?(;base64)?,([\s\S]*?)\1/g;

/** Quick filter for sources that contain at least one CSS data URL. */
const DATA_URL_HINT = "data:text/css";

// ── Helpers ───────────────────────────────────────────────────────────────────

type DataCssEntry = {
  /** Decoded CSS source. */
  readonly css: string;
  /** Whether the import was tagged `+module` (CSS-module class-map export). */
  readonly isModule: boolean;
};

function decode(payload: string, isBase64: boolean): string {
  if (isBase64) return Buffer.from(payload, "base64").toString("utf8");
  // Percent-decoding matches RFC 3986. Turbopack/Next.js author CSS data URLs
  // as plain text so `decodeURIComponent` is the right call; if a future
  // encoder emits raw `%` characters the import would have been malformed
  // anyway and `decodeURIComponent` will surface that as a `URIError`.
  return decodeURIComponent(payload);
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export function dataUrlCssPlugin(): Plugin {
  // Maps synthetic id → decoded payload. Shared across all environments so a
  // data URL imported from both an RSC and a client module collapses to the
  // same virtual file, matching how Vite deduplicates real CSS imports.
  const entries = new Map<string, DataCssEntry>();

  return {
    name: "vinext:css-data-url",
    // Run before `vite:resolve`, `vite:import-analysis`, and `vite:css` so the
    // rewrite happens on raw user code, before any other plugin observes the
    // unsupported `data:` import.
    enforce: "pre",

    transform(code, id) {
      // Cheap pre-check so we don't run the regex on every module in the
      // graph. Skip the CSS pipeline itself: synthetic ids round-trip through
      // `transform`, but their decoded payload never contains a quoted import.
      if (!code.includes(DATA_URL_HINT)) return null;
      if (id.startsWith(VIRTUAL_PREFIX)) return null;

      let mutated = false;
      const rewritten = code.replace(
        DATA_URL_IMPORT_RE,
        (_match, quote: string, moduleFlag, base64Flag, payload) => {
          const isModule = moduleFlag === "+module";
          const isBase64 = base64Flag === ";base64";

          let css: string;
          try {
            css = decode(payload, isBase64);
          } catch (err) {
            // Surface as a transform error so the developer sees which file
            // contained the malformed data URL.
            throw new Error(
              `[vinext] Failed to decode CSS data URL import in ${id}: ${(err as Error).message}`,
            );
          }

          const ext = isModule ? ".module.css" : ".css";
          const syntheticId = `${VIRTUAL_PREFIX}${hash(css + ext)}${ext}`;
          entries.set(syntheticId, { css, isModule });
          mutated = true;
          // The same quote character is reused for both ends so the rewritten
          // span is a syntactically valid string literal that matches the
          // span being replaced (single↔single or double↔double).
          return `${quote}${syntheticId}${quote}`;
        },
      );

      if (!mutated) return null;
      // No source map: we only swap the import specifier text and never
      // shift line counts (the synthetic id is a single-line string), so the
      // rewritten code keeps the original line/column positions. Returning a
      // map would force every downstream plugin to honour it without
      // information gain.
      return { code: rewritten, map: null };
    },

    resolveId(id) {
      // Claim the synthetic ids so Vite's resolver doesn't try (and fail)
      // to find them on disk. Returning the id as-is lets `load` see it.
      if (id.startsWith(VIRTUAL_PREFIX)) return id;
      return null;
    },

    load(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      return entry.css;
    },
  };
}
