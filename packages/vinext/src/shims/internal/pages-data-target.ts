/**
 * Shared decision helper for the Pages Router `/_next/data/<id>/<page>.json`
 * navigation fast path. Used by both the router shim (for `navigateClient` and
 * `Router.prefetch`) and the Link shim (for hover/viewport prefetch).
 *
 * Lives in `shims/internal/` so neither caller pulls in the router shim at
 * module init time — link.tsx and router.ts must remain free of circular
 * imports and SSR-side router-init side effects.
 */
import { removeTrailingSlash, stripBasePath } from "../../utils/base-path.js";
import { getLocalePathPrefix } from "../../utils/domain-locale.js";
import type { VinextNextData } from "../../client/vinext-next-data.js";
import { buildPagesDataHref, matchPagesPattern } from "./pages-data-url.js";
import { fetchCachedPagesData, fetchStaticPagesData } from "./pages-data-fetch-dedup.js";
import { getDeploymentId, NEXT_DEPLOYMENT_ID_HEADER } from "../../utils/deployment-id.js";
import { isUnknownRecord } from "../../utils/record.js";

export type PagesDataTarget = {
  /** Final fetch URL for the data endpoint, including basePath and search. */
  dataHref: string;
  /** Matched route pattern (e.g. `/blog/[slug]`). */
  pattern: string;
  /** Dynamic params extracted from the URL by the pattern matcher. */
  params: Record<string, string | string[]>;
  /** Code-split loader thunk for the matched route's page module. */
  loader: () => Promise<{ default?: unknown; [key: string]: unknown }>;
  /** Next.js data-fetch mode for this route. Plain pages are component-only. */
  dataKind: "none" | "server" | "static";
  /** Middleware-effect data URL to prefetch when the static matcher includes this route. */
  middlewareDataHref?: string;
  /** Current buildId snapshot, used by the data URL and consistency checks. */
  buildId: string;
  /** Locale-prefixed (server-routable) page path. */
  pagePath: string;
  /** URL search string including the leading `?`. */
  search: string;
  /**
   * Active locale for this data request. Locale-prefixed browser URLs use the
   * URL prefix; unprefixed i18n URLs use the current/default locale because
   * Next.js still includes that segment in `/_next/data` paths.
   */
  locale: string | undefined;
};

type PagesDataLocalePath = {
  dataPagePath: string;
  locale: string | undefined;
};

function prefixPagesDataPathWithLocale(pagePath: string, locale: string): string {
  return pagePath === "/" ? `/${locale}` : `/${locale}${pagePath}`;
}

function resolvePagesDataLocalePath(
  pagePath: string,
  locales: readonly string[] | undefined,
  currentLocale: string | undefined,
  defaultLocale: string | undefined,
): PagesDataLocalePath {
  if (!locales || locales.length === 0) {
    return { dataPagePath: pagePath, locale: undefined };
  }

  const pathLocale = getLocalePathPrefix(pagePath, locales);
  if (pathLocale) {
    return { dataPagePath: pagePath, locale: pathLocale };
  }

  const activeLocale = currentLocale ?? defaultLocale;
  if (!activeLocale || !locales.includes(activeLocale)) {
    return { dataPagePath: pagePath, locale: undefined };
  }

  if (activeLocale === defaultLocale) {
    return { dataPagePath: pagePath, locale: activeLocale };
  }

  return {
    dataPagePath: prefixPagesDataPathWithLocale(pagePath, activeLocale),
    locale: activeLocale,
  };
}

type ClientMiddlewareMatcherObject = {
  source: string;
  locale?: false;
  has?: unknown[];
  missing?: unknown[];
};

function hasVinextMiddleware(nextData: unknown): boolean {
  if (!isUnknownRecord(nextData)) return false;
  const vinext = nextData.__vinext;
  return isUnknownRecord(vinext) && vinext.hasMiddleware === true;
}

function isClientMiddlewareMatcherObject(value: unknown): value is ClientMiddlewareMatcherObject {
  if (!isUnknownRecord(value)) return false;
  if (typeof value.source !== "string") return false;
  if (value.locale !== undefined && value.locale !== false) return false;
  if (value.has !== undefined && !Array.isArray(value.has)) return false;
  if (value.missing !== undefined && !Array.isArray(value.missing)) return false;
  return true;
}

