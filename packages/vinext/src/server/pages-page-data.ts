import type { ReactNode } from "react";
import type { VinextNextData } from "../client/vinext-next-data.js";
import type { Route } from "../routing/pages-router.js";
import { normalizeStaticPathname } from "../routing/route-pattern.js";
import { normalizePathnameForRouteMatch } from "../routing/utils.js";
import type {
  CachedPagesValue,
  CachedRedirectValue,
  CacheHandlerValue,
  CacheControlMetadata,
} from "vinext/shims/cache-handler";
import { applyCdnResponseHeaders } from "./cache-control.js";
import { buildMissIsrCacheControl, decideIsr } from "./isr-decision.js";
import { buildCacheStateHeaders } from "./cache-headers.js";
import { buildPagesCacheValue, type ISRCacheEntry } from "./isr-cache.js";
import type { PagesPreviewData } from "./pages-preview.js";
import {
  buildPagesNextDataScript,
  etagMatches,
  generatePagesETag,
  isPagesStreamingBot,
  requestsNoCache,
  type PagesGsspResponse,
  type PagesI18nRenderContext,
  type PagesNextDataExtras,
} from "./pages-page-response.js";
import {
  createPagesGetInitialPropsRouter,
  hasPagesGetInitialProps,
  isResponseSent,
  loadPagesGetInitialProps,
  type PagesGetInitialPropsRouter,
} from "./pages-get-initial-props.js";
import { buildNextDataPropsJsonResponse } from "./pages-data-route.js";
import { NEXTJS_CACHE_HEADER, NEXTJS_DEPLOYMENT_ID_HEADER } from "./headers.js";
import { isSerializableProps } from "./pages-serializable-props.js";
import { isBotUserAgent } from "../utils/html-limited-bots.js";
import { isUnknownRecord } from "../utils/record.js";
import { isDangerousScheme } from "vinext/shims/url-safety";
import { encodeCacheTag } from "../utils/encode-cache-tag.js";

export type PagesRedirectResult = {
  destination: string;
  permanent?: boolean;
  statusCode?: number;
  basePath?: boolean;
};

export type ResolvedPagesRedirect = {
  destination: string;
  statusCode: number;
  basePath?: boolean;
};

const ALLOWED_PAGES_REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/** Headers that are part of a cached Pages representation, never request state. */
function isCachedPagesRepresentationHeader(name: string): boolean {
  const lowerName = name.toLowerCase();
  return lowerName === "location" || lowerName === "content-type";
}

// Next.js allows `paths` entries to be either an object with a `params` key
// or a raw string path. We keep a local variant of `StaticPathsEntry` here
// because at request time we compare against the actual request `params`
// (whose value type is `unknown` from the route matcher) rather than the
// `string | string[]` shape used at build time. The shared
// `normalizeStaticPathname` helper from `../routing/route-pattern.js` is used
// to canonicalize the string-entry comparison.
export type PagesStaticPathsEntry =
  | string
  | {
      params?: Record<string, unknown>;
      locale?: string;
    };

type PagesStaticPathsResult = {
  fallback?: boolean | "blocking";
  paths?: PagesStaticPathsEntry[];
};

type PagesPagePropsResult = {
  props?: Record<string, unknown> | Promise<Record<string, unknown>>;
  redirect?: PagesRedirectResult;
  notFound?: boolean;
  revalidate?: unknown;
};

export function assertPages404DoesNotReturnNotFound(
  routePattern: string,
  result: Pick<PagesPagePropsResult, "notFound"> | null | undefined,
): void {
  if (routePattern === "/404" && result?.notFound) {
    throw new Error(
      'The /404 page can not return notFound in "getStaticProps", please remove it to continue!',
    );
  }
}

/**
 * Next.js preserves an omitted/false Pages `revalidate` result as an indefinite
 * cache lifetime. The one-year sentinel is only an HTTP Cache-Control detail;
 * storing it as a revalidation deadline would incorrectly regenerate static
 * pages after one year.
 *
 * Next.js source:
 * - packages/next/src/server/render.tsx (`metadata.cacheControl`)
 * - packages/next/src/server/route-modules/pages/pages-handler.ts
 */
export function resolvePagesRevalidateSeconds(
  result: PagesPagePropsResult,
  routeUrl = "",
): number | false {
  const revalidate = result.revalidate;
  if (revalidate === true) return 1;
  if (typeof revalidate === "number") {
    if (!Number.isInteger(revalidate)) {
      throw new Error(
        `A page's revalidate option must be seconds expressed as a natural number for ${routeUrl}. Mixed numbers, such as '${revalidate}', cannot be used.`,
      );
    }
    if (revalidate <= 0) {
      throw new Error(
        `A page's revalidate option can not be less than or equal to zero for ${routeUrl}.`,
      );
    }
    return revalidate;
  }
  if (revalidate === false || revalidate === undefined) return false;
  throw new Error(
    `A page's revalidate option must be seconds expressed as a natural number. Mixed numbers and strings cannot be used. Received '${JSON.stringify(revalidate)}' for ${routeUrl}`,
  );
}

function resolvePagesExpireSeconds(
  result: PagesPagePropsResult,
  configuredExpireSeconds: number | undefined,
): number | undefined {
  return result.revalidate === false || result.revalidate === undefined
    ? undefined
    : configuredExpireSeconds;
}

type PagesMutableGsspResponse = {
  headersSent: boolean;
} & PagesGsspResponse;

type PagesGsspContextResponse = {
  req: unknown;
  res: PagesMutableGsspResponse;
  responsePromise: Promise<Response>;
};

type PagesRenderProps = Record<string, unknown> & {
  pageProps?: unknown;
};

/**
 * Merge gSP/gSSP data into the custom App's raw pageProps value.
 *
 * Next.js deliberately uses Object.assign rather than object spread, so
 * enumerable keys from arrays and primitive wrapper objects are retained.
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/render.tsx
 */
export function mergePagesDataProps(
  appPageProps: unknown,
  dataProps: unknown,
): Record<string, unknown> {
  return Object.assign({}, appPageProps, dataProps) as Record<string, unknown>;
}

export type PagesPageModule = {
  default?: unknown;
  getStaticPaths?: (context: {
    locales: string[];
    defaultLocale: string;
  }) => Promise<PagesStaticPathsResult> | PagesStaticPathsResult;
  /**
   * Pages Router data-fetching context.
   *
   * `params` is `null` for non-dynamic routes (no `[param]` segments) to
   * match Next.js. User code typically falls back via `params || null`, so
   * passing `null` (rather than `{}`) is required for the value to be
   * observable as `null` once the data flows through to the page props.
   *
   * See: test/e2e/edge-pages-support/index.test.ts in Next.js for the
   * authoritative assertion (`expect(props.params).toBe(null)`).
   */
  getServerSideProps?: (context: {
    params: Record<string, unknown> | null;
    req: unknown;
    res: PagesMutableGsspResponse;
    query: Record<string, unknown>;
    resolvedUrl: string;
    locale?: string;
    locales?: string[];
    defaultLocale?: string;
    draftMode?: true;
    preview?: true;
    previewData?: PagesPreviewData;
  }) => Promise<PagesPagePropsResult> | PagesPagePropsResult;
  getStaticProps?: (context: {
    params: Record<string, unknown> | null;
    locale?: string;
    locales?: string[];
    defaultLocale?: string;
    draftMode?: true;
    preview?: true;
    previewData?: PagesPreviewData;
    /**
     * Indicates why `getStaticProps` was invoked.
     *
     * - `"build"`: initial build-time prerender (before runtime traffic).
     * - `"on-demand"`: triggered by `res.revalidate()` from an API route.
     * - `"stale"`: stale-while-revalidate background regeneration.
     *
     * Mirrors Next.js `render.tsx`'s `revalidateReason` on the
     * `GetStaticPropsContext` type — see
     * `.nextjs-ref/packages/next/src/types.ts`.
     */
    revalidateReason?: "build" | "on-demand" | "stale";
  }) => Promise<PagesPagePropsResult> | PagesPagePropsResult;
};

