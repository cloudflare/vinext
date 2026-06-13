/**
 * vinext OG image asset plugins
 *
 * Exports two Vite plugins:
 *
 * `createOgInlineFetchAssetsPlugin` — vinext:og-inline-fetch-assets
 *   Some bundled libraries (notably @vercel/og) load assets at module init
 *   time with the pattern:
 *
 *     fetch(new URL("./some-font.ttf", import.meta.url)).then(res => res.arrayBuffer())
 *     fetch(new URL("../../../assets/font.ttf", import.meta.url)).then(res => res.arrayBuffer())
 *
 *   Both ./-relative and ../-relative paths are handled (the latter appears in
 *   Next.js test fixtures like og-routes-custom-font and metadata-font where the
 *   font file lives in a project-root assets/ directory).
 *
 *   This works in browser and standard Node.js because import.meta.url is a
 *   real file:// URL. In Cloudflare Workers (both wrangler dev and production),
 *   however, import.meta.url is the string "worker" — not a URL — so
 *   new URL(...) throws "TypeError: Invalid URL string" and the Worker fails to
 *   start. Additionally, Node.js's built-in fetch() does not support file://
 *   URLs, so even on Node.js the pattern must be inlined at build time.
 *
 *   Fix: at Vite transform time, find every such pattern, resolve the referenced
 *   file relative to the module's actual path on disk (available as `id`), read
 *   it, and replace the entire fetch(new URL(...)) expression with an inline
 *   base64 IIFE that resolves synchronously. This eliminates the runtime fetch
 *   entirely and works in all environments (workerd, Node.js, browser).
 *
 *   Note: WASM files imported via `import ... from "./foo.wasm?module"` are
 *   handled by the bundler/Vite directly and do not need this treatment. Only
 *   assets that are runtime-fetched (not statically imported) need inlining.
 *
 * `createOgAssetsPlugin` — vinext:og-assets
 *   Guarantees each @vercel/og binary WASM module (resvg.wasm, yoga.wasm) ships
 *   exactly once in the RSC output, with every loader strategy resolving to that
 *   single file. The `import("./x.wasm?module")` path makes the bundler emit a
 *   hashed asset (used by workerd); the og-font-patch transform also injects a
 *   `new URL("./x.wasm", import.meta.url)` disk-read fallback (used by Node.js).
 *   When the bundler already emitted the asset, this plugin rewrites the fallback
 *   reference to point at it (dedup); otherwise it copies a single root copy from
 *   @vercel/og's dist. The decision keys off whether the bundler emitted the
 *   asset, never the deploy target.
 */

import type { Plugin } from "vite";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import MagicString from "magic-string";

// ── Plugin factories ──────────────────────────────────────────────────────────

/**
 * Create the `vinext:og-inline-fetch-assets` Vite plugin.
 *
 * Inlines binary assets that are runtime-fetched via
 * `fetch(new URL("./asset", import.meta.url))` or read via
 * `readFileSync(fileURLToPath(new URL("./asset", import.meta.url)))`.
 * Both patterns are rewritten to inline base64 literals so the code works
 * correctly inside Cloudflare Workers where `import.meta.url` is not a
 * valid file URL.
 */
