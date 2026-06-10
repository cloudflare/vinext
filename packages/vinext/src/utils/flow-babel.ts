import path from "node:path";
import { createRequire } from "node:module";
import { transformWithOxc } from "vite";
import { hasFlowPragma } from "./flow-pragma.js";

/**
 * Memoized @babel/core resolve cache: projectRoot → resolved module.
 * Avoids repeated `createRequire` + `require.resolve` on every transformed file.
 *
 * Only successful resolutions are cached. Misses are deliberately NOT cached:
 * caching the not-found result would pin "no Babel" for the process lifetime,
 * forcing a dev-server restart after installing @babel/core mid-session. The
 * re-attempt cost is a failed `require.resolve` and only applies to files that
 * carry a leading `@flow` pragma — and in a project without @babel/core those
 * either fail the build anyway (genuine Flow syntax) or are rare pragma-only
 * plain-JS files, so the hot path (Babel installed) always hits the cache.
 */
const _babelCoreCache = new Map<string, unknown>();

/**
 * Transform a `.js` file that carries a Flow pragma using @babel/core so that
 * Flow type annotations are stripped before OXC processes the file.
 *
 * OXC (used by `vite:oxc` and `transformWithOxc`) does not support Flow type
 * syntax and throws `PARSE_ERROR: Flow is not supported` on such files. This
 * function resolves @babel/core from the project root (so the user's installed
 * version is used) and invokes it with `babelrc: true` so the project's
 * .babelrc — which must contain `@babel/preset-flow` — strips the Flow
 * annotations. Note that `@babel/preset-flow` alone cannot *parse* JSX, so a
 * Flow + JSX project's config necessarily handles JSX one way or another:
 * either it compiles JSX too (e.g. `next/babel`) or it parses-but-keeps it
 * (e.g. `@babel/plugin-syntax-jsx`). A subsequent `transformWithOxc` pass
 * (with `lang: "jsx"`) compiles any JSX still present in Babel's output, so
 * the Vite pipeline receives plain JS in both cases.
 *
 * Babel's `root`/`cwd` are pinned to `projectRoot` so that .babelrc /
 * babel.config.* resolution is anchored to the project even when the Vite
 * process was launched from a different directory (e.g. a monorepo root —
 * Babel's default `babelrcRoots` only honors .babelrc files in its `root`
 * package, which defaults to `process.cwd()`).
 *
 * Returns null when @babel/core cannot be resolved; the caller falls back to
 * the regular OXC pass, which compiles plain JS normally and rejects genuine
 * Flow syntax with a parse error (which the caller turns into an actionable
 * "install @babel/core + @babel/preset-flow" message). Throws when Babel
 * itself rejects the file (e.g. a misconfigured .babelrc) or when Babel
 * produces no output (which indicates a silent misconfiguration).
 */
export async function transformWithFlowBabel(
  code: string,
  filename: string,
  projectRoot: string,
  // oxlint-disable-next-line typescript/no-explicit-any
): Promise<{ code: string; map?: any } | null> {
  // Resolve @babel/core from the project root so the user's version is used.
  // Memoize successful resolutions per projectRoot to avoid repeated
  // `createRequire` calls on every transformed file.
  // oxlint-disable-next-line typescript/no-explicit-any
  let babelCore: any = _babelCoreCache.get(projectRoot);
  if (babelCore === undefined) {
    try {
      const req = createRequire(path.join(projectRoot, "package.json"));
      babelCore = req("@babel/core");
      _babelCoreCache.set(projectRoot, babelCore);
    } catch {
      // @babel/core not installed in this project: the caller falls back to
      // the OXC pass. The miss is intentionally not cached (see the cache doc
      // above) so installing @babel/core mid-session takes effect without a
      // dev-server restart.
      return null;
    }
  }

  // Use the project's .babelrc / babel.config.* (must include @babel/preset-flow)
  // to strip Flow type annotations. Babel leaves JSX syntax intact.
  // oxlint-disable-next-line typescript/no-unsafe-call, typescript/no-unsafe-member-access
  const result = (await babelCore.transformAsync(code, {
    filename,
    sourceMaps: true,
    configFile: true,
    babelrc: true,
    root: projectRoot,
    cwd: projectRoot,
  })) as { code?: string | null; map?: unknown } | null;

  if (!result?.code) {
    throw new Error(
      `[vinext] Babel produced empty output for Flow file: ${filename}\n` +
        "Ensure @babel/preset-flow is listed in the project's .babelrc or babel.config.*",
    );
  }

  // Babel has stripped Flow types; the output may still contain JSX (when the
  // project's config only parses it, e.g. @babel/plugin-syntax-jsx). Run OXC
  // to compile any remaining JSX so the Vite pipeline receives plain JS.
  // Pass Babel's output map as `inMap` so OXC composes it into the final map,
  // making the returned sourcemap trace back to the original Flow source rather
  // than to Babel's intermediate output.
  const babelMap = result.map as object | undefined;
  const oxcResult = await transformWithOxc(
    result.code,
    filename,
    { lang: "jsx", jsx: { runtime: "automatic" as const }, sourcemap: true },
    babelMap,
  );
  return { code: oxcResult.code, map: oxcResult.map };
}

/**
 * Compile a `.js`/`.mjs` module that may contain JSX — and, when it carries a
 * leading `// @flow` or `/* @flow *\/` pragma, Flow type annotations — into
 * plain JS for the Vite pipeline. This is the transform body of the
 * `vinext:jsx-in-js` plugin, extracted so the full pipeline (including the
 * babel-missing error path) is unit-testable.
 *
 * Flow files are routed through `transformWithFlowBabel` (the project's
 * .babelrc must include `@babel/preset-flow`). When @babel/core is not
 * installed, the file falls through to the regular OXC pass: plain JS that
 * merely mentions `@flow` in a leading comment still compiles, while genuine
 * Flow syntax fails OXC's parse and is rethrown with an actionable
 * "install @babel/core + @babel/preset-flow" message (with the OXC parse
 * error as `cause`) instead of a confusing downstream parser error.
 *
 * `cleanId` must already have query params stripped — it is used as the
 * filename for Babel config lookup, sourcemaps, and parse errors.
 */
export async function transformJsxInJs(
  code: string,
  cleanId: string,
  projectRoot: string,
  // oxlint-disable-next-line typescript/no-explicit-any
): Promise<{ code: string; map?: any }> {
  // `hasFlowPragma` only matches the leading comment block, so mid-file
  // occurrences of `@flow` (template literals, comments) never trigger the
  // Babel fallback.
  const isFlowFile = hasFlowPragma(code);
  if (isFlowFile) {
    const flowResult = await transformWithFlowBabel(code, cleanId, projectRoot);
    if (flowResult) return flowResult;
    // @babel/core is not installed in the project: fall through to the
    // regular OXC pass below.
  }

  try {
    const result = await transformWithOxc(code, cleanId, {
      lang: "jsx",
      jsx: { runtime: "automatic" as const },
      sourcemap: true,
    });
    return { code: result.code, map: result.map };
  } catch (error) {
    if (isFlowFile) {
      throw new Error(
        `[vinext] Failed to compile ${cleanId}, which has a leading @flow pragma. ` +
          "Flow type syntax requires Babel: install @babel/core and @babel/preset-flow, " +
          'and add "@babel/preset-flow" to the project\'s .babelrc or babel.config.*',
        { cause: error },
      );
    }
    throw error;
  }
}
