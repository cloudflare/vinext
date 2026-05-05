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
 *
 *   This works in browser and standard Node.js because import.meta.url is a
 *   real file:// URL. In Cloudflare Workers (both wrangler dev and production),
 *   however, import.meta.url is the string "worker" — not a URL — so
 *   new URL(...) throws "TypeError: Invalid URL string" and the Worker fails to
 *   start.
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
 * `ogAssetsPlugin` — vinext:og-assets
 *   Copies @vercel/og binary assets (e.g. resvg.wasm) to the RSC output
 *   directory for production builds. The edge build inlines fonts as base64 via
 *   og-inline-fetch-assets; this plugin is a safety net to ensure resvg.wasm is
 *   present for the Node.js disk-read fallback.
 */

import type { Plugin } from "vite";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

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
      // Replace with an inline IIFE that decodes the asset as base64 and returns Promise<ArrayBuffer>.
      if (code.includes("fetch(")) {
        const fetchPattern =
          /fetch\(\s*new URL\(\s*(["'])(\.\/[^"']+)\1\s*,\s*import\.meta\.url\s*\)\s*\)(?:\.then\(\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{?\s*return\s+[^.]+\.arrayBuffer\(\)\s*\}?\s*\)|\.then\(\s*\([^)]*\)\s*=>\s*[^.]+\.arrayBuffer\(\)\s*\))/g;

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
      // Replace with Buffer.from("<base64>", "base64"), which returns a Buffer (compatible with
      // both font data passed to satori and WASM bytes passed to initWasm).
      if (code.includes("readFileSync(")) {
        const readFilePattern =
          /[a-zA-Z_$][a-zA-Z0-9_$]*\.readFileSync\(\s*(?:[a-zA-Z_$][a-zA-Z0-9_$]*\.)?fileURLToPath\(\s*new URL\(\s*(["'])(\.\/[^"']+)\1\s*,\s*import\.meta\.url\s*\)\s*\)\s*\)/g;

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

/**
 * The `vinext:og-assets` Vite plugin.
 *
 * Copies @vercel/og binary assets (e.g. resvg.wasm) to the RSC output
 * directory for production builds. The edge build inlines fonts as base64 via
 * `vinext:og-inline-fetch-assets`; this plugin is a safety net to ensure
 * resvg.wasm exists in the output directory for the Node.js disk-read fallback.
 */
export const ogAssetsPlugin: Plugin = {
  name: "vinext:og-assets",
  apply: "build",
  enforce: "post",
  writeBundle: {
    sequential: true,
    order: "post",
    async handler(options) {
      const envName = this.environment?.name;
      if (envName !== "rsc") return;

      const outDir = options.dir;
      if (!outDir) return;

      // Check if the bundle references @vercel/og assets
      const indexPath = path.join(outDir, "index.js");
      if (!fs.existsSync(indexPath)) return;

      const content = fs.readFileSync(indexPath, "utf-8");
      // The font is inlined as base64 by vinext:og-inline-fetch-assets, so only
      // the WASM needs to be present as a file alongside the bundle.
      const ogAssets = ["resvg.wasm"];

      // Only copy if the bundle actually references these files
      const referencedAssets = ogAssets.filter((asset) => content.includes(asset));
      if (referencedAssets.length === 0) return;

      // Find @vercel/og in node_modules
      try {
        const require = createRequire(import.meta.url);
        const ogPkgPath = require.resolve("@vercel/og/package.json");
        const ogDistDir = path.join(path.dirname(ogPkgPath), "dist");

        for (const asset of referencedAssets) {
          const src = path.join(ogDistDir, asset);
          const dest = path.join(outDir, asset);
          if (fs.existsSync(src) && !fs.existsSync(dest)) {
            fs.copyFileSync(src, dest);
          }
        }
      } catch {
        // @vercel/og not installed — nothing to copy
      }
    },
  },
};
