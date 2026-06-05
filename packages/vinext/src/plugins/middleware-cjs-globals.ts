import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/**
 * Inject CommonJS-style globals (`__filename`, `__dirname`) into the user's
 * middleware/proxy module so references to them do not throw a ReferenceError
 * at runtime.
 *
 * Background
 * ----------
 * Next.js bundles `middleware.ts` / `proxy.ts` via webpack with the `node`
 * target plus its own template wrapper, which sets `__filename` and
 * `__dirname` on the module scope (see packages/next/src/build/templates/
 * middleware.ts and the standard CJS globals webpack injects for the `node`
 * target). The upstream `proxy-nfc-traced` fixture relies on this — its
 * proxy.ts logs `__filename` to coerce the NFT trace to include the file:
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/proxy-nfc-traced/proxy.ts
 *
 * vinext bundles the proxy through Rolldown as pure ESM, where `__filename`
 * and `__dirname` are not defined. Without this plugin, any middleware that
 * references them throws `ReferenceError: __filename is not defined`, which
 * vinext catches and turns into a 500 "Internal Server Error" response. In
 * the upstream `proxy-nfc-traced` deploy test, that empty 500 body surfaces
 * as `Expected: "hello world" / Received: ""` (the client follows the
 * `/home → /` redirect into the crashing fall-through branch).
 *
 * The same `cjsGlobalsInjectorPlugin` exists for `next.config.ts` in
 * config/next-config.ts. This plugin mirrors it for user middleware/proxy.
 *
 * Issue: https://github.com/cloudflare/vinext/issues/1546
 */

const CJS_GLOBAL_SCAN_REGEX = /\b(?:__filename|__dirname)\b/;

export function createMiddlewareCjsGlobalsPlugin(options: {
  getMiddlewarePath: () => string | null;
}): Plugin {
  let canonicalTarget: string | null = null;
  let canonicalFilename: string | null = null;
  let canonicalDirname: string | null = null;

  function refreshTarget(): void {
    const middlewarePath = options.getMiddlewarePath();
    if (!middlewarePath) {
      canonicalTarget = null;
      canonicalFilename = null;
      canonicalDirname = null;
      return;
    }
    // Resolve symlinks once. On macOS, /var/folders resolves to /private/var/
    // folders, so the temp-dir path used by tests would otherwise mismatch.
    canonicalTarget = safeRealpath(path.resolve(middlewarePath));
    canonicalFilename = canonicalTarget;
    canonicalDirname = path.dirname(canonicalTarget);
  }

  return {
    name: "vinext:middleware-cjs-globals",
    enforce: "pre",

    buildStart() {
      refreshTarget();
    },

    transform: {
      // Filter to skip un-related files cheaply. The transform body still has
      // the canonical-path check below for correctness.
      filter: { id: /\.(?:[cm]?[jt]sx?)(?:\?.*)?$/ },
      handler(code: string, id: string) {
        if (!canonicalTarget) return null;

        // Fast path: skip the transform when the source contains no bareword
        // reference to either shimmed global. Most middlewares are pure ESM
        // and pay no cost from this plugin.
        if (!CJS_GLOBAL_SCAN_REGEX.test(code)) return null;

        // Vite may pass an id with a query suffix (?v=...) or as a file URL.
        const idPath = id.startsWith("file://") ? fileURLToPath(id) : id.split("?")[0];
        const resolvedId = safeRealpath(path.resolve(idPath));
        if (resolvedId !== canonicalTarget) return null;

        // JSON.stringify produces safe JS string literals for paths.
        const filenameLiteral = JSON.stringify(canonicalFilename);
        const dirnameLiteral = JSON.stringify(canonicalDirname);

        // Preamble runs after ESM imports are hoisted; the const bindings
        // shadow any global lookups the source would otherwise perform.
        const preamble =
          `const __filename = ${filenameLiteral};\n` + `const __dirname = ${dirnameLiteral};\n`;

        return {
          code: preamble + code,
          map: null,
        };
      },
    },
  };
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
