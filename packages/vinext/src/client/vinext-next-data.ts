/**
 * vinext-specific extensions to Next.js's `NEXT_DATA`.
 *
 * The `next` package declares `Window.__NEXT_DATA__: NEXT_DATA` in its types.
 * We can't augment the `NEXT_DATA` type alias, so we extend the vinext shim's
 * interface (shims/internal/utils.ts) and cast at the usage sites.
 */
import type { NEXT_DATA } from "vinext/shims/internal/utils";
import { isUnknownRecord } from "../utils/record.js";

export type VinextLinkPrefetchRoute = {
  canPrefetchLoadingShell: boolean;
  documentOnly?: boolean;
  isDynamic: boolean;
  patternParts: string[];
  /**
   * The route's segment config rules out static generation, so Next.js
   * renders it on every request, and its automatic prefetch never renders the
   * page. Read at build time. Never set with Cache Components: segment config
   * doesn't decide what renders dynamically there, so an automatic prefetch of
   * a dynamic route without a loading boundary still renders its page
   * (Next.js prefetches its static shell instead).
   */
  rendersDynamically?: true;
  /**
   * Intercepting pages that can render a URL of this route under a matching
   * interception context. Next.js builds each as its own route, so its
   * `rendersDynamically` replaces the route's own then. Set only alongside
   * `rendersDynamically` classification.
   */
  intercepts?: VinextLinkPrefetchIntercept[];
  requiresDynamicNavigationRequest?: boolean;
  /** The route has dynamic params above its root layout. */
  hasRootParams?: true;
  /**
   * A segment's `unstable_instant` config, read at build time with Cache
   * Components: "runtime" when the route's prefetches render at runtime.
   */
  instant?: "runtime" | "static";
};

export type VinextLinkPrefetchIntercept = {
  /** The URL pattern of the route the interception context must be on, or below. */
  sourcePatternParts: string[];
  /** The URL pattern the intercepting page intercepts. */
  targetPatternParts: string[];
  rendersDynamically?: true;
  /** The intercepting page's `unstable_instant` config, as a route's `instant`. */
  instant?: "runtime" | "static";
};

/**
 * Pages Router route pattern exposed to the client so the App Router's
 * navigation runtime can decide whether a soft-navigated URL should be
 * handled by Pages (hard nav) or App (RSC). Mirrors the public shape of
 * `VinextLinkPrefetchRoute` so a single trie matcher handles both.
 *
 * `canPrefetchLoadingShell` is always `false` for Pages routes — Pages
 * does not have a separate loading boundary and its prefetch surface is
 * `_next/data/<buildId>/<page>.json`.
 */
export type VinextPagesLinkPrefetchRoute = {
  canPrefetchLoadingShell: false;
  isDynamic: boolean;
  patternParts: string[];
  requiresDynamicNavigationRequest?: boolean;
};

export type VinextNextData = {
  /** vinext-specific additions (not part of Next.js upstream). */
  __vinext?: {
    /** Absolute URL of the page module for dynamic import. */
    pageModuleUrl?: string;
    /** Absolute URL of the `_app` module for dynamic import. */
    appModuleUrl?: string;
    /** True when the Pages Router server has middleware/proxy configured. */
    hasMiddleware?: boolean;
    /** True when build-time rewrites can affect the initial Pages Router ready state. */
    hasRewrites?: boolean;
    /** Server-resolved Pages route URL used to hydrate fallback shells behind rewrites. */
    routeUrl?: string;
  };
} & NEXT_DATA;

type BrowserVinextNextData = NonNullable<Window["__NEXT_DATA__"]> & VinextNextData;

type VinextLocaleGlobalTarget = {
  __VINEXT_LOCALE__: string | undefined;
  __VINEXT_LOCALES__: string[] | undefined;
  __VINEXT_DEFAULT_LOCALE__: string | undefined;
};

export function extractVinextNextDataJson(html: string): string | null {
  const canonical =
    /<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/.exec(
      html,
    );
  if (canonical) return canonical[1];

  const assignment = /<script(?:\s[^>]*)?>\s*window\.__NEXT_DATA__\s*=\s*/.exec(html);
  if (!assignment || assignment.index === undefined) return null;

  let start = assignment.index + assignment[0].length;
  while (
    html[start] === " " ||
    html[start] === "\n" ||
    html[start] === "\t" ||
    html[start] === "\r"
  ) {
    start++;
  }
  if (html[start] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < html.length; index++) {
    const char = html[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }

  return null;
}

export function parseVinextNextDataJson(json: string): BrowserVinextNextData {
  const parsed: unknown = JSON.parse(json);
  if (!isBrowserVinextNextData(parsed)) {
    throw new Error("Navigation failed: invalid __NEXT_DATA__ in response");
  }
  return parsed;
}

function isBrowserVinextNextData(value: unknown): value is BrowserVinextNextData {
  if (!isUnknownRecord(value)) return false;

  const props = value.props;
  const page = value.page;
  const query = value.query;
  const vinext = value.__vinext;

  return (
    isUnknownRecord(props) &&
    typeof page === "string" &&
    isUnknownRecord(query) &&
    (vinext === undefined || isUnknownRecord(vinext))
  );
}

export function applyVinextLocaleGlobals(
  target: VinextLocaleGlobalTarget,
  nextData: VinextNextData,
): void {
  if (nextData.locale !== undefined) {
    target.__VINEXT_LOCALE__ = nextData.locale;
  }
  if (nextData.locales !== undefined) {
    target.__VINEXT_LOCALES__ = [...nextData.locales];
  }
  if (nextData.defaultLocale !== undefined) {
    target.__VINEXT_DEFAULT_LOCALE__ = nextData.defaultLocale;
  }
}