type RenderPagesIsrHtmlOptions = {
  buildId: string | null;
  cachedHtml: string;
  createPageElement: (props: Record<string, unknown>) => ReactNode;
  i18n: PagesI18nRenderContext;
  pageProps: Record<string, unknown>;
  props?: Record<string, unknown>;
  params: Record<string, unknown>;
  renderIsrPassToStringAsync: (element: ReactNode) => Promise<string>;
  routePattern: string;
  safeJsonStringify: (value: unknown) => string;
  vinext?: VinextNextData["__vinext"];
  nextData?: PagesNextDataExtras;
};

export type ResolvePagesPageDataOptions = {
  applyRequestContexts: () => void;
  basePath?: string;
  buildId: string | null;
  /**
   * When true, this is a `/_next/data/<buildId>/<page>.json` request. Callers
   * that respond with a JSON envelope (`{ pageProps }`) instead of HTML must
   * bypass the HTML ISR cache: a cached HTML body cannot be reshaped into the
   * expected JSON shape, and storing JSON in the HTML cache would corrupt
   * subsequent HTML hits. Next.js handles this the same way — see
   * `isNextDataRequest` checks in `packages/next/src/server/base-server.ts`.
   */
  isDataReq?: boolean;
  err?: unknown;
  createGsspReqRes: () => PagesGsspContextResponse;
  createAppTree?: (props: Record<string, unknown>) => ReactNode;
  createPageElement: (props: Record<string, unknown>) => ReactNode;
  fontLinkHeader: string;
  i18n: PagesI18nRenderContext;
  isrCacheKey: (router: string, pathname: string) => string;
  isrGet: (key: string) => Promise<ISRCacheEntry | null>;
  isrSet: (
    key: string,
    data: CachedPagesValue | CachedRedirectValue | null,
    revalidateSeconds: number | false,
    tags?: string[],
    expireSeconds?: number,
  ) => Promise<void>;
  expireSeconds?: number;
  /**
   * When true, this dispatch corresponds to a build-time prerender (the
   * `vinext` build phase fetches each statically generated page through the
   * production server). Maps to `revalidateReason: "build"` when
   * `getStaticProps` is invoked. Mirrors Next.js's
   * `renderOpts.isBuildTimePrerendering` flag — see
   * `.nextjs-ref/packages/next/src/server/render.tsx`.
   */
  isBuildTimePrerendering?: boolean;
  validatePropsSerialization?: boolean;
  /**
   * When true, this dispatch was triggered by an on-demand revalidation
   * request (e.g. `res.revalidate()` in a Pages Router API route, or an
   * equivalent webhook). Maps to `revalidateReason: "on-demand"` when
   * `getStaticProps` is invoked, and bypasses the fresh/stale cache-hit
   * short-circuits so the entry is regenerated synchronously. Mirrors Next.js's
   * `renderOpts.isOnDemandRevalidate` flag — see
   * `.nextjs-ref/packages/next/src/server/render.tsx`.
   *
   * The page handler sets this only when the incoming request's
   * `x-prerender-revalidate` header (`PRERENDER_REVALIDATE_HEADER`) *equals* the
   * process revalidate secret that `res.revalidate()` attaches to its internal
   * request (`isOnDemandRevalidateRequest`). It is never set on mere header
   * presence — see the security note in `isr-cache.ts`.
   */
  isOnDemandRevalidate?: boolean;
  /**
   * When true alongside an authenticated on-demand request, return a
   * successful 404 no-op if no cache entry exists instead of generating a new
   * fallback path. Mirrors Next.js `unstable_onlyGenerated`.
   */
  revalidateOnlyGenerated?: boolean;
  previewData?: PagesPreviewData | false;
  /**
   * The deployment ID used for deployment-skew protection. When set, it is
   * included as `x-nextjs-deployment-id` on all `_next/data` responses
   * (success, redirect, notFound). Mirrors Next.js pages-handler.ts behavior.
   * Typically sourced from `process.env.__VINEXT_DEPLOYMENT_ID || process.env.NEXT_DEPLOYMENT_ID`.
   */
  deploymentId?: string;
  htmlLimitedBots?: string;
  pageModule: PagesPageModule;
  AppComponent?: unknown;
  /** The request-scoped `next/router` server instance when available. */
  router?: PagesGetInitialPropsRouter;
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  asPath?: string;
  resolvedUrl?: string;
  route: Pick<Route, "isDynamic">;
  routePattern: string;
  routeUrl: string;
  /**
   * Filesystem-route identity used for Pages ISR reads and writes. Error pages
   * render against the original request URL but cache under /404, /500, or
   * /_error, matching Next.js's error-page cache-key override.
   */
  isrCachePathname?: string;
  runInFreshUnifiedContext: <T>(callback: () => Promise<T>) => Promise<T>;
  safeJsonStringify: (value: unknown) => string;
  sanitizeDestination: (destination: string) => string;
  scriptNonce?: string;
  statusCode?: number;
  triggerBackgroundRegeneration: (
    key: string,
    renderFn: () => Promise<void>,
    errorContext?: { routerKind: "Pages Router"; routePath: string; routeType: "render" },
  ) => void;
  renderIsrPassToStringAsync: (element: ReactNode) => Promise<string>;
  vinext?: VinextNextData["__vinext"];
  nextData?: PagesNextDataExtras;
  /**
   * The request's User-Agent string. When this matches a known crawler/bot
   * pattern, ISR cache-HIT and cache-STALE responses receive an ETag header
   * for consistency with the fresh-MISS path (which also attaches an ETag for
   * bot UAs via `renderPagesPageResponse`). See the divergence note in
   * `pages-page-response.ts` for why UA-gating is used instead of Next.js's
   * `isDynamic` check.
   */
  userAgent?: string;
  /**
   * The incoming request's `If-None-Match` header value. When the cached HTML
   * ETag matches (weak-ETag semantics), the ISR cache-HIT or cache-STALE
   * response is a `304 Not Modified` with no body.
   */
  ifNoneMatch?: string;
  /**
   * The incoming request's `Cache-Control` header value. When it contains
   * `no-cache`, the 304 short-circuit is skipped and a full response is
   * returned — mirroring the `fresh` package used by Next.js.
   */
  requestCacheControl?: string;
};

type ResolvePagesPageDataRenderResult = {
  kind: "render";
  documentReqRes: PagesGsspContextResponse | null;
  gsspRes: PagesGsspResponse | null;
  isrRevalidateSeconds: number | false | null;
  isrExpireSeconds?: number;
  pageProps: Record<string, unknown>;
  props: PagesRenderProps;
  /**
   * True when `getStaticPaths` returned `fallback: true` AND the requested path
   * is not in the pre-rendered list. The caller renders a loading shell with
   * empty props and `useRouter().isFallback === true` (matching Next.js's
   * `render.tsx` — `getStaticProps` is skipped on the fallback render).
   */
  isFallback: boolean;
};

type ResolvePagesPageDataResponseResult = {
  kind: "response";
  response: Response;
  /** False when an on-demand request must be reported as a failed revalidation. */
  onDemandRevalidateSuccess?: boolean;
};

type ResolvePagesPageDataNotFoundResult = {
  kind: "notFound";
  /** Current getStaticProps cache lifetime, when this is an SSG result. */
  revalidateSeconds?: number | false;
  expireSeconds?: number;
  cacheState?: "MISS" | "HIT" | "STALE";
};

type ResolvePagesPageDataResult =
  | ResolvePagesPageDataRenderResult
  | ResolvePagesPageDataResponseResult
  | ResolvePagesPageDataNotFoundResult;

