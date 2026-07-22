import { hasBasePath, stripBasePath } from "../utils/base-path.js";
import { isAbsoluteOrProtocolRelativeUrl } from "./url-utils.js";

export type LinkPrefetchIntent = "viewport" | "intent";
export type LinkPrefetchPriority = "low" | "high";
export type LinkPrefetchRouterMode = "app" | "pages";

export type LinkPrefetchDecision =
  | {
      shouldPrefetch: false;
    }
  | {
      shouldPrefetch: true;
      priority: LinkPrefetchPriority;
    };

export function canLinkPrefetch(input: {
  nodeEnv: string | undefined;
  prefetch: boolean | "auto" | null | undefined;
  isDangerous: boolean;
}): boolean {
  return input.nodeEnv === "production" && input.prefetch !== false && !input.isDangerous;
}

export function canLinkIntentPrefetch(input: {
  nodeEnv: string | undefined;
  prefetch: boolean | "auto" | null | undefined;
  isDangerous: boolean;
  routerMode: LinkPrefetchRouterMode;
}): boolean {
  if (input.nodeEnv !== "production" || input.isDangerous) return false;
  return input.routerMode === "pages" || input.prefetch !== false;
}

export function getLinkPrefetchDecision(input: {
  nodeEnv: string | undefined;
  prefetch: boolean | "auto" | null | undefined;
  isDangerous: boolean;
  intent: LinkPrefetchIntent;
  routerMode?: LinkPrefetchRouterMode;
}): LinkPrefetchDecision {
  const shouldPrefetch =
    input.intent === "intent"
      ? canLinkIntentPrefetch({
          ...input,
          routerMode: input.routerMode ?? "app",
        })
      : canLinkPrefetch(input);
  if (!shouldPrefetch) return { shouldPrefetch: false };

  return {
    shouldPrefetch: true,
    priority: input.intent === "intent" ? "high" : "low",
  };
}

/**
 * Normalize absolute and protocol-relative Link hrefs to app-relative paths
 * that are eligible for prefetching. Non-absolute relative hrefs are returned
 * unchanged; callers must resolve them against the current browser URL before
 * constructing a concrete fetch target.
 */
export function getLinkPrefetchHref(input: {
  href: string;
  basePath: string;
  currentOrigin: string | undefined;
}): string | null {
  const { href, basePath, currentOrigin } = input;
  if (!isAbsoluteOrProtocolRelativeUrl(href)) return href;
  if (currentOrigin === undefined) return null;

  try {
    const current = new URL(currentOrigin);
    const parsed = href.startsWith("//") ? new URL(href, current.origin) : new URL(href);
    if (parsed.origin !== current.origin) return null;

    if (!basePath) {
      return parsed.pathname + parsed.search + parsed.hash;
    }

    if (!hasBasePath(parsed.pathname, basePath)) {
      return null;
    }

    return stripBasePath(parsed.pathname, basePath) + parsed.search + parsed.hash;
  } catch {
    return null;
  }
}
