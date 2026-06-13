import { pickRootParams, runWithRootParamsScope, type RootParams } from "vinext/shims/root-params";
import { isUnknownRecord } from "../utils/record.js";

type GenerateStaticParamsFunction = (input: { params: RootParams }) => unknown;

/**
 * A lazily-loaded `generateStaticParams` source. Page modules are code-split
 * out of the RSC entry (see `entries/app-rsc-manifest.ts`), so the
 * module-level `generateStaticParamsMap` cannot read `mod.generateStaticParams`
 * synchronously at import time. Instead it embeds `{ load }` thunks that the
 * resolver imports on demand at prerender time (which is already async).
 */
type LazyStaticParamsSource = { load: () => Promise<unknown> };

function isGenerateStaticParamsFunction(value: unknown): value is GenerateStaticParamsFunction {
  return typeof value === "function";
}

function isLazyStaticParamsSource(value: unknown): value is LazyStaticParamsSource {
  return (
    typeof value === "object" &&
    value !== null &&
    "load" in value &&
    typeof (value as { load: unknown }).load === "function"
  );
}

function isRootParams(value: unknown): value is RootParams {
  return isUnknownRecord(value);
}

/**
 * Build a prerender `generateStaticParams` resolver for one route pattern.
 *
 * `sources` may mix eager functions (layout `generateStaticParams`, which stay
 * eagerly imported) and lazy `{ load }` page sources (code-split page modules).
 * Lazy sources are imported once on first invocation. The returned resolver:
 *
 *  - returns `null` when, after resolving every source, no `generateStaticParams`
 *    export exists for the pattern — the sentinel the prerender driver uses to
 *    skip the route (or error under `output: export`);
 *  - otherwise composes all sources into the cartesian set of param objects.
 *
 * Returns `null` (no resolver) only when the pattern has zero sources at all.
 */
export function createAppPrerenderStaticParamsResolver(
  sources: readonly unknown[],
  rootParamNames?: readonly string[],
): GenerateStaticParamsFunction | null {
  // A source is usable if it is an eager generateStaticParams function or a
  // lazy `{ load }` page source. Keep them in their original order so the
  // composition order does not depend on the emitter happening to append
  // layout (eager) sources before the page (lazy) source.
  const usableSources = sources.filter(
    (source) => isGenerateStaticParamsFunction(source) || isLazyStaticParamsSource(source),
  );
  if (usableSources.length === 0) return null;

  const filterRootParams = (params: RootParams): RootParams =>
    pickRootParams(params, rootParamNames ?? []);

  // Resolve lazy page modules once, on first invocation (prerender time), and
  // memoize the combined function list. Dedup concurrent callers. Resolution
  // preserves `sources` order: each source maps to its eager function or its
  // awaited lazy function, then non-functions are dropped.
  let resolvedFns: GenerateStaticParamsFunction[] | null = null;
  let resolvePromise: Promise<GenerateStaticParamsFunction[]> | null = null;
  const resolveFns = (): Promise<GenerateStaticParamsFunction[]> => {
    if (resolvedFns) return Promise.resolve(resolvedFns);
    if (!resolvePromise) {
      resolvePromise = (async () => {
        const maybeFns = await Promise.all(
          usableSources.map(async (source) => {
            if (isGenerateStaticParamsFunction(source)) return source;
            const mod = await source.load();
            const fn =
              mod && typeof mod === "object"
                ? (mod as { generateStaticParams?: unknown }).generateStaticParams
                : undefined;
            return isGenerateStaticParamsFunction(fn) ? fn : null;
          }),
        );
        resolvedFns = maybeFns.filter((fn): fn is GenerateStaticParamsFunction => fn !== null);
        return resolvedFns;
      })();
    }
    return resolvePromise;
  };

  return async (input) => {
    const fns = await resolveFns();
    // No generateStaticParams export anywhere for this pattern. Return null (not
    // []) so the prerender driver treats it as "no static params" — skipping
    // the route, or erroring under `output: export` — exactly as it did when an
    // eager-only resolver returned null at creation time.
    if (fns.length === 0) return null;

    if (fns.length === 1) {
      const single = fns[0];
      // Wrap the single source in the same non-array/non-object guards as the
      // multi-source composition path so the contract is uniform regardless of
      // how many sources were composed.
      const picked = filterRootParams(input.params);
      return runWithRootParamsScope(picked, async () => {
        const result = await single(input);
        if (!Array.isArray(result)) return [];
        for (const item of result) {
          if (!isRootParams(item)) return [];
        }
        return result;
      });
    }

    let paramSets: RootParams[] = [input.params];

    for (const generateStaticParams of fns) {
      const nextParamSets: RootParams[] = [];

      for (const parentParams of paramSets) {
        const rootScope = filterRootParams(parentParams);

        const result = await runWithRootParamsScope(rootScope, async () =>
          generateStaticParams({ params: parentParams }),
        );

        if (!Array.isArray(result)) return [];

        for (const item of result) {
          if (!isRootParams(item)) return [];
          nextParamSets.push({ ...parentParams, ...item });
        }
      }

      paramSets = nextParamSets;
    }

    return paramSets;
  };
}

type CallAppPrerenderStaticParamsOptions = {
  fn: GenerateStaticParamsFunction;
  params: RootParams;
  pattern: string;
  rootParamNamesByPattern: Record<string, readonly string[] | undefined>;
};

export async function callAppPrerenderStaticParams(
  options: CallAppPrerenderStaticParamsOptions,
): Promise<unknown> {
  const picked = pickRootParams(options.params, options.rootParamNamesByPattern[options.pattern]);
  return runWithRootParamsScope(picked, () => options.fn({ params: options.params }));
}