function stripLocaleForMiddlewareMatcher(pathname: string): string {
  const locales = window.__VINEXT_LOCALES__;
  if (!locales || locales.length === 0 || pathname === "/") return pathname;
  const firstSegment = pathname.split("/")[1];
  if (!firstSegment || !locales.includes(firstSegment)) return pathname;
  return "/" + pathname.split("/").slice(2).join("/");
}

function clientMiddlewareSourceMatches(pathname: string, source: string): boolean {
  if (!/[\\():*+?]/.test(source)) {
    return removeTrailingSlash(pathname) === removeTrailingSlash(source);
  }

  if (source.includes("(") || source.includes("\\")) return true;

  const sourceParts = source.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  let pathIndex = 0;

  for (const sourcePart of sourceParts) {
    if (sourcePart.startsWith(":")) {
      if (sourcePart.endsWith("*")) return true;
      if (sourcePart.endsWith("+")) return pathIndex < pathParts.length;
      if (pathIndex >= pathParts.length) return false;
      pathIndex++;
      continue;
    }

    if (pathParts[pathIndex] !== sourcePart) return false;
    pathIndex++;
  }

  return pathIndex === pathParts.length;
}

function clientMiddlewareMatcherMatches(pathname: string, matcher: unknown): boolean {
  if (matcher === undefined) return true;
  if (typeof matcher === "string") {
    return clientMiddlewareSourceMatches(stripLocaleForMiddlewareMatcher(pathname), matcher);
  }
  if (!Array.isArray(matcher)) return true;

  for (const item of matcher) {
    if (typeof item === "string") {
      if (clientMiddlewareSourceMatches(stripLocaleForMiddlewareMatcher(pathname), item)) {
        return true;
      }
      continue;
    }
    if (!isClientMiddlewareMatcherObject(item)) return true;
    const candidate = item.locale === false ? pathname : stripLocaleForMiddlewareMatcher(pathname);
    if (clientMiddlewareSourceMatches(candidate, item.source)) {
      return true;
    }
  }

  return false;
}

export function getPagesMiddlewareDataHref(
  browserUrl: string,
  basePath: string,
  activeLocaleOverride?: string,
): string | null {
  const nextData = window.__NEXT_DATA__;
  if (!nextData || !hasVinextMiddleware(nextData)) return null;
  const buildId = nextData.buildId;
  if (typeof buildId !== "string" || buildId.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(browserUrl, window.location.href);
  } catch {
    return null;
  }
  if (parsed.origin !== window.location.origin) return null;

  const pagePath = stripBasePath(parsed.pathname, basePath);
  if (!clientMiddlewareMatcherMatches(pagePath, window.__VINEXT_MIDDLEWARE_MATCHER__)) {
    return null;
  }

  const { dataPagePath } = resolvePagesDataLocalePath(
    pagePath,
    window.__VINEXT_LOCALES__,
    activeLocaleOverride ?? window.__VINEXT_LOCALE__,
    window.__VINEXT_DEFAULT_LOCALE__,
  );
  return buildPagesDataHref(basePath, buildId, dataPagePath, parsed.search);
}

/**
 * Decide whether the JSON data-endpoint navigation path is usable for this
 * browser URL. We require:
 *   - A registered code-split loader for the matched route pattern. Without
 *     this, the client has no chunk URL to import for the new page.
 *   - A buildId on the current `__NEXT_DATA__`, since the data URL embeds it.
 *   - Same-origin (cross-origin URLs do not hit our data endpoint).
 *
 * Locale handling: route patterns in `__VINEXT_PAGE_PATTERNS__` are
 * locale-unaware (`/about`, not `/fr/about`), but the browser URL for a
 * locale-prefixed page is `/fr/about`. We strip the locale prefix before
 * pattern matching so locale transitions hit the JSON fast path. The data URL
 * itself keeps the locale prefix because the server uses it to pick
 * locale-specific gSSP data.
 *
 * Returns the resolved target, or `null` to signal the caller should fall
 * back to the HTML extraction path (dev server, or a route that exists on the
 * server but is not in the client loader map).
 *
 * Ported from Next.js: `packages/next/src/client/page-loader.ts`
 * (`getDataHref`). vinext's equivalent uses an in-memory loader map instead
 * of Next.js' `_buildManifest.js`.
 */