export function createOgInlineFetchAssetsPlugin(): Plugin {
  // Build-only cache to avoid repeated file reads during a single production
  // build. Dev mode skips the cache so asset edits are picked up without
  // restarting the Vite server.
  const cache = new Map<string, string>(); // absPath -> base64
  let isBuild = false;

  return {
    name: "vinext:og-inline-fetch-assets",
    enforce: "pre",

    configResolved(config) {
      isBuild = config.command === "build";
    },

    buildStart() {
      if (isBuild) {
        cache.clear();
      }
    },

    async transform(code, id) {
      // Quick bail-out: only process modules that use new URL(..., import.meta.url)
      if (!code.includes("import.meta.url")) {
        return null;
      }

      const useCache = isBuild;
      const moduleDir = path.dirname(id);
      let newCode = code;
      let didReplace = false;

      // Read a file from disk and return its base64 encoding, using the build
      // cache when enabled. Returns null on any read error so callers can skip
      // the match (e.g. file not present on disk for the active environment).
      const readAsBase64 = async (absPath: string): Promise<string | null> => {
        const cached = useCache ? cache.get(absPath) : undefined;
        if (cached !== undefined) return cached;
        try {
          const buf = await fs.promises.readFile(absPath);
          const b64 = buf.toString("base64");
          if (useCache) cache.set(absPath, b64);
          return b64;
        } catch {
          return null;
        }
      };

      // Pattern 1 — edge build: fetch(new URL("./file", import.meta.url)).then((res) => res.arrayBuffer())
      // Supports both ./-relative and ../-relative paths (e.g. "../../../assets/font.ttf").
      // The regex is deliberately tolerant of how formatters (Prettier
      // `trailingComma: "all"`, oxfmt) rewrite the `.then(...)` callback when the call
      // is wrapped across multiple lines, since formatted source that fails to match is
      // left as a runtime fetch (which throws "Invalid URL" on Workers, where
      // import.meta.url is "worker"):
      //   - `,?` before each close paren tolerates a trailing comma, e.g.
      //       .then((res) =>
      //         res.arrayBuffer(),
      //       )
      //   - `;?` before the block-body `}` tolerates a terminating semicolon, e.g.
      //       .then((res) => {
      //         return res.arrayBuffer();
      //       })
      // Replace with an inline IIFE that decodes the asset as base64 and returns Promise<ArrayBuffer>.
      if (code.includes("fetch(")) {
        const fetchPattern =
          /fetch\(\s*new URL\(\s*(["'])(\.[^"']+)\1\s*,\s*import\.meta\.url\s*\)\s*\)(?:\.then\(\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{?\s*return\s+[^.]+\.arrayBuffer\(\)\s*;?\s*\}?\s*,?\s*\)|\.then\(\s*\([^)]*\)\s*=>\s*[^.]+\.arrayBuffer\(\)\s*,?\s*\))/g;

        for (const match of code.matchAll(fetchPattern)) {
          const fullMatch = match[0];
          const relPath = match[2]; // e.g. "./noto-sans-v27-latin-regular.ttf"
          const absPath = path.resolve(moduleDir, relPath);

          const fileBase64 = await readAsBase64(absPath);
          if (fileBase64 === null) continue; // may be a runtime-only asset

          // Replace fetch(...).then(...) with an inline IIFE that returns Promise<ArrayBuffer>.
          const inlined = [
            `(function(){`,
            `var b=${JSON.stringify(fileBase64)};`,
            `var r=atob(b);`,
            `var a=new Uint8Array(r.length);`,
            `for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);`,
            `return Promise.resolve(a.buffer);`,
            `})()`,
          ].join("");

          newCode = newCode.replaceAll(fullMatch, inlined);
          didReplace = true;
        }
      }

      // Pattern 2 — node build: readFileSync(fileURLToPath(new URL("./file", import.meta.url)))
      // Supports both ./-relative and ../-relative paths (e.g. "../../../assets/font.ttf").
      // Replace with Buffer.from("<base64>", "base64"), which returns a Buffer (compatible with
      // both font data passed to satori and WASM bytes passed to initWasm).
      if (code.includes("readFileSync(")) {
        const readFilePattern =
          /[a-zA-Z_$][a-zA-Z0-9_$]*\.readFileSync\(\s*(?:[a-zA-Z_$][a-zA-Z0-9_$]*\.)?fileURLToPath\(\s*new URL\(\s*(["'])(\.[^"']+)\1\s*,\s*import\.meta\.url\s*\)\s*\)\s*\)/g;

        for (const match of newCode.matchAll(readFilePattern)) {
          const fullMatch = match[0];
          const relPath = match[2]; // e.g. "./noto-sans-v27-latin-regular.ttf"
          const absPath = path.resolve(moduleDir, relPath);

          const fileBase64 = await readAsBase64(absPath);
          if (fileBase64 === null) continue;

          // Replace readFileSync(...) with Buffer.from("<base64>", "base64").
          // Buffer is always available in Node.js and in the vinext SSR/RSC environments.
          const inlined = `Buffer.from(${JSON.stringify(fileBase64)},"base64")`;

          newCode = newCode.replaceAll(fullMatch, inlined);
          didReplace = true;
        }
      }

      if (!didReplace) return null;
      return { code: newCode, map: null };
    },
  } satisfies Plugin;
}

// @vercel/og WASM assets that need a single physical copy in the output.
// Both are imported via `import("./<name>?module")` (workerd path) AND read
// from disk via `new URL("./<name>", import.meta.url)` (Node.js fallback path),
// the latter injected by the vinext:og-font-patch transform.
const OG_WASM_ASSETS = ["resvg.wasm", "yoga.wasm"] as const;

/**
 * Find an emitted WASM asset in the output bundle whose name corresponds to the
 * given base file (e.g. base `resvg.wasm` matches the emitted `resvg-HASH.wasm`).
 *
 * The bundler emits the `import("./resvg.wasm?module")` dynamic import as a
 * hashed asset. When it exists, both loader strategies can point at the same
 * physical file — no second copy needed.
 *
 * @returns the emitted asset's `fileName` (relative to outDir), or null.
 */
function findEmittedWasmAsset(
  bundle: Record<string, { type: string; fileName: string }>,
  baseName: string,
): string | null {
  const stem = baseName.replace(/\.wasm$/, "");
  // Matches `resvg.wasm` or `resvg-<hash>.wasm` as the basename.
  const re = new RegExp(`^${stem}(?:-[\\w-]+)?\\.wasm$`);
  for (const output of Object.values(bundle)) {
    if (output.type !== "asset") continue;
    if (re.test(path.posix.basename(output.fileName))) return output.fileName;
  }
  return null;
}

/**
 * Build the regex that matches the Node.js fallback reference
 * `new URL("./<base>", import.meta.url)` for a given WASM base name.
 *
 * Handles all three quote styles ("'`) because the minifier may rewrite the
 * string literal (commonly to a template literal) by the time the chunk code
 * is available in generateBundle.
 */
function fallbackUrlRegex(baseName: string): RegExp {
  const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    String.raw`new URL\(\s*(["'\`])\.\/${escaped}\1\s*,\s*import\.meta\.url\s*\)`,
    "g",
  );
}

/**
 * Copy a single root copy of each requested WASM asset from `sourceDir` into
 * `outDir`, skipping any asset whose source is missing or whose destination
 * already exists.
 *
 * Extracted as a pure, dependency-injected helper so it can be unit-tested
 * against a temp source directory without depending on the real @vercel/og
 * install (whose `yoga.wasm` is only materialized as a side effect of the
 * `vinext:og-font-patch` transform during a build).
 */
export function copyMissingOgWasm(opts: {
  outDir: string;
  sourceDir: string;
  assets: readonly string[];
}): void {
  for (const asset of opts.assets) {
    const src = path.join(opts.sourceDir, asset);
    const dest = path.join(opts.outDir, asset);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }
}

/**
 * Create the `vinext:og-assets` Vite plugin.
 *
 * Ensures each @vercel/og WASM module (resvg.wasm, yoga.wasm) ships exactly once
 * in the RSC output, with every loader strategy resolving to that single file:
 *
 *   1. `generateBundle` (post): if the bundler already emitted the WASM as a
 *      hashed asset (from the `import("./x.wasm?module")` path), rewrite the
 *      Node.js fallback reference `new URL("./x.wasm", import.meta.url)` in each
 *      chunk to point at that emitted asset (a sibling under `_next/static/`).
 *      This deduplicates without copying a second root file.
 *   2. `writeBundle` (post): for any referenced WASM that was NOT emitted as an
 *      asset (e.g. a build that inlined or skipped it), copy a single root copy
 *      from @vercel/og's dist so the Node.js disk-read fallback still works.
 *
 * The decision keys off "did the bundler emit this asset?", never the deploy
 * target — so it helps Node/self-hosted builds as well as Cloudflare Workers.
 */
export function createOgAssetsPlugin(): Plugin {
  // Bases whose fallback reference was rewritten to an emitted asset in
  // generateBundle; writeBundle must NOT copy a second root copy for these.
  //
  // Cross-hook dependency: this is written in generateBundle and read in
  // writeBundle. Rollup runs generateBundle before writeBundle within a single
  // env build, and both hooks early-return unless `envName === "rsc"`, so the
  // ordering holds today. If a future refactor reorders or parallelizes env
  // builds, this shared state could go stale (writeBundle would copy a
  // redundant root file) — keep the produce/consume pair in the same env.
  let dedupedBases = new Set<string>();

  return {
    name: "vinext:og-assets",
    apply: "build",
    enforce: "post",

    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const envName = this.environment?.name;
        if (envName !== "rsc") return;

        dedupedBases = new Set<string>();

        const chunks = Object.values(bundle).filter(
          (o): o is typeof o & { type: "chunk"; code: string } => o.type === "chunk",
        );

        for (const base of OG_WASM_ASSETS) {
          // Only act if some chunk references this WASM at all.
          const referenced = chunks.some((c) => c.code.includes(base));
          if (!referenced) continue;

          const emitted = findEmittedWasmAsset(bundle as never, base);
          if (!emitted) continue; // no emitted asset → leave for writeBundle to copy

          for (const chunk of chunks) {
            const re = fallbackUrlRegex(base);
            const chunkDir = path.posix.dirname(chunk.fileName);
            const rel = path.posix.relative(chunkDir, emitted);
            const ref = rel.startsWith(".") ? rel : `./${rel}`;

            // Use MagicString so the chunk's sourcemap stays in sync with the
            // edit (offsets after the replacement shift correctly) rather than a
            // blind string .replace() that would invalidate `chunk.map`.
            const s = new MagicString(chunk.code);
            let edited = false;
            for (const m of chunk.code.matchAll(re)) {
              const quote = m[1];
              const start = m.index;
              s.overwrite(
                start,
                start + m[0].length,
                `new URL(${quote}${ref}${quote}, import.meta.url)`,
              );
              edited = true;
            }
            if (!edited) continue;

            chunk.code = s.toString();
            // Only regenerate the map when the chunk already carried one (server
            // builds usually omit sourcemaps, in which case `chunk.map` is null
            // and we must not fabricate one). magic-string's SourceMap is
            // structurally compatible with the bundler's (same fields +
            // toString/toUrl) but nominally distinct, so cast it.
            if (chunk.map) {
              chunk.map = s.generateMap({
                hires: "boundary",
                source: chunk.fileName,
              }) as typeof chunk.map;
            }
          }

          // Even if the fallback reference wasn't found (e.g. unexpected minifier
          // shape), the emitted asset still satisfies the workerd loader, so the
          // root copy is redundant. Mark as deduped to avoid shipping it twice.
          dedupedBases.add(base);
        }
      },
    },

    writeBundle: {
      sequential: true,
      order: "post",
      async handler(options, bundle) {
        const envName = this.environment?.name;
        if (envName !== "rsc") return;

        const outDir = options.dir;
        if (!outDir) return;

        // Only copy if the bundle actually references these files. Scan every
        // emitted chunk, not just index.js: @vercel/og is lazily imported by the
        // next/og shim, so the asset reference lives in its own code-split chunk
        // rather than the main entry.
        const chunkCode = Object.values(bundle)
          .map((output) => (output.type === "chunk" ? output.code : ""))
          .join("\n");
        const referencedAssets = OG_WASM_ASSETS.filter(
          (asset) => chunkCode.includes(asset) && !dedupedBases.has(asset),
        );
        if (referencedAssets.length === 0) return;

        // Find @vercel/og in node_modules. The yoga.wasm source is written
        // there by the vinext:og-font-patch transform earlier in the build.
        try {
          const require = createRequire(import.meta.url);
          const ogPkgPath = require.resolve("@vercel/og/package.json");
          const ogDistDir = path.join(path.dirname(ogPkgPath), "dist");

          copyMissingOgWasm({ outDir, sourceDir: ogDistDir, assets: referencedAssets });
        } catch {
          // @vercel/og not installed — nothing to copy
        }
      },
    },
  } satisfies Plugin;
}
