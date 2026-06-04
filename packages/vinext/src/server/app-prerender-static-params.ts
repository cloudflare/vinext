import { pickRootParams, runWithRootParamsScope, type RootParams } from "vinext/shims/root-params";

type GenerateStaticParamsFunction = (input: { params: RootParams }) => unknown;
const MISSING_GENERATE_STATIC_PARAMS = Symbol.for("vinext.generateStaticParams.missing");

function isGenerateStaticParamsFunction(value: unknown): value is GenerateStaticParamsFunction {
  return typeof value === "function";
}

function isMissingGenerateStaticParams(value: unknown): boolean {
  return value === MISSING_GENERATE_STATIC_PARAMS;
}

function isRootParams(value: unknown): value is RootParams {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createAppPrerenderStaticParamsResolver(
  sources: readonly unknown[],
  rootParamNames?: readonly string[],
): GenerateStaticParamsFunction | null {
  const generateStaticParamsFns = sources.filter(isGenerateStaticParamsFunction);
  if (generateStaticParamsFns.length === 0) return null;

  const filterRootParams = (params: RootParams): RootParams =>
    pickRootParams(params, rootParamNames ?? []);

  if (generateStaticParamsFns.length === 1) {
    const single = generateStaticParamsFns[0];
    // Wrap the single source in the same non-array/non-object guards as the
    // multi-source composition path so the contract is uniform regardless of
    // how many sources were composed.
    return async (input) => {
      const picked = filterRootParams(input.params);
      return runWithRootParamsScope(picked, async () => {
        const result = await single(input);
        if (isMissingGenerateStaticParams(result)) return null;
        if (!Array.isArray(result)) return [];
        for (const item of result) {
          if (!isRootParams(item)) return [];
        }
        return result;
      });
    };
  }

  return async ({ params }) => {
    let paramSets: RootParams[] = [params];
    let resolvedAnySource = false;

    for (const generateStaticParams of generateStaticParamsFns) {
      const nextParamSets: RootParams[] = [];
      let resolvedThisSource = false;

      for (const parentParams of paramSets) {
        const rootScope = filterRootParams(parentParams);

        const result = await runWithRootParamsScope(rootScope, async () =>
          generateStaticParams({ params: parentParams }),
        );

        if (isMissingGenerateStaticParams(result)) continue;
        if (!Array.isArray(result)) return [];

        resolvedThisSource = true;
        resolvedAnySource = true;
        for (const item of result) {
          if (!isRootParams(item)) return [];
          nextParamSets.push({ ...parentParams, ...item });
        }
      }

      if (resolvedThisSource) {
        paramSets = nextParamSets;
      }
    }

    if (!resolvedAnySource) return null;
    return paramSets;
  };
}

export function createLazyGenerateStaticParamsSource(
  loadModule: () => Promise<unknown>,
): (input: { params: RootParams }) => Promise<unknown> {
  return async (input) => {
    const mod = await loadModule();
    if (mod === null || typeof mod !== "object") {
      return MISSING_GENERATE_STATIC_PARAMS;
    }
    const generateStaticParams = Reflect.get(mod, "generateStaticParams");
    if (!isGenerateStaticParamsFunction(generateStaticParams)) {
      return MISSING_GENERATE_STATIC_PARAMS;
    }
    return generateStaticParams(input);
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
