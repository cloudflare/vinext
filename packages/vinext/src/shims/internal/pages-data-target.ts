/**
 * Shared decision helper for the Pages Router `/_next/data/<id>/<page>.json`
 * navigation fast path. Used by both the router shim (for `navigateClient` and
 * `Router.prefetch`) and the Link shim (for hover/viewport prefetch).
 *
 * Lives in `shims/internal/` so neither caller pulls in the router shim at
 * module init time — link.tsx and router.ts must remain free of circular
 * imports and SSR-side router-init side effects.
 */
import { stripBasePath } from "../../utils/base-path.js";
import { getLocalePathPrefix } from "../../utils/domain-locale.js";
import type { VinextNextData } from "../../client/vinext-next-data.js";
import { buildPagesDataHref, matchPagesPattern } from "./pages-data-url.js";

export type PagesDataTarget = {
  /** Final fetch URL for the data endpoint, including basePath and search. */
  dataHref: string;
  /** Matched route pattern (e.g. `/blog/[slug]`). */
  pattern: string;
  /** Dynamic params extracted from the URL by the pattern matcher. */
  params: Record<string, string | string[]>;
  /** Code-split loader thunk for the matched route's page module. */
  loader: () => Promise<{ default?: unknown; [key: string]: unknown }>;
  /** Current buildId snapshot, used by the data URL and consistency checks. */
  buildId: string;
  /** Locale-prefixed (server-routable) page path. */
  pagePath: string;
  /** URL search string including the leading `?`. */
  search: string;
  /**
   * Locale prefix detected on the URL, or `undefined` when the URL is
   * unprefixed (default locale, or no i18n configured). Lets the caller refresh
   * locale state on locale transitions, which the data JSON envelope itself
   * does not carry.
   */
  locale: string | undefined;
};

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
  const locale = getLocalePathPrefix(pagePath, window.__VINEXT_LOCALES__);
  // `locale.length + 1` skips the `/<locale>` segment. If only the locale was
  // present (`/fr`) the remainder is empty, which normalises to `/` (root).
  const pathForMatch = locale ? pagePath.slice(locale.length + 1) || "/" : pagePath;

  const match = matchPagesPattern(pathForMatch, patterns);
  if (!match) return null;

  const loader = loaders[match.pattern];
  if (!loader) return null;

  return {
    dataHref: buildPagesDataHref(basePath, buildId, pagePath, parsed.search),
    pattern: match.pattern,
    params: match.params,
    loader,
    buildId,
    pagePath,
    search: parsed.search,
    locale,
  };
}

/**
 * Inject a `<link rel="prefetch">` for the data JSON and kick off the
 * code-split loader so the chunk is warm by the time the user clicks.
 *
 * Used by both `Router.prefetch()` and `<Link>` hover/viewport prefetch. The
 * loader's returned Promise is intentionally discarded — `import()` caches the
 * result, so a subsequent navigation re-invocation hits the cache without
 * paying for a second round trip. Errors are swallowed: prefetch is
 * best-effort and must never break the page.
 */
export function prefetchPagesData(target: PagesDataTarget): void {
  if (typeof document === "undefined") return;

  const link = document.createElement("link");
  link.rel = "prefetch";
  link.as = "fetch";
  link.crossOrigin = "anonymous";
  link.href = target.dataHref;
  document.head.appendChild(link);

  void target.loader().catch(() => {});
}
