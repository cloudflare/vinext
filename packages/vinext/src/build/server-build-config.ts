/**
 * Server bundle build config helpers.
 *
 * vinext emits ESM server bundles (`dist/server/index.js`,
 * `dist/server/ssr/index.js`, `dist/server/entry.js`) because the host project
 * is initialised with `"type": "module"` (added by `vinext init`). Node's ESM
 * loader does not expose the CommonJS globals `__filename`, `__dirname`, or
 * `require`, so any third-party package whose code is bundled into the server
 * entry and which reads these at module-load time (sqlite3, typescript,
 * graceful-fs, node-pre-gyp, etc.) throws `ReferenceError: __filename is not
 * defined in ES module scope` the first time the bundle is imported. That
 * typically surfaces during the prerender phase of `vinext build`, which is
 * where the freshly-built bundle is loaded.
 *
 * Next.js avoids this by emitting CommonJS for its server runtime; vinext
 * can't take that shortcut because the project's `"type": "module"` makes
 * every `.js` file under `dist/server/` ESM by default. Renaming outputs to
 * `.cjs` would force a CJS evaluator but would also break:
 *   - Vite plugins that hard-code `index.js` (plugin-rsc emits to `index.js`)
 *   - `@cloudflare/vite-plugin`, which expects an ESM worker entry
 *   - Top-level `await` inside the bundle (Vite uses it for dynamic imports)
 *
 * Instead, prepend a small banner that synthesises the missing CJS globals
 * from `import.meta.url`. Rolldown / Rollup write `output.banner` verbatim at
 * the top of the chunk, so the bindings live in the module's top-level scope
 * and shadow Node's missing globals for every nested function in the bundle.
 *
 * The banner runs in O(1) per build, has zero impact on bundle size in
 * production (~250 bytes pre-minification, ~0 bytes after gzip with any
 * realistic server bundle), and is idempotent — repeated injection is
 * de-duplicated by {@link mergeBanner}.
 */

/**
 * Marker string embedded in the banner so {@link mergeBanner} and tests can
 * detect a previously-injected vinext banner. Kept short and unique to avoid
 * accidental collisions with user banners (license headers, etc.).
 */
const BANNER_MARKER = "// vinext:cjs-globals-banner";

/**
 * Return the ESM-compatible CJS-globals banner string to prepend to server
 * bundles. The banner is a single multi-line block; callers paste it verbatim
 * into Rolldown / Rollup's `output.banner` option.
 *
 * The synthesised bindings exactly match Node's CJS wrapper semantics:
 *   - `__filename` — absolute path of the current bundle file
 *   - `__dirname`  — directory of the current bundle file
 *   - `require`    — a `createRequire`-scoped resolver bound to the bundle URL
 *
 * The named imports are aliased (`createRequire as __vinext_createRequire`,
 * etc.) so user code that imports the same names from `node:module` /
 * `node:url` / `node:path` is unaffected. Only `__filename`, `__dirname`, and
 * `require` are introduced into the top-level scope — those are intentional
 * since they replace the missing CJS globals.
 *
 * The marker comment on the first line lets us detect a previously-injected
 * banner and skip re-injection (see {@link mergeBanner}).
 */
export function cjsGlobalsBanner(): string {
  return (
    `${BANNER_MARKER}\n` +
    `import { createRequire as __vinext_createRequire } from "node:module";\n` +
    `import { fileURLToPath as __vinext_fileURLToPath } from "node:url";\n` +
    `import { dirname as __vinext_dirname } from "node:path";\n` +
    `const __filename = __vinext_fileURLToPath(import.meta.url);\n` +
    `const __dirname = __vinext_dirname(__filename);\n` +
    `const require = __vinext_createRequire(import.meta.url);\n`
  );
}

/**
 * Whether the given string contains the vinext CJS-globals banner marker.
 * Used by {@link mergeBanner} to avoid duplicate injection when the plugin
 * config hook is invoked multiple times (Vite re-runs hooks on config
 * mutation, tests can call config() repeatedly, etc.).
 */
export function isCjsGlobalsBanner(s: string): boolean {
  return typeof s === "string" && s.includes(BANNER_MARKER);
}

/**
 * Merge the vinext CJS-globals banner with an optional user-provided banner.
 *
 * If the user banner already contains the marker (this hook ran before),
 * returns it unchanged. Otherwise prepends the vinext banner so the CJS
 * shim runs before any user banner code that might reference the bindings.
 *
 * Function-form user banners (Rolldown's `AddonFunction`) are wrapped to
 * preserve dynamic behaviour while still ensuring the shim is emitted —
 * the user function's return value is appended after the shim.
 */
function mergeBanner(
  // oxlint-disable-next-line typescript/no-explicit-any
  existing: string | ((...args: any[]) => string | Promise<string>) | undefined,
  // oxlint-disable-next-line typescript/no-explicit-any
): string | ((...args: any[]) => string | Promise<string>) {
  const shim = cjsGlobalsBanner();
  if (existing == null) return shim;
  if (typeof existing === "string") {
    if (isCjsGlobalsBanner(existing)) return existing;
    return shim + existing;
  }
  // Function form: invoke at output time, prepend the shim to whatever it
  // returns. Preserve the original function's argument signature.
  // oxlint-disable-next-line typescript/no-explicit-any
  return async (...args: any[]) => {
    const userBanner = await existing(...args);
    if (typeof userBanner === "string" && isCjsGlobalsBanner(userBanner)) {
      return userBanner;
    }
    return shim + (userBanner ?? "");
  };
}

/**
 * Inject the CJS-globals banner into a Rolldown / Rollup bundler-options
 * object. Returns a new object with `output.banner` set; the input object is
 * not mutated. Idempotent — calling this twice does not stack the banner.
 *
 * Used by the vinext plugin's `config()` hook to apply the banner to every
 * server environment's `build.rolldownOptions` / `build.rollupOptions`.
 *
 * Rolldown / Rollup `output` can be a single options object or an array of
 * options (for multi-format builds). Both shapes are handled.
 *
 * The type parameter is intentionally permissive (`Record<string, unknown>`)
 * because Rolldown's `RolldownOptions` shape varies across Vite versions and
 * we want callers to be able to spread arbitrary `input` / `treeshake` /
 * other bundler options into the same object.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export function withCjsGlobalsBanner<T extends Record<string, any>>(bundlerOptions: T): T {
  const out = bundlerOptions.output;
  if (Array.isArray(out)) {
    return {
      ...bundlerOptions,
      output: out.map((entry) => {
        const o = (entry ?? {}) as { banner?: Parameters<typeof mergeBanner>[0] };
        return { ...o, banner: mergeBanner(o.banner) };
      }),
    };
  }
  const o = (out ?? {}) as { banner?: Parameters<typeof mergeBanner>[0] };
  return {
    ...bundlerOptions,
    output: { ...o, banner: mergeBanner(o.banner) },
  };
}