export function resolvePagesDataNavigationTarget(
  browserUrl: string,
  basePath: string,
  activeLocaleOverride?: string,
): PagesDataTarget | null {
  if (typeof window === "undefined") return null;

  const loaders = window.__VINEXT_PAGE_LOADERS__;
  const patterns = window.__VINEXT_PAGE_PATTERNS__;
  if (!loaders || !patterns || patterns.length === 0) return null;

  const buildId = (window.__NEXT_DATA__ as VinextNextData | undefined)?.buildId ?? undefined;
  if (!buildId) return null;

  let parsed: URL;
  try {
    parsed = new URL(browserUrl, window.location.href);
  } catch {
    return null;
  }
  if (parsed.origin !== window.location.origin) return null;

  const pagePath = stripBasePath(parsed.pathname, basePath);
  const pathLocale = getLocalePathPrefix(pagePath, window.__VINEXT_LOCALES__);
  // `pathLocale.length + 1` skips the `/<locale>` segment. If only the locale
  // was present (`/fr`) the remainder is empty, which normalises to `/` (root).
  const pathForMatch = pathLocale ? pagePath.slice(pathLocale.length + 1) || "/" : pagePath;

  const match = matchPagesPattern(pathForMatch, patterns);
  if (!match) return null;

  const loader = loaders[match.pattern];
  if (!loader) return null;
  const ssgPatterns = window.__VINEXT_PAGES_SSG_PATTERNS__;
  const sspPatterns = window.__VINEXT_PAGES_SSP_PATTERNS__;
  const dataKind = ssgPatterns?.includes(match.pattern)
    ? "static"
    : sspPatterns?.includes(match.pattern)
      ? "server"
      : // Older generated entries only exposed the SSG manifest. Preserve the
        // previous safe behaviour with those entries; fresh builds expose both
        // manifests and can distinguish plain pages from GSSP pages.
        ssgPatterns === undefined || sspPatterns === undefined
        ? "server"
        : "none";

  const { dataPagePath, locale } = resolvePagesDataLocalePath(
    pagePath,
    window.__VINEXT_LOCALES__,
    activeLocaleOverride ?? window.__VINEXT_LOCALE__,
    window.__VINEXT_DEFAULT_LOCALE__,
  );

  return {
    dataHref: buildPagesDataHref(basePath, buildId, dataPagePath, parsed.search),
    pattern: match.pattern,
    params: match.params,
    loader,
    dataKind,
    middlewareDataHref:
      getPagesMiddlewareDataHref(browserUrl, basePath, activeLocaleOverride) ?? undefined,
    buildId,
    pagePath,
    search: parsed.search,
    locale,
  };
}

/**
 * Kick off the code-split loader and, for SSG pages, prefetch the data JSON so
 * the chunk and payload are warm by the time the user clicks.
 *
 * Used by both `Router.prefetch()` and `<Link>` hover/viewport prefetch.
 * Matches Next.js Pages Router prefetch: non-SSG routes only warm the page
 * chunk, while `getStaticProps` routes also fetch `/_next/data`.
 *
 * loader's returned Promise is intentionally discarded — `import()` caches the
 * result, so a subsequent navigation re-invocation hits the cache without
 * paying for a second round trip. Errors are swallowed: prefetch is
 * best-effort and must never break the page.
 */
export function prefetchPagesData(target: PagesDataTarget): void {
  if (typeof document === "undefined") return;

  void target.loader().catch(() => {});

  if (target.dataKind !== "static" && !target.middlewareDataHref) return;

  const headers: Record<string, string> = {
    Accept: "application/json",
    purpose: "prefetch",
    "x-nextjs-data": "1",
  };
  if (target.middlewareDataHref) headers["x-middleware-prefetch"] = "1";
  const deploymentId = getDeploymentId();
  if (deploymentId) headers[NEXT_DEPLOYMENT_ID_HEADER] = deploymentId;

  if (target.dataKind === "static") {
    const dataHref = target.middlewareDataHref ?? target.dataHref;
    void fetchStaticPagesData(dataHref, { headers }).catch(() => {});
    return;
  }

  if (target.middlewareDataHref) {
    void fetchCachedPagesData(target.middlewareDataHref, { headers }).catch(() => {});
  }
}
