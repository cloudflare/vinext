import {
  resolveHardNavigationTargetFromRscResponse,
  stripRscCacheBustingSearchParam,
  stripRscSuffix,
} from "./app-rsc-cache-busting.js";

export const MAX_RSC_REDIRECT_DEPTH = 10;

type RscRedirectHistoryUpdateMode = "push" | "replace" | undefined;

type RscRedirectLifecycleDecision =
  | { kind: "no-redirect" }
  | {
      href: string;
      historyUpdateMode: RscRedirectHistoryUpdateMode;
      kind: "follow";
      previousNextUrl: string | null;
      redirectDepth: number;
    }
  | {
      href: string;
      kind: "terminal-hard-navigation";
      reason: "externalRedirect" | "maxRedirectsExceeded";
      redirectDepth: number;
    };

function toVisibleAppHref(href: string, origin: string): string {
  const url = new URL(href, origin);
  stripRscCacheBustingSearchParam(url);
  return `${stripRscSuffix(url.pathname)}${url.search}${url.hash}`;
}

export function resolveRscRedirectLifecycleHop(options: {
  currentHref: string;
  historyUpdateMode: RscRedirectHistoryUpdateMode;
  maxRedirectDepth?: number;
  origin: string;
  redirectDepth: number;
  requestPreviousNextUrl: string | null;
  responseUrl: string;
}): RscRedirectLifecycleDecision {
  const responseUrl = new URL(options.responseUrl, options.origin);

  if (responseUrl.origin !== options.origin) {
    return {
      href: responseUrl.href,
      kind: "terminal-hard-navigation",
      reason: "externalRedirect",
      redirectDepth: options.redirectDepth,
    };
  }

  const redirectedHref = resolveHardNavigationTargetFromRscResponse(
    responseUrl.href,
    options.currentHref,
    options.origin,
  );
  if (redirectedHref === toVisibleAppHref(options.currentHref, options.origin)) {
    return { kind: "no-redirect" };
  }

  const maxRedirectDepth = options.maxRedirectDepth ?? MAX_RSC_REDIRECT_DEPTH;
  if (options.redirectDepth >= maxRedirectDepth) {
    return {
      href: redirectedHref,
      kind: "terminal-hard-navigation",
      reason: "maxRedirectsExceeded",
      redirectDepth: options.redirectDepth,
    };
  }

  return {
    href: redirectedHref,
    historyUpdateMode: options.historyUpdateMode,
    kind: "follow",
    previousNextUrl: options.requestPreviousNextUrl,
    redirectDepth: options.redirectDepth + 1,
  };
}
