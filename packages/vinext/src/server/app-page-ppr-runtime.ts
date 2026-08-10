import {
  beginPprFallbackShellFinalRender,
  createPprFallbackShellState,
  getPprFallbackShellState,
  runWithPprFallbackShellState,
} from "vinext/shims/ppr-fallback-shell";
import {
  hasSearchParams,
  shouldReadAppPageCache,
  type AppPageDispatchRoute,
  type AppPagePprRuntime,
  type DispatchAppPageOptions,
} from "./app-page-dispatch.js";
import type { ResumeDataCacheEntry } from "vinext/shims/cache-handler";

type PprFallbackShellEligibility =
  | {
      kind: "probe-fallback-shells";
      fallbackShells: NonNullable<
        DispatchAppPageOptions<AppPageDispatchRoute>["pprFallbackCacheShells"]
      >;
    }
  | {
      kind:
        | "skip-known-pregenerated-route"
        | "skip-no-fallback-shells"
        | "skip-rsc-request"
        | "skip-non-get"
        | "skip-search-params"
        | "skip-cache-disabled";
    };

function classifyPprFallbackShellEligibility<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  currentRevalidateSeconds: number | null,
  isDraftMode: boolean,
  isForceStatic: boolean,
  isForceDynamic: boolean,
): PprFallbackShellEligibility {
  if (options.renderedConcreteUrlPaths?.has(options.cleanPathname) === true) {
    return { kind: "skip-known-pregenerated-route" };
  }

  const fallbackShells = options.pprFallbackCacheShells;
  if (!fallbackShells || fallbackShells.length === 0) {
    return { kind: "skip-no-fallback-shells" };
  }
  if (options.isRscRequest) return { kind: "skip-rsc-request" };
  if (options.request.method !== "GET") return { kind: "skip-non-get" };
  if (!isForceStatic && hasSearchParams(options.searchParams)) {
    return { kind: "skip-search-params" };
  }
  if (
    !shouldReadAppPageCache({
      isDraftMode,
      isForceDynamic,
      isProgressiveActionRender: options.isProgressiveActionRender === true,
      isProduction: options.isProduction,
      isRscRequest: false,
      revalidateSeconds: currentRevalidateSeconds,
      scriptNonce: options.scriptNonce,
    })
  ) {
    return { kind: "skip-cache-disabled" };
  }

  return { kind: "probe-fallback-shells", fallbackShells };
}

async function probePprFallbackShellCache<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  fallbackShells: NonNullable<DispatchAppPageOptions<TRoute>["pprFallbackCacheShells"]>,
  currentRevalidateSeconds: number | null,
): Promise<
  | Response
  | {
      fallbackParamNames: readonly string[];
      html: string;
      postponed: string;
      resumeDataCache: ResumeDataCacheEntry[];
    }
  | null
> {
  const { readAppPageFallbackShellCache } = await import("./app-page-cache.js");
  const { rewriteAppPprFallbackShellHtmlNavigation } = await import("./app-ppr-fallback-shell.js");
  for (const fallbackShell of fallbackShells) {
    const rewriteHtml = (html: string) =>
      rewriteAppPprFallbackShellHtmlNavigation({
        html,
        params: options.params,
        pathname: options.cleanPathname,
        searchParams: options.searchParams,
      });
    const fallbackShellResult = await readAppPageFallbackShellCache({
      clearRequestContext: options.clearRequestContext,
      expireSeconds: options.expireSeconds,
      fallbackPathname: fallbackShell.pathname,
      isEdgeRuntime: options.isEdgeRuntime,
      isrDebug: options.isrDebug,
      isrGet: options.isrGet,
      isrHtmlKey: options.isrHtmlKey,
      middlewareHeaders: options.middlewareContext.headers,
      middlewareStatus: options.middlewareContext.status,
      revalidateSeconds: currentRevalidateSeconds ?? 0,
      rewriteHtml,
    });
    if (fallbackShellResult instanceof Response) return fallbackShellResult;
    if (fallbackShellResult) {
      return {
        fallbackParamNames: fallbackShell.fallbackParamNames,
        html: fallbackShellResult.html,
        postponed: fallbackShellResult.postponed,
        resumeDataCache: fallbackShellResult.resumeDataCache,
      };
    }
  }
  return null;
}

export const appPagePprRuntime: AppPagePprRuntime<AppPageDispatchRoute> = {
  beginFinalRender: beginPprFallbackShellFinalRender,
  getState: getPprFallbackShellState,
  run(shell, fn) {
    return runWithPprFallbackShellState(createPprFallbackShellState(shell), fn);
  },
  async tryServe(options, currentRevalidateSeconds, isDraftMode, isForceStatic, isForceDynamic) {
    const decision = classifyPprFallbackShellEligibility(
      options,
      currentRevalidateSeconds,
      isDraftMode,
      isForceStatic,
      isForceDynamic,
    );
    if (decision.kind !== "probe-fallback-shells") return null;
    const result = await probePprFallbackShellCache(
      options,
      decision.fallbackShells,
      currentRevalidateSeconds,
    );
    if (result instanceof Response) return result;
    if (result) {
      return { ...result, blockUseCacheMisses: true, kind: "resume" };
    }
    return { blockUseCacheMisses: true, kind: "eligible-miss" };
  },
  async warm(options) {
    const { warmPprFallbackShellCaches } = await import("./app-ppr-fallback-shell-render.js");
    await warmPprFallbackShellCaches(options);
  },
};

export { createAppPprFallbackShells } from "./app-ppr-fallback-shell.js";