function buildPagesDataNotFoundResponse(deploymentId?: string): Response {
  // Next.js preserves the canonical notFound representation for data requests
  // so the client router can distinguish it from an unknown data route.
  // Mirror Next.js pages-handler.ts: set x-nextjs-deployment-id on all
  // `_next/data` notFound exits so the client can detect a new deployment.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deploymentId) {
    headers[NEXTJS_DEPLOYMENT_ID_HEADER] = deploymentId;
  }
  return new Response('{"notFound":true}', {
    status: 404,
    headers,
  });
}

function buildPagesNotFoundResult(
  options: Pick<ResolvePagesPageDataOptions, "isDataReq" | "deploymentId">,
  revalidateSeconds?: number | false,
  cacheState?: "MISS" | "HIT" | "STALE",
  expireSeconds?: number,
): ResolvePagesPageDataResponseResult | ResolvePagesPageDataNotFoundResult {
  if (options.isDataReq) {
    return {
      kind: "response",
      response: buildPagesDataNotFoundResponse(options.deploymentId),
    };
  }

  return { kind: "notFound", revalidateSeconds, expireSeconds, cacheState };
}

function applyPagesTerminalMissHeaders(
  response: Response,
  revalidateSeconds: number | false,
  isrCachePathname: string,
  expireSeconds?: number,
): Response {
  const stem = isrCachePathname.endsWith("/") ? isrCachePathname.slice(0, -1) : isrCachePathname;
  applyCdnResponseHeaders(response.headers, {
    cacheControl: buildMissIsrCacheControl(revalidateSeconds, expireSeconds),
    tags: [encodeCacheTag(`_N_T_${stem || "/"}`)],
  });
  for (const [name, value] of Object.entries(buildCacheStateHeaders("MISS"))) {
    response.headers.set(name, value);
  }
  return response;
}

function applyCachedPagesRepresentationHeaders(
  response: Response,
  cacheState: "HIT" | "STALE",
  entry: CacheHandlerValue,
  options: Pick<ResolvePagesPageDataOptions, "expireSeconds">,
): Response {
  const { cacheControl } = decideIsr({
    cacheState,
    kind: "pages",
    revalidateSeconds: entry.cacheControl?.revalidate ?? 60,
    // Persisted Pages metadata is authoritative. A missing expire is how
    // `revalidate: false` is represented and must not inherit expireTime.
    expireSeconds: entry.cacheControl?.expire === undefined ? undefined : options.expireSeconds,
    cacheControlMeta: entry.cacheControl,
  });
  applyCdnResponseHeaders(response.headers, { cacheControl });
  for (const [name, value] of Object.entries(buildCacheStateHeaders(cacheState))) {
    response.headers.set(name, value);
  }
  return response;
}

function buildCachedPagesNotFoundResult(
  options: ResolvePagesPageDataOptions,
  entry: CacheHandlerValue,
  cacheState: "HIT" | "STALE",
): ResolvePagesPageDataResult {
  const revalidateSeconds = entry.cacheControl?.revalidate ?? 60;
  const result = buildPagesNotFoundResult(
    options,
    revalidateSeconds,
    cacheState,
    entry.cacheControl?.expire,
  );
  if (result.kind === "response") {
    return {
      kind: "response",
      response: applyCachedPagesRepresentationHeaders(result.response, cacheState, entry, options),
    };
  }
  return result;
}

function resolvePagesRedirectStatus(redirect: PagesRedirectResult): number {
  return redirect.statusCode != null ? redirect.statusCode : redirect.permanent ? 308 : 307;
}

/** Validate and normalize the redirect metadata returned by gSP/gSSP. */
export function resolvePagesRedirect(
  redirect: PagesRedirectResult,
  options: {
    method: "getStaticProps" | "getServerSideProps";
    routeUrl: string;
    sanitizeDestination: (destination: string) => string;
  },
): ResolvedPagesRedirect {
  const errors: string[] = [];
  const hasPermanent = redirect.permanent !== undefined;
  const hasStatusCode = redirect.statusCode !== undefined;

  if (hasPermanent && hasStatusCode) {
    errors.push("`permanent` and `statusCode` can not both be provided");
  } else if (hasPermanent && typeof redirect.permanent !== "boolean") {
    errors.push("`permanent` must be `true` or `false`");
  } else if (
    hasStatusCode &&
    !ALLOWED_PAGES_REDIRECT_STATUS_CODES.has(redirect.statusCode as number)
  ) {
    errors.push(
      `\`statusCode\` must undefined or one of ${[...ALLOWED_PAGES_REDIRECT_STATUS_CODES].join(", ")}`,
    );
  }
  if (typeof redirect.destination !== "string") {
    errors.push(`\`destination\` should be string but received ${typeof redirect.destination}`);
  }
  if (redirect.basePath !== undefined && typeof redirect.basePath !== "boolean") {
    errors.push(
      `\`basePath\` should be undefined or a false, received ${typeof redirect.basePath}`,
    );
  }
  if (errors.length > 0) {
    throw new Error(
      `Invalid redirect object returned from ${options.method} for ${options.routeUrl}\n${errors.join(" and ")}\nSee more info here: https://nextjs.org/docs/messages/invalid-redirect-gssp`,
    );
  }

  return {
    destination: options.sanitizeDestination(redirect.destination),
    statusCode: resolvePagesRedirectStatus(redirect),
    ...(redirect.basePath === undefined ? {} : { basePath: redirect.basePath }),
  };
}

export function resolvePagesRedirectLocation(
  redirect: ResolvedPagesRedirect,
  configuredBasePath = "",
): string {
  let destination = redirect.destination;
  if (configuredBasePath && redirect.basePath !== false && redirect.destination.startsWith("/")) {
    destination = `${configuredBasePath}${redirect.destination}`;
  }
  if (!destination.startsWith("/")) return destination;

  const urlParts = destination.split("?");
  const urlNoQuery = urlParts[0];
  return (
    urlNoQuery.replace(/\\/g, "/").replace(/\/\/+/g, "/") +
    (urlParts[1] ? `?${urlParts.slice(1).join("?")}` : "")
  );
}

export function buildPagesRedirectProps(
  redirect: ResolvedPagesRedirect,
  props: PagesRenderProps,
): PagesRenderProps {
  return {
    ...props,
    pageProps: {
      ...(isUnknownRecord(props.pageProps) ? props.pageProps : {}),
      __N_REDIRECT: redirect.destination,
      __N_REDIRECT_STATUS: redirect.statusCode,
      ...(redirect.basePath === undefined ? {} : { __N_REDIRECT_BASE_PATH: redirect.basePath }),
    },
  };
}

function normalizePagesRenderProps(props: Record<string, unknown>): PagesRenderProps {
  if (!("pageProps" in props)) {
    // Legacy vinext PAGES entries stored pageProps directly. Accept those
    // during the migration window while all new writes use the full envelope.
    return { pageProps: props };
  }
  return {
    ...props,
    pageProps: props.pageProps,
  };
}

type PagesAppInitialPropsResult =
  | { kind: "props"; pageProps: Record<string, unknown>; renderProps: PagesRenderProps }
  | { kind: "response"; response: Promise<Response> };

/**
 * Load `_app.getInitialProps` and return the normalized render props and the
 * extracted `pageProps`. This is shared between the foreground render path and
 * the stale-while-revalidate background regeneration path so both produce the
 * same full props envelope (app-level props plus the page's `pageProps`).
 *
 * `getSharedReqRes` lets callers share the same mock req/res with other
 * data-fetching steps (e.g. `getServerSideProps`) when they run in the same
 * request context.
 */
