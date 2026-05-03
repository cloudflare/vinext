import { pickRootParams, setRootParams, type RootParams } from "vinext/shims/root-params";

type GenerateStaticParamsFunction = (input: { params: RootParams }) => unknown;

type CallAppPrerenderStaticParamsOptions = {
  fn: GenerateStaticParamsFunction;
  params: RootParams;
  pattern: string;
  rootParamNamesByPattern: Record<string, readonly string[] | undefined>;
};

export async function callAppPrerenderStaticParams(
  options: CallAppPrerenderStaticParamsOptions,
): Promise<unknown> {
  setRootParams(pickRootParams(options.params, options.rootParamNamesByPattern[options.pattern]));
  try {
    return await options.fn({ params: options.params });
  } finally {
    setRootParams(null);
  }
}
