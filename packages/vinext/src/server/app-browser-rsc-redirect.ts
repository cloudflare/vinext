import {
  resolveHardNavigationTargetFromRscResponse,
  stripRscCacheBustingSearchParam,
  stripRscSuffix,
} from "./app-rsc-cache-busting.js";

const MAX_RSC_REDIRECT_DEPTH = 10;

type RscRedirectHistoryUpdateMode = "push" | "replace" | undefined;

type RscRedirectLifecycleDecision =
  | { href: string; kind: "no-redirect" }
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

function toStreamedRedirectVisibleAppHref(href: string, origin: string): string {
  const url = new URL(href, origin);
  return `${url.pathname}${url.search}${url.hash}`;
}

function resolveRedirectLifecycleHopFromTarget(options: {
  currentHref: string;
  historyUpdateMode: RscRedirectHistoryUpdateMode;
  maxRedirectDepth?: number;
  origin: string;
  redirectedHref: string;
  redirectDepth: number;
  requestPreviousNextUrl: string | null;
  targetUrl: URL;
}): RscRedirectLifecycleDecision {
  if (options.targetUrl.origin !== options.origin) {
    return {
      href: options.targetUrl.href,
      kind: "terminal-hard-navigation",
      reason: "externalRedirect",
      redirectDepth: options.redirectDepth,
    };
  }

  const redirectedHref = options.redirectedHref;
  if (redirectedHref === toVisibleAppHref(options.currentHref, options.origin)) {
    return { href: redirectedHref, kind: "no-redirect" };
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
  return resolveRedirectLifecycleHopFromTarget({
    ...options,
    redirectedHref: resolveHardNavigationTargetFromRscResponse(
      responseUrl.href,
      options.currentHref,
      options.origin,
    ),
    targetUrl: responseUrl,
  });
}

export function resolveStreamedRscRedirectLifecycleHop(options: {
  currentHref: string;
  historyUpdateMode: Exclude<RscRedirectHistoryUpdateMode, undefined>;
  maxRedirectDepth?: number;
  origin: string;
  redirectDepth: number;
  requestPreviousNextUrl: string | null;
  streamedRedirectTarget: string;
}): RscRedirectLifecycleDecision {
  const streamedRedirectUrl = new URL(options.streamedRedirectTarget, options.origin);
  // Streamed headers are semantic redirect targets, so preserve their target
  // path/search/hash while the shared same-target guard normalizes currentHref.
  return resolveRedirectLifecycleHopFromTarget({
    ...options,
    redirectedHref: toStreamedRedirectVisibleAppHref(
      options.streamedRedirectTarget,
      options.origin,
    ),
    targetUrl: streamedRedirectUrl,
  });
}