async function loadPagesAppInitialRenderProps(
  options: Pick<
    ResolvePagesPageDataOptions,
    | "AppComponent"
    | "createAppTree"
    | "createPageElement"
    | "err"
    | "i18n"
    | "pageModule"
    | "query"
    | "router"
    | "routePattern"
    | "routeUrl"
    | "asPath"
  >,
  getSharedReqRes: () => PagesGsspContextResponse,
): Promise<PagesAppInitialPropsResult> {
  let pageProps: Record<string, unknown> = {};
  let renderProps: PagesRenderProps = { pageProps };

  if (!hasPagesGetInitialProps(options.AppComponent)) {
    return { kind: "props", pageProps, renderProps };
  }

  const { req, res, responsePromise } = getSharedReqRes();
  const initialProps = await loadPagesGetInitialProps(options.AppComponent, {
    AppTree: options.createAppTree ?? options.createPageElement,
    Component: options.pageModule.default,
    router:
      options.router ??
      createPagesGetInitialPropsRouter(
        options.routePattern,
        options.query,
        options.asPath ?? options.routeUrl,
      ),
    ctx: {
      req,
      res,
      err: options.err,
      pathname: options.routePattern,
      query: options.query,
      asPath: options.asPath ?? options.routeUrl,
      locale: options.i18n.locale,
      locales: options.i18n.locales,
      defaultLocale: options.i18n.defaultLocale,
    },
  });

  if (isResponseSent(res)) {
    return { kind: "response", response: responsePromise };
  }

  if (initialProps) {
    // `_app.getInitialProps` owns the complete render-props envelope. Next.js
    // preserves that object even when a custom App omits `pageProps`; wrapping
    // it would change the props passed to the App and mask its intentional
    // missing-pageProps behavior.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/render.tsx
    renderProps = initialProps;
    pageProps = isUnknownRecord(initialProps.pageProps) ? initialProps.pageProps : {};
  }

  return { kind: "props", pageProps, renderProps };
}

/**
 * Build the response for a `getServerSideProps` / `getStaticProps`
 * `{ redirect }` result.
 *
 * For an HTML page request we emit a real HTTP redirect (`Location` header) so
 * a hard navigation lands on the destination.
 *
 * For a `/_next/data/<buildId>/<page>.json` request (a client-side navigation)
 * we must NOT emit an HTTP redirect: the client's `fetch()` would transparently
 * follow it to the destination's HTML, which is not a valid data envelope and
 * would force a hard reload (and console error noise). Instead we mirror
 * Next.js and return a 200 JSON envelope carrying `__N_REDIRECT` /
 * `__N_REDIRECT_STATUS` inside `pageProps`. The client router detects these
 * markers and performs a fresh client navigation to the destination, which
 * supersedes (cancels) the in-flight navigation.
 *
 * Ported from Next.js: `packages/next/src/server/render.tsx` — the
 * `__N_REDIRECT` / `__N_REDIRECT_STATUS` props assignment for gSSP/gSP
 * redirects (search `__N_REDIRECT`), consumed in
 * `packages/next/src/shared/lib/router/router.ts` (`pageProps.__N_REDIRECT`).
 */
function buildPagesRedirectResponse(
  redirect: PagesRedirectResult,
  options: Pick<
    ResolvePagesPageDataOptions,
    | "isDataReq"
    | "sanitizeDestination"
    | "safeJsonStringify"
    | "deploymentId"
    | "basePath"
    | "routeUrl"
  >,
  props: PagesRenderProps = { pageProps: {} },
  method: "getStaticProps" | "getServerSideProps" = "getStaticProps",
): Response {
  const resolved = resolvePagesRedirect(redirect, {
    method,
    routeUrl: options.routeUrl,
    sanitizeDestination: options.sanitizeDestination,
  });
  const redirectProps = buildPagesRedirectProps(resolved, props);

  // Next.js currently passes these destinations through to both `Location`
  // and the client-consumed `__N_REDIRECT` field. Vinext deliberately rejects
  // executable schemes here: a data navigation would otherwise assign a
  // request-controlled `javascript:` URL to `window.location.href`.
  if (isDangerousScheme(resolved.destination)) {
    const headers = new Headers({
      "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate",
      "Content-Type": "text/plain; charset=utf-8",
    });
    if (options.deploymentId) {
      headers.set(NEXTJS_DEPLOYMENT_ID_HEADER, options.deploymentId);
    }
    return new Response("Invalid redirect destination", { status: 500, headers });
  }

  if (options.isDataReq) {
    // Mirror Next.js pages-handler.ts: set x-nextjs-deployment-id on all
    // `_next/data` redirect exits for deployment-skew protection.
    const init: ResponseInit & { headers: Record<string, string> } = { headers: {} };
    if (options.deploymentId) {
      init.headers[NEXTJS_DEPLOYMENT_ID_HEADER] = options.deploymentId;
    }
    return buildNextDataPropsJsonResponse(redirectProps, options.safeJsonStringify, init);
  }

  const location = resolvePagesRedirectLocation(resolved, options.basePath);
  return new Response(location, {
    status: resolved.statusCode,
    headers: {
      Location: location,
      ...(resolved.statusCode === 308 ? { Refresh: `0;url=${location}` } : {}),
    },
  });
}

function buildCachedPagesRedirectResponse(
  cached: CachedRedirectValue,
  options: Pick<
    ResolvePagesPageDataOptions,
    | "isDataReq"
    | "sanitizeDestination"
    | "safeJsonStringify"
    | "deploymentId"
    | "basePath"
    | "routeUrl"
  >,
): Response {
  const props = normalizePagesRenderProps(cached.props as Record<string, unknown>);
  const pageProps = isUnknownRecord(props.pageProps) ? props.pageProps : {};
  const destination = pageProps.__N_REDIRECT;
  const statusCode = pageProps.__N_REDIRECT_STATUS;
  const redirectBasePath = pageProps.__N_REDIRECT_BASE_PATH;
  if (typeof destination !== "string") {
    throw new Error("Invalid cached Pages redirect: missing __N_REDIRECT");
  }
  return buildPagesRedirectResponse(
    {
      destination,
      ...(typeof statusCode === "number" ? { statusCode } : {}),
      ...(redirectBasePath === undefined ? {} : { basePath: redirectBasePath as boolean }),
    },
    options,
    props,
  );
}

function getCachedPagesRedirect(
  cached: CacheHandlerValue["value"] | undefined,
): CachedRedirectValue | null {
  if (cached?.kind === "REDIRECT") return cached;
  if (cached?.kind !== "PAGES") return null;

  const locationHeader = cached.headers
    ? Object.entries(cached.headers).find(([name]) => name.toLowerCase() === "location")?.[1]
    : undefined;
  const destination = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
  if (
    typeof destination !== "string" ||
    typeof cached.status !== "number" ||
    !ALLOWED_PAGES_REDIRECT_STATUS_CODES.has(cached.status)
  ) {
    return null;
  }

  // Legacy vinext entries stored redirects as empty PAGES responses. Their
  // Location value was already final and never received configured basePath
  // processing, so retain that behavior with the explicit opt-out marker.
  const props = normalizePagesRenderProps(cached.pageData as Record<string, unknown>);
  return {
    kind: "REDIRECT",
    props: buildPagesRedirectProps(
      { destination, statusCode: cached.status, basePath: false },
      props,
    ),
  };
}

/**
 * Compare a `getStaticPaths` entry against the actual request params.
 *
 * Handles both shapes Next.js allows:
 *   - { params: { ... } }
 *   - "string-path"
 *
 * For a string entry, compare the entry against the current request URL using
 * the shared `normalizeStaticPathname` helper from
 * `../routing/route-pattern.ts` (which mirrors the Next.js
 * `removeTrailingSlash` behaviour in
 * `.nextjs-ref/packages/next/src/build/static-paths/pages.ts`). For an object
 * entry with a missing `params` key, return false rather than throwing — the
 * caller will respond with a 404 just like Next.js does for unlisted paths.
 */
export type PagesRouteParam = {
  key: string;
  repeat: boolean;
  optional: boolean;
};

