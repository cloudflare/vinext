import {
  beginPprFallbackShellFinalRender,
  createPprFallbackShellState,
  getPprFallbackShellState,
  runWithPprFallbackShellState,
} from "vinext/shims/ppr-fallback-shell";
import { _setResumeDataCacheSeed } from "vinext/shims/cache-request-state";
import { markDynamicUsage } from "vinext/shims/internal/headers-state";
import { parseResumeDataCache } from "vinext/shims/resume-data-cache";
import {
  hasSearchParams,
  shouldReadAppPageCache,
  type AppPageDispatchRoute,
  type AppPagePprRuntime,
  type DispatchAppPageOptions,
} from "./app-page-dispatch.js";

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
  isForceStatic: boolean,
): Promise<Response | null> {
  const { readAppPageFallbackShellCacheResponse } = await import("./app-page-cache.js");
  const { rewriteAppPprFallbackShellHtmlNavigation } = await import("./app-ppr-fallback-shell.js");
  // Shells run from the most specific, so the first dynamic one is resumed.
  let isDynamicShellFound = false;
  for (const fallbackShell of fallbackShells) {
    const fallbackShellResponse = await readAppPageFallbackShellCacheResponse({
      clearRequestContext: options.clearRequestContext,
      expireSeconds: options.expireSeconds,
      fallbackPathname: fallbackShell.pathname,
      isEdgeRuntime: options.isEdgeRuntime,
      isrDebug: options.isrDebug,
      isrGet: options.isrGet,
      isrFallbackShellHtmlKey: options.isrFallbackShellHtmlKey,
      middlewareHeaders: options.middlewareContext.headers,
      middlewareStatus: options.middlewareContext.status,
      revalidateSeconds: currentRevalidateSeconds ?? 0,
      resumeDynamicShell(postponed, hasPrelude) {
        isDynamicShellFound = true;
        // Like Next.js, a route served from a shell resumes on every request
        // instead of storing the concrete page, while an empty shell's route
        // renders blocking and is stored.
        if (hasPrelude) markDynamicUsage();
        // vinext resumes the shell as a full render whose cached parts come
        // from the values the shell was built with. React's postponed state
        // isn't spliced into the shell's document.
        const resumeDataCache = parseResumeDataCache(postponed);
        _setResumeDataCacheSeed(resumeDataCache);
        return resumeDataCache !== null;
      },
      rewriteHtml(html) {
        return rewriteAppPprFallbackShellHtmlNavigation({
          html,
          isForceStatic,
          params: options.params,
          pathname: options.cleanPathname,
          searchParams: options.searchParams,
        });
      },
    });
    if (fallbackShellResponse) return fallbackShellResponse;
    if (isDynamicShellFound) return null;
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
    return decision.kind === "probe-fallback-shells"
      ? probePprFallbackShellCache(
          options,
          decision.fallbackShells,
          currentRevalidateSeconds,
          isForceStatic,
        )
      : null;
  },
  async warm(options) {
    const { warmPprFallbackShellCaches } = await import("./app-ppr-fallback-shell-render.js");
    await warmPprFallbackShellCaches(options);
  },
};

export { createAppPprFallbackShells } from "./app-ppr-fallback-shell.js";
