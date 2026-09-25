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
import { shouldServeStreamingMetadata } from "./streaming-metadata.js";

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
        | "skip-blocking-metadata"
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
  // Mirrors Next.js's `shouldForceDynamicPPRRender = isRoutePPREnabled &&
  // !serveStreamingMetadata`: a fallback shell has already closed its head
  // before the dynamic render resumes, so blocking metadata resolved during
  // the resume would be emitted after the head, where HTML-limited bots
  // cannot observe it. Bypassing the shell lets that metadata land in the
  // initial document head instead.
  if (
    !shouldServeStreamingMetadata(
      options.request.headers.get("user-agent") ?? "",
      options.htmlLimitedBots,
    )
  ) {
    return { kind: "skip-blocking-metadata" };
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
  for (const fallbackShell of fallbackShells) {
    const fallbackShellResponse = await readAppPageFallbackShellCacheResponse({
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