export function getPagesRouteParams(routePattern: string): PagesRouteParam[] {
  return routePattern
    .split("/")
    .map((segment) => {
      const optionalCatchAll = segment.match(/^\[\[\.\.\.(.+)\]\]$/);
      if (optionalCatchAll) {
        return { key: optionalCatchAll[1], repeat: true, optional: true };
      }
      const requiredCatchAll = segment.match(/^\[\.\.\.(.+)\]$/);
      if (requiredCatchAll) {
        return { key: requiredCatchAll[1], repeat: true, optional: false };
      }
      const dynamic = segment.match(/^\[(.+)\]$/);
      if (dynamic) {
        return { key: dynamic[1], repeat: false, optional: false };
      }
      return null;
    })
    .filter((param): param is PagesRouteParam => param !== null);
}

export function matchesPagesStaticPath(
  pathEntry: PagesStaticPathsEntry,
  params: Record<string, unknown>,
  routeParams: PagesRouteParam[],
  routeUrl: string,
): boolean {
  if (typeof pathEntry === "string") {
    // Request routing intentionally preserves the raw encoded pathname until
    // dynamic captures are decoded. Compare string-form getStaticPaths entries
    // in the same segment-normalized space so a seeded literal value such as
    // `[second]` matches a data URL containing `%5Bsecond%5D`. Segment-wise
    // normalization keeps encoded delimiters such as `%2F` encoded, so they
    // cannot become path separators during this comparison.
    return (
      normalizePathnameForRouteMatch(normalizeStaticPathname(pathEntry)) ===
      normalizePathnameForRouteMatch(normalizeStaticPathname(routeUrl))
    );
  }
  const entryParams = pathEntry.params;
  if (entryParams === undefined || entryParams === null) {
    return false;
  }

  return routeParams.every(({ key, repeat, optional }) => {
    if (!Object.hasOwn(entryParams, key)) {
      return false;
    }

    let value = entryParams[key];
    // Mirrors Next.js build/static-paths/pages.ts: optional catch-all values
    // explicitly returned as null, undefined, or false normalize to [].
    if (optional && (value === null || value === undefined || value === false)) {
      value = [];
    }

    if (repeat) {
      if (!Array.isArray(value) || (!optional && value.length === 0)) {
        return false;
      }
    } else if (typeof value !== "string") {
      return false;
    }

    const actual = params[key];
    if (Array.isArray(value)) {
      if (optional && value.length === 0 && actual === undefined) {
        return true;
      }
      return Array.isArray(actual) && value.join("/") === actual.join("/");
    }
    return String(value) === String(actual);
  });
}

function buildPagesCacheResponse(
  html: string,
  cacheState: "HIT" | "STALE",
  fontLinkHeader: string,
  revalidateSeconds?: number | false,
  expireSeconds?: number,
  cacheControl?: CacheControlMetadata,
  status?: number,
  cachedHeaders?: Record<string, string | string[]>,
): Response {
  // Legacy cache entries written before cacheControl metadata existed can still
  // hit this path without a persisted revalidate value; keep the historic
  // 60-second fallback for that migration window.
  const effectiveRevalidateSeconds = revalidateSeconds ?? 60;
  // HIT/STALE served from the origin store: route the cache header through the
  // CDN adapter (default: identical single Cache-Control). Edge adapters never
  // reach this path because their get() returns null.
  const { cacheControl: cacheControlHeader } = decideIsr({
    cacheState,
    kind: "pages",
    revalidateSeconds: effectiveRevalidateSeconds,
    expireSeconds: cacheControl?.expire === undefined ? undefined : expireSeconds,
    cacheControlMeta: cacheControl,
  });
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    ...buildCacheStateHeaders(cacheState),
  });
  applyCdnResponseHeaders(headers, { cacheControl: cacheControlHeader });

  if (fontLinkHeader) {
    headers.set("Link", fontLinkHeader);
  }
  if (cachedHeaders) {
    for (const [name, value] of Object.entries(cachedHeaders)) {
      const lowerName = name.toLowerCase();
      // Pages cache values can originate from custom handlers. Only restore
      // the representation headers needed by cached redirects/not-found
      // responses; never replay Set-Cookie or other request-specific headers.
      if (!isCachedPagesRepresentationHeader(lowerName)) continue;
      if (Array.isArray(value)) {
        headers.delete(name);
        for (const item of value) headers.append(name, item);
      } else {
        headers.set(name, value);
      }
    }
  }

  return new Response(html, {
    status: status ?? 200,
    headers,
  });
}

/**
 * For bot / crawler UAs, attach an ETag to a cached ISR response (HIT or
 * STALE) so it is consistent with the fresh-MISS path, then check for a
 * matching `If-None-Match`. When the check passes — and the request did NOT
 * carry `Cache-Control: no-cache` — returns a 304 response; otherwise returns
 * `null` so the caller can return the full response.
 *
 * Extracted to avoid duplicating the same three-line block across the HIT and
 * STALE branches.
 */
function applyBotETagAndCheck(
  cachedResponse: Response,
  html: string,
  options: Pick<ResolvePagesPageDataOptions, "userAgent" | "ifNoneMatch" | "requestCacheControl">,
): ResolvePagesPageDataResponseResult | null {
  if (!options.userAgent || !isPagesStreamingBot(options.userAgent)) {
    return null;
  }
  const etag = generatePagesETag(html);
  cachedResponse.headers.set("ETag", etag);
  const noCacheRequested = requestsNoCache(options.requestCacheControl);
  if (!noCacheRequested && options.ifNoneMatch && etagMatches(etag, options.ifNoneMatch)) {
    return {
      kind: "response",
      response: new Response(null, {
        status: 304,
        headers: cachedResponse.headers,
      }),
    };
  }
  return null;
}

function rewritePagesCachedHtml(
  cachedHtml: string,
  freshBody: string,
  nextDataScript: string,
): string {
  const bodyMarker = '<div id="__next">';
  const bodyStart = cachedHtml.indexOf(bodyMarker);
  const contentStart = bodyStart >= 0 ? bodyStart + bodyMarker.length : -1;
  const canonicalNextDataStart = cachedHtml.search(
    /<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>/,
  );
  const legacyNextDataStart = cachedHtml.indexOf("<script>window.__NEXT_DATA__");
  const nextDataStart = canonicalNextDataStart >= 0 ? canonicalNextDataStart : legacyNextDataStart;

  if (contentStart >= 0 && nextDataStart >= 0) {
    const region = cachedHtml.slice(contentStart, nextDataStart);
    const lastCloseDiv = region.lastIndexOf("</div>");
    const gap = lastCloseDiv >= 0 ? region.slice(lastCloseDiv + 6) : "";
    const nextDataEnd = cachedHtml.indexOf("</script>", nextDataStart) + 9;
    const tail = cachedHtml.slice(nextDataEnd);

    return cachedHtml.slice(0, contentStart) + freshBody + "</div>" + gap + nextDataScript + tail;
  }

  return (
    '<!DOCTYPE html>\n<html>\n<head>\n</head>\n<body>\n  <div id="__next">' +
    freshBody +
    "</div>\n  " +
    nextDataScript +
    "\n</body>\n</html>"
  );
}

export async function renderPagesIsrHtml(options: RenderPagesIsrHtmlOptions): Promise<string> {
  const renderProps = options.props ?? { pageProps: options.pageProps };
  const freshBody = await options.renderIsrPassToStringAsync(
    options.createPageElement(renderProps),
  );
  const nextDataScript = buildPagesNextDataScript({
    buildId: options.buildId,
    i18n: options.i18n,
    pageProps: options.pageProps,
    props: renderProps,
    params: options.params,
    routePattern: options.routePattern,
    safeJsonStringify: options.safeJsonStringify,
    // Serialize the same readiness flags (gssp/gsp/autoExport/…) the initial
    // render emits, so the regenerated HTML hydrates with the identical initial
    // `router.isReady` the server computed instead of a flag-less fallback.
    nextData: options.nextData,
    vinext: options.vinext,
  });

  return rewritePagesCachedHtml(options.cachedHtml, freshBody, nextDataScript);
}

export async function resolvePagesPageData(
  options: ResolvePagesPageDataOptions,
): Promise<ResolvePagesPageDataResult> {
  // Next.js passes `params: null` (effectively) to gSSP/gSP context for
  // non-dynamic routes — see render.tsx's `...(pageIsDynamic ? { params } : undefined)`.
  // Internal bookkeeping (route param hydration, ISR HTML, getStaticPaths
  // validation) still uses the matched-but-empty object — only user-facing
  // data-fetching contexts surface `null`.
  const userFacingParams: Record<string, unknown> | null = options.route.isDynamic
    ? options.params
    : null;

  // Set when `getStaticPaths: { fallback: true }` is configured and the
  // requested path is NOT in the pre-rendered list. When true, we render the
  // loading shell with empty props and `useRouter().isFallback === true`,
  // skipping `getStaticProps`. Matches Next.js `render.tsx`'s
  // `if (isSSG && !isFallback)` gate around `getStaticProps`. Data requests
  // (`/_next/data/...json`) still call `getStaticProps` so the client can
  // hydrate the page after the fallback shell ships.
  let isFallback = false;
  let shouldPersistFallbackData = false;
  let onDemandPreviousCacheEntry: ISRCacheEntry | null | undefined;
  const previewData = options.isOnDemandRevalidate ? false : (options.previewData ?? false);

  if (typeof options.pageModule.getStaticPaths === "function" && options.route.isDynamic) {
    const pathsResult = await options.pageModule.getStaticPaths({
      locales: options.i18n.locales ?? [],
      defaultLocale: options.i18n.defaultLocale ?? "",
    });
    const fallback = pathsResult?.fallback ?? false;
    const paths = pathsResult?.paths ?? [];
    const routeParams = getPagesRouteParams(options.routePattern);
    const isValidPath = paths.some((pathEntry) =>
      matchesPagesStaticPath(pathEntry, options.params, routeParams, options.routeUrl),
    );

    if (fallback === false && !isValidPath && previewData === false) {
      if (options.isOnDemandRevalidate && !options.revalidateOnlyGenerated) {
        return {
          kind: "response",
          response: new Response("This page could not be found", { status: 404 }),
          onDemandRevalidateSuccess: false,
        };
      }
      // For data requests (`/_next/data/...json`), return a JSON-shaped 404
      // so the client router can `res.json()` without blowing up — matches
      // Next.js' behavior. HTML navigations still get the configured 404 page.
      return buildPagesNotFoundResult(options);
    }

    // Render the fallback shell for unlisted paths under `fallback: true`.
    // Data requests resolve props normally so the client can fill in after
    // the loading shell ships (`fallback: 'blocking'` keeps SSRing as before).
    const isBotRequest =
      !!options.userAgent && isBotUserAgent(options.userAgent, options.htmlLimitedBots);
    if (
      fallback === true &&
      !isValidPath &&
      !options.isDataReq &&
      !isBotRequest &&
      previewData === false
    ) {
      isFallback = true;
    }
    shouldPersistFallbackData = fallback === true && !isValidPath && options.isDataReq === true;
  }

  if (
    typeof options.pageModule.getStaticProps === "function" &&
    options.isOnDemandRevalidate &&
    options.revalidateOnlyGenerated
  ) {
    const pathname = options.isrCachePathname ?? options.routeUrl.split("?")[0];
    onDemandPreviousCacheEntry = await options.isrGet(options.isrCacheKey("pages", pathname));
    if (!onDemandPreviousCacheEntry) {
      return {
        kind: "response",
        response: new Response("This page could not be found", {
          status: 404,
          headers: { [NEXTJS_CACHE_HEADER]: "REVALIDATED" },
        }),
      };
    }
  }

  let pageProps: Record<string, unknown> = {};
  let gsspRes: PagesMutableGsspResponse | null = null;
  const previewContext =
    previewData === false
      ? {}
      : {
          draftMode: true as const,
          preview: true as const,
          previewData,
        };

  let sharedReqRes: PagesGsspContextResponse | null = null;
  function getSharedReqRes(): PagesGsspContextResponse {
    sharedReqRes ??= options.createGsspReqRes();
    return sharedReqRes;
  }

  let renderProps: PagesRenderProps = { pageProps };
  if (previewData !== false) renderProps.__N_PREVIEW = true;

  async function loadForegroundAppInitialRenderProps(): Promise<ResolvePagesPageDataResult | null> {
    const result = await loadPagesAppInitialRenderProps(options, getSharedReqRes);
    if (result.kind === "response") {
      return {
        kind: "response",
        response: await result.response,
      };
    }
    renderProps = result.renderProps;
    pageProps = result.pageProps;
    return null;
  }

  if (isFallback) {
    const pathname = options.isrCachePathname ?? options.routeUrl.split("?")[0];
    const cached = await options.isrGet(options.isrCacheKey("pages", pathname));
    if (cached?.value.value?.kind !== "PAGES") {
      const appShortCircuit = await loadForegroundAppInitialRenderProps();
      if (appShortCircuit) return appShortCircuit;
      pageProps = {};
      renderProps = { ...renderProps, pageProps };
      return {
        kind: "render",
        documentReqRes: sharedReqRes,
        gsspRes: null,
        isrRevalidateSeconds: null,
        pageProps,
        props: renderProps,
        isFallback: true,
      };
    }
  }

  if (typeof options.pageModule.getServerSideProps === "function") {
    const shortCircuit = await loadForegroundAppInitialRenderProps();
    if (shortCircuit) {
      return shortCircuit;
    }
    renderProps = { ...renderProps, __N_SSP: true };
    const { req, res, responsePromise } = getSharedReqRes();
    const result = await options.pageModule.getServerSideProps({
      params: userFacingParams,
      req,
      res,
      query: options.query,
      resolvedUrl: options.resolvedUrl ?? options.routeUrl,
      locale: options.i18n.locale,
      locales: options.i18n.locales,
      defaultLocale: options.i18n.defaultLocale,
      ...previewContext,
    });

    if (isResponseSent(res)) {
      return {
        kind: "response",
        response: await responsePromise,
      };
    }

    if (result?.props) {
      // Next.js explicitly supports a Promise value for `props`. Await it
      // before serialising; otherwise pageProps would be a Promise and the
      // rendered page would receive empty props. See
      // packages/next/src/server/render.tsx (deferredContent).
      pageProps = mergePagesDataProps(renderProps.pageProps, await Promise.resolve(result.props));
      renderProps = { ...renderProps, pageProps };
    }

    if (result?.redirect) {
      return {
        kind: "response",
        response: buildPagesRedirectResponse(
          result.redirect,
          options,
          renderProps,
          "getServerSideProps",
        ),
      };
    }

    if (result?.notFound) {
      return buildPagesNotFoundResult(options);
    }

    // Mirrors Next.js render.tsx's `isSerializableProps(pathname, "getServerSideProps", data.props)`
    // check, gated on `!metadata.isRedirect && !metadata.isNotFound` (both
    // short-circuit above). Throws a friendly `SerializableError` so the
    // caller's existing try/catch surfaces a clear 500 instead of rendering
    // an empty page. See
    // .nextjs-ref/packages/next/src/server/render.tsx (~line 1200) and
    // .nextjs-ref/packages/next/src/lib/is-serializable-props.ts. Tracked in
    // vinext#1478.
    if (result?.props !== undefined && options.validatePropsSerialization !== false) {
      isSerializableProps(options.routePattern, "getServerSideProps", pageProps);
    }

    gsspRes = res;
  }

  let isrRevalidateSeconds: number | false | null = null;
  let isrExpireSeconds: number | undefined;

  if (typeof options.pageModule.getStaticProps === "function") {
    const pathname = options.isrCachePathname ?? options.routeUrl.split("?")[0];
    const cacheKey = options.isrCacheKey("pages", pathname);
    const cached =
      onDemandPreviousCacheEntry !== undefined
        ? onDemandPreviousCacheEntry
        : await options.isrGet(cacheKey);
    const cachedValue = cached?.value.value;
    const isLegacyCachedNotFound =
      cachedValue?.kind === "PAGES" &&
      cachedValue.status === 404 &&
      options.routePattern !== "/404" &&
      options.routePattern !== "/_error";
    const cachedRedirect = getCachedPagesRedirect(cachedValue);

    const scheduleStaleRegeneration = () => {
      options.triggerBackgroundRegeneration(
        cacheKey,
        async function () {
          return options.runInFreshUnifiedContext(async () => {
            options.applyRequestContexts();
            const freshAppResult = await loadPagesAppInitialRenderProps(options, () =>
              options.createGsspReqRes(),
            );
            if (freshAppResult.kind === "response") return;

            let freshPageProps = freshAppResult.pageProps;
            let freshRenderProps = freshAppResult.renderProps;
            const freshResult = await options.pageModule.getStaticProps?.({
              params: userFacingParams,
              locale: options.i18n.locale,
              locales: options.i18n.locales,
              defaultLocale: options.i18n.defaultLocale,
              revalidateReason: "stale",
            });
            if (!freshResult) return;
            assertPages404DoesNotReturnNotFound(options.routePattern, freshResult);

            const revalidateSeconds = resolvePagesRevalidateSeconds(freshResult, options.routeUrl);
            const expireSeconds = resolvePagesExpireSeconds(freshResult, options.expireSeconds);

            if (freshResult.redirect) {
              const redirect = resolvePagesRedirect(freshResult.redirect, {
                method: "getStaticProps",
                routeUrl: options.routeUrl,
                sanitizeDestination: options.sanitizeDestination,
              });
              await options.isrSet(
                cacheKey,
                {
                  kind: "REDIRECT",
                  props: buildPagesRedirectProps(redirect, freshRenderProps),
                },
                revalidateSeconds,
                undefined,
                expireSeconds,
              );
              return;
            }

            if (freshResult.notFound) {
              await options.isrSet(cacheKey, null, revalidateSeconds, undefined, expireSeconds);
              return;
            }

            if (freshResult.props === undefined) return;
            const resolvedFreshProps = await Promise.resolve(freshResult.props);
            freshPageProps = mergePagesDataProps(freshRenderProps.pageProps, resolvedFreshProps);
            freshRenderProps = { ...freshRenderProps, pageProps: freshPageProps };
            if (options.validatePropsSerialization !== false) {
              isSerializableProps(options.routePattern, "getStaticProps", freshPageProps);
            }

            if (cachedValue?.kind === "PAGES" && !cachedValue.generatedFromDataRequest) {
              const freshHtml = await renderPagesIsrHtml({
                buildId: options.buildId,
                cachedHtml: cachedValue.html,
                createPageElement: options.createPageElement,
                i18n: options.i18n,
                pageProps: freshPageProps,
                props: freshRenderProps,
                params: options.params,
                renderIsrPassToStringAsync: options.renderIsrPassToStringAsync,
                routePattern: options.routePattern,
                safeJsonStringify: options.safeJsonStringify,
                nextData: options.nextData,
                vinext: options.vinext,
              });
              await options.isrSet(
                cacheKey,
                buildPagesCacheValue(freshHtml, freshRenderProps, options.statusCode),
                revalidateSeconds,
                undefined,
                expireSeconds,
              );
              return;
            }

            // A cached redirect/not-found has no reusable HTML shell. Persist
            // the resolved props and let the next foreground request render
            // the canonical PAGES representation without re-running user code.
            await options.isrSet(
              cacheKey,
              {
                kind: "PAGES",
                html: "",
                pageData: freshRenderProps,
                generatedFromDataRequest: true,
                headers: undefined,
                status: undefined,
              },
              revalidateSeconds,
              undefined,
              expireSeconds,
            );
          });
        },
        {
          routerKind: "Pages Router",
          routePath: options.routePattern,
          routeType: "render",
        },
      );
    };

    if (
      !options.isOnDemandRevalidate &&
      cached &&
      !cached.isStale &&
      !cached.isExpired &&
      previewData === false
    ) {
      if (cachedValue === null) return buildCachedPagesNotFoundResult(options, cached.value, "HIT");
      // Legacy vinext entries persisted the rendered custom 404 as PAGES.
      // Treat those as canonical notFound markers so request-derived 404 props
      // (cookies/auth headers) are never replayed from cache.
      if (isLegacyCachedNotFound) {
        return buildCachedPagesNotFoundResult(options, cached.value, "HIT");
      }
      if (cachedRedirect) {
        return {
          kind: "response",
          response: applyCachedPagesRepresentationHeaders(
            buildCachedPagesRedirectResponse(cachedRedirect, options),
            "HIT",
            cached.value,
            options,
          ),
        };
      }
      if (options.isDataReq && cachedValue?.kind === "PAGES") {
        const response = buildNextDataPropsJsonResponse(
          normalizePagesRenderProps(cachedValue.pageData as Record<string, unknown>),
          options.safeJsonStringify,
          options.deploymentId
            ? { headers: { [NEXTJS_DEPLOYMENT_ID_HEADER]: options.deploymentId } }
            : undefined,
        );
        return {
          kind: "response",
          response: applyCachedPagesRepresentationHeaders(response, "HIT", cached.value, options),
        };
      }
    }

    // On-demand revalidation (`res.revalidate()`) must regenerate the entry
    // synchronously with `revalidateReason: "on-demand"`, so the fresh/stale
    // cache-hit short-circuits below are bypassed and execution falls through
    // to the regeneration path. Mirrors Next.js's `isOnDemandRevalidate`
    // handling in render.tsx / base-server.ts.
    if (
      !options.isOnDemandRevalidate &&
      cached?.isStale === false &&
      !cached.isExpired &&
      cachedValue?.kind === "PAGES" &&
      !cachedValue.generatedFromDataRequest &&
      cached &&
      !cached.isStale &&
      !options.scriptNonce &&
      !options.isDataReq &&
      previewData === false
    ) {
      const hitResponse = buildPagesCacheResponse(
        cachedValue.html,
        "HIT",
        options.fontLinkHeader,
        undefined,
        options.expireSeconds,
        cached.value.cacheControl,
        cachedValue.status,
        cachedValue.headers,
      );
      // Bot / crawler ETag consistency: attach an ETag to cache-HIT responses
      // for bot UAs so they are consistent with fresh-MISS bot responses (which
      // also carry an ETag via `renderPagesPageResponse`). When the incoming
      // `If-None-Match` matches (and no `Cache-Control: no-cache`), return 304.
      const hitBotResult = applyBotETagAndCheck(hitResponse, cachedValue.html, options);
      if (hitBotResult) return hitBotResult;
      return {
        kind: "response",
        response: hitResponse,
      };
    }

    if (
      !options.isOnDemandRevalidate &&
      cached &&
      cached.isStale &&
      !cached.isExpired &&
      !options.scriptNonce &&
      previewData === false &&
      (cachedValue === null ||
        cachedRedirect !== null ||
        isLegacyCachedNotFound ||
        options.isDataReq)
    ) {
      scheduleStaleRegeneration();
      if (cachedValue === null)
        return buildCachedPagesNotFoundResult(options, cached.value, "STALE");
      if (isLegacyCachedNotFound) {
        return buildCachedPagesNotFoundResult(options, cached.value, "STALE");
      }
      if (cachedRedirect) {
        return {
          kind: "response",
          response: applyCachedPagesRepresentationHeaders(
            buildCachedPagesRedirectResponse(cachedRedirect, options),
            "STALE",
            cached.value,
            options,
          ),
        };
      }
      if (cachedValue?.kind === "PAGES") {
        const response = buildNextDataPropsJsonResponse(
          normalizePagesRenderProps(cachedValue.pageData as Record<string, unknown>),
          options.safeJsonStringify,
          options.deploymentId
            ? { headers: { [NEXTJS_DEPLOYMENT_ID_HEADER]: options.deploymentId } }
            : undefined,
        );
        return {
          kind: "response",
          response: applyCachedPagesRepresentationHeaders(response, "STALE", cached.value, options),
        };
      }
    }

    if (
      !options.isOnDemandRevalidate &&
      cachedValue?.kind === "PAGES" &&
      !cachedValue.generatedFromDataRequest &&
      cached &&
      cached.isStale &&
      !cached.isExpired &&
      !options.scriptNonce &&
      !options.isDataReq &&
      previewData === false
    ) {
      scheduleStaleRegeneration();

      const staleResponse = buildPagesCacheResponse(
        cachedValue.html,
        "STALE",
        options.fontLinkHeader,
        undefined,
        options.expireSeconds,
        cached.value.cacheControl,
        cachedValue.status,
        cachedValue.headers,
      );
      // Bot / crawler ETag consistency: same as the HIT branch — attach an
      // ETag to STALE responses for bot UAs and honour If-None-Match / 304.
      const staleBotResult = applyBotETagAndCheck(staleResponse, cachedValue.html, options);
      if (staleBotResult) return staleBotResult;
      return {
        kind: "response",
        response: staleResponse,
      };
    }

    const generatedPageData =
      !options.isOnDemandRevalidate &&
      previewData === false &&
      cached?.isStale === false &&
      !cached.isExpired &&
      cachedValue?.kind === "PAGES" &&
      cachedValue.generatedFromDataRequest &&
      isUnknownRecord(cachedValue.pageData)
        ? cachedValue.pageData
        : null;
    if (!generatedPageData) {
      const shortCircuit = await loadForegroundAppInitialRenderProps();
      if (shortCircuit) return shortCircuit;
    }
    const result = generatedPageData
      ? null
      : await options.pageModule.getStaticProps({
          params: userFacingParams,
          locale: options.i18n.locale,
          locales: options.i18n.locales,
          defaultLocale: options.i18n.defaultLocale,
          ...previewContext,
          revalidateReason: options.isOnDemandRevalidate
            ? "on-demand"
            : options.isBuildTimePrerendering
              ? "build"
              : "stale",
        });
    assertPages404DoesNotReturnNotFound(options.routePattern, result);

    if (generatedPageData) {
      renderProps = normalizePagesRenderProps(generatedPageData);
      pageProps = isUnknownRecord(renderProps.pageProps) ? renderProps.pageProps : {};
    }

    if (result?.props !== undefined) {
      pageProps = mergePagesDataProps(renderProps.pageProps, await Promise.resolve(result.props));
      renderProps = { ...renderProps, pageProps };
    }

    if (result?.redirect) {
      const response = buildPagesRedirectResponse(result.redirect, options, renderProps);
      if (previewData === false) {
        const revalidateSeconds = resolvePagesRevalidateSeconds(result, options.routeUrl);
        const expireSeconds = resolvePagesExpireSeconds(result, options.expireSeconds);
        const redirect = resolvePagesRedirect(result.redirect, {
          method: "getStaticProps",
          routeUrl: options.routeUrl,
          sanitizeDestination: options.sanitizeDestination,
        });
        await options.isrSet(
          cacheKey,
          {
            kind: "REDIRECT",
            props: buildPagesRedirectProps(redirect, renderProps),
          },
          revalidateSeconds,
          undefined,
          expireSeconds,
        );
        applyPagesTerminalMissHeaders(response, revalidateSeconds, pathname, expireSeconds);
      }
      return {
        kind: "response",
        response,
      };
    }

    if (result?.notFound) {
      const revalidateSeconds = resolvePagesRevalidateSeconds(result, options.routeUrl);
      const expireSeconds = resolvePagesExpireSeconds(result, options.expireSeconds);
      if (previewData === false) {
        await options.isrSet(cacheKey, null, revalidateSeconds, undefined, expireSeconds);
      }
      const notFoundResult = buildPagesNotFoundResult(
        options,
        revalidateSeconds,
        previewData === false ? "MISS" : undefined,
        expireSeconds,
      );
      if (notFoundResult.kind === "response" && previewData === false) {
        applyPagesTerminalMissHeaders(
          notFoundResult.response,
          revalidateSeconds,
          pathname,
          expireSeconds,
        );
      }
      return notFoundResult;
    }

    // Mirrors Next.js render.tsx's `isSerializableProps(pathname, "getStaticProps", data.props)`
    // check, gated on `!metadata.isNotFound` (notFound + redirect both
    // short-circuit above). Throws a friendly `SerializableError` so the
    // caller's existing try/catch surfaces a clear 500 instead of rendering
    // an empty page. See
    // .nextjs-ref/packages/next/src/server/render.tsx (~line 982) and
    // .nextjs-ref/packages/next/src/lib/is-serializable-props.ts. Tracked in
    // vinext#1478.
    if (result?.props !== undefined && options.validatePropsSerialization !== false) {
      isSerializableProps(options.routePattern, "getStaticProps", pageProps);
    }

    if (previewData === false && result) {
      isrRevalidateSeconds = resolvePagesRevalidateSeconds(result, options.routeUrl);
      isrExpireSeconds = resolvePagesExpireSeconds(result, options.expireSeconds);
    } else if (previewData === false && options.isOnDemandRevalidate) {
      // `revalidate: false` (and an omitted `revalidate`) still participates in
      // on-demand regeneration. Persist the current invocation's normalized
      // lifetime instead of inheriting stale metadata from the previous entry.
      isrRevalidateSeconds = false;
    } else if (
      previewData === false &&
      cachedValue?.kind === "PAGES" &&
      cachedValue.generatedFromDataRequest
    ) {
      isrRevalidateSeconds = cached?.value.cacheControl?.revalidate ?? false;
      isrExpireSeconds = cached?.value.cacheControl?.expire;
    }

    if (shouldPersistFallbackData && previewData === false) {
      const revalidateSeconds = isrRevalidateSeconds ?? false;
      await options.isrSet(
        cacheKey,
        {
          kind: "PAGES",
          html: "",
          pageData: renderProps,
          generatedFromDataRequest: true,
          headers: undefined,
          status: undefined,
        },
        revalidateSeconds,
        undefined,
        isrExpireSeconds,
      );
    }
  }

  if (
    typeof options.pageModule.getServerSideProps !== "function" &&
    typeof options.pageModule.getStaticProps !== "function" &&
    hasPagesGetInitialProps(options.AppComponent)
  ) {
    const shortCircuit = await loadForegroundAppInitialRenderProps();
    if (shortCircuit) {
      return shortCircuit;
    }
  }

  if (
    typeof options.pageModule.getServerSideProps !== "function" &&
    typeof options.pageModule.getStaticProps !== "function" &&
    !hasPagesGetInitialProps(options.AppComponent) &&
    hasPagesGetInitialProps(options.pageModule.default)
  ) {
    const { req, res, responsePromise } = getSharedReqRes();
    const initialProps = await loadPagesGetInitialProps(options.pageModule.default, {
      req,
      res,
      err: options.err,
      pathname: options.routePattern,
      query: options.query,
      asPath: options.asPath ?? options.routeUrl,
      locale: options.i18n.locale,
      locales: options.i18n.locales,
      defaultLocale: options.i18n.defaultLocale,
    });

    if (isResponseSent(res)) {
      return {
        kind: "response",
        response: await responsePromise,
      };
    }

    if (initialProps) {
      pageProps = { ...pageProps, ...initialProps };
      renderProps = { ...renderProps, pageProps };
    }
  }

  return {
    kind: "render",
    documentReqRes: sharedReqRes,
    gsspRes,
    isrRevalidateSeconds,
    isrExpireSeconds,
    pageProps,
    props: renderProps,
    isFallback: false,
  };
}
