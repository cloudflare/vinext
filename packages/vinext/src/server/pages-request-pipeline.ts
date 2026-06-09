/**
 * Pages Router request pipeline — canonical 9-step Next.js execution order.
 *
 * This module owns the ordering once so it doesn't have to be copy-pasted
 * across prod-server.ts (Node), deploy.ts (Cloudflare Worker), and index.ts
 * (Vite dev middleware).
 *
 * Callers supply a `deps` object with injected callbacks:
 * - Prod/worker callers supply `renderPage`/`handleApi` and get
 *   `{type:"response"}` back.
 * - Dev callers omit them and get `{type:"render"|"api"|"next"}` intents
 *   which they handle themselves (preserving their streaming SSR path).
 */

import type {
  NextI18nConfig,
  NextRedirect,
  NextRewrite,
  NextHeader,
} from "../config/next-config.js";
import type { BasePathMatchState, RequestContext } from "../config/config-matchers.js";
import {
  matchRedirect,
  matchRewrite,
  preserveRedirectDestinationQuery,
  requestContextFromRequest,
  applyMiddlewareRequestHeaders,
  isExternalUrl,
  proxyExternalRequest,
  sanitizeDestination,
} from "../config/config-matchers.js";
import { applyConfigHeadersToHeaderRecord, normalizeTrailingSlash } from "./request-pipeline.js";
import type { HeaderRecord } from "./request-pipeline.js";
import { mergeHeaders } from "./worker-utils.js";
import { normalizeDefaultLocalePathname, stripI18nLocaleForApiRoute } from "./pages-i18n.js";
import { mergeRewriteQuery } from "../utils/query.js";
import { hasBasePath } from "../utils/base-path.js";

// All "render options" that are passed through to the renderPage callback
export type PagesRenderOptions = {
  isDataReq?: boolean;
  renderErrorPageOnMiss?: boolean;
};

export type MiddlewareResult = {
  continue: boolean;
  redirectUrl?: string;
  redirectStatus?: number;
  rewriteUrl?: string;
  rewriteStatus?: number;
  status?: number;
  responseHeaders?: Iterable<[string, string]>;
  response?: Response;
  waitUntilPromises?: Promise<unknown>[];
};

// The deps object injected by each runtime adapter
export type PagesPipelineDeps = {
  // Config values
  basePath: string;
  trailingSlash: boolean;
  i18nConfig: NextI18nConfig | null;
  configRedirects: NextRedirect[];
  configRewrites: {
    beforeFiles: NextRewrite[];
    afterFiles: NextRewrite[];
    fallback: NextRewrite[];
  };
  configHeaders: NextHeader[];

  // Pre-computed per-request values (adapter sets these)
  hadBasePath: boolean; // adapter computes: !basePath || hasBasePath(originalPathname, basePath)
  isDataReq: boolean; // true if this was a /_next/data/ request (already normalized by adapter)
  isDataRequest: boolean; // true if x-nextjs-data: 1 header was present (for middleware opts)
  ctx?: unknown; // Cloudflare ExecutionContext or undefined (for Node)
  // Raw, un-re-encoded query string (incl. leading "?") for building redirect Location
  // headers. Node adapters that build the Web Request from a raw req.url string should
  // pass it so the redirect query isn't re-encoded by URL parsing (e.g. a literal "#"
  // would otherwise be truncated as a fragment). Falls back to url.search when omitted.
  rawSearch?: string;

  // Route + render/api callbacks (optional — if absent, emit intent instead of Response)
  matchPageRoute?:
    | ((pathname: string, request: Request) => { route: { isDynamic: boolean } } | null)
    | null;
  runMiddleware?:
    | ((
        request: Request,
        ctx: unknown,
        opts: { isDataRequest: boolean },
      ) => Promise<MiddlewareResult>)
    | null;
  renderPage?:
    | ((
        request: Request,
        resolvedUrl: string,
        options?: PagesRenderOptions,
        stagedHeaders?: Headers,
      ) => Promise<Response>)
    | null;
  handleApi?: ((request: Request, apiUrl: string, ctx: unknown) => Promise<Response>) | null;
  /**
   * Optional override for proxying external rewrite destinations.
   * When supplied, the pipeline calls this instead of proxyExternalRequest(currentRequest, url).
   * Receives the pipeline's current request (with post-middleware headers applied) and the
   * external target URL. Dev adapters supply this to forward the original Node req body
   * (which is not included in the pipeline's body-less Web Request).
   */
  proxyExternal?: ((currentRequest: Request, externalUrl: string) => Promise<Response>) | null;
  /**
   * Optional public-directory static file server (Node prod only).
   * Called post-middleware (so middleware can intercept/redirect public files) with the
   * original basePath-stripped pathname and the staged middleware response headers.
   * The callback writes the file to its own output (Node `res`) and resolves `true` when
   * it served the request; the pipeline then returns `{ type: "handled" }`. Resolves `false`
   * to fall through to rewrites/render. Worker/dev adapters omit this — their public files
   * are served by the asset binding / Vite respectively.
   */
  serveStaticFile?:
    | ((requestPathname: string, stagedHeaders: HeaderRecord) => Promise<boolean>)
    | null;
};

// The result discriminated union
export type PagesPipelineResult =
  // `defaultContentType` is the Content-Type a buffering caller (Node) should apply
  // when the response carries none: "text/html" for page renders,
  // "application/octet-stream" for API routes (arbitrary data). It is left UNSET for
  // passthrough responses (middleware short-circuits, external proxies, redirects),
  // which Node sends verbatim without injecting a Content-Type — matching the
  // pre-refactor behavior.
  | { type: "response"; response: Response; defaultContentType?: string }
  // `handled`: an adapter-supplied callback (e.g. Node public-file serving) already
  // wrote the response to its own output; the adapter should just return.
  | { type: "handled" }
  | {
      type: "render";
      resolvedUrl: string;
      renderOptions: PagesRenderOptions | undefined;
      stagedHeaders: HeaderRecord;
      /** Post-middleware request headers — dev adapters apply these to req.headers before SSR. */
      requestHeaders: Headers;
      middlewareStatus: number | undefined;
      isDataReq: boolean;
    }
  | {
      type: "api";
      apiUrl: string;
      stagedHeaders: HeaderRecord;
      /** Post-middleware request headers — dev adapters apply these to req.headers before API handler. */
      requestHeaders: Headers;
      middlewareStatus: number | undefined;
    }
  // Reserved: `runPagesRequest` does not currently emit `{ type: "next" }`. The dev
  // hybrid app+pages passthrough is decided in the dev adapter (index.ts) from the
  // `render`/`api` intent via `hasAppDir`, not here. Kept as forward-compat surface
  // for a future pipeline-level passthrough; prod/worker adapters never observe it.
  | { type: "next" };

/**
 * Run the Pages Router request pipeline.
 *
 * ASSUMPTION: request already has internal headers filtered and basePath stripped.
 * The adapter is responsible for that pre-processing before calling runPagesRequest.
 * The adapter also handles: open-redirect guard, _next/static 404, image optimization,
 * _next/data normalization, Node decode/normalize/400, public-file serving.
 * runPagesRequest receives a "clean" request with basePath-stripped URL.
 */
export async function runPagesRequest(
  request: Request,
  deps: PagesPipelineDeps,
): Promise<PagesPipelineResult> {
  const {
    basePath,
    trailingSlash,
    i18nConfig,
    configRedirects,
    configRewrites,
    configHeaders,
    hadBasePath,
    isDataReq,
    isDataRequest,
  } = deps;

  // Proxy helper: use deps.proxyExternal when supplied (dev adapter forwards
  // Node req body), otherwise fall back to proxyExternalRequest(currentReq, url).
  // Accepts a snapshot of the current request so post-middleware headers are included.
  const proxyExternal = (currentReq: Request, externalUrl: string): Promise<Response> =>
    deps.proxyExternal
      ? deps.proxyExternal(currentReq, externalUrl)
      : proxyExternalRequest(currentReq, externalUrl);

  const url = new URL(request.url);
  let pathname = url.pathname;
  const search = url.search;

  // Step 1: Reconstruct basePathState
  const basePathState: BasePathMatchState = { basePath, hadBasePath };

  // Step 2: Trailing-slash normalization
  {
    const trailingSlashRedirect = normalizeTrailingSlash(pathname, basePath, trailingSlash, search);
    if (trailingSlashRedirect) {
      return { type: "response", response: trailingSlashRedirect };
    }
  }

  // Step 3: Build pre-middleware request context
  const reqCtx: RequestContext = requestContextFromRequest(request);
  const requestHostname = i18nConfig ? url.hostname : "";
  const matchPathname = i18nConfig
    ? normalizeDefaultLocalePathname(pathname, i18nConfig, { hostname: requestHostname })
    : pathname;

  // Step 4: Config redirects (before middleware)
  if (configRedirects.length) {
    const redirect = matchRedirect(matchPathname, configRedirects, reqCtx, basePathState);
    if (redirect) {
      // Only prepend basePath when the request was actually under basePath.
      // Opt-out rules running on out-of-basepath requests must not receive a basePath prefix.
      const dest = sanitizeDestination(
        basePath &&
          hadBasePath &&
          !isExternalUrl(redirect.destination) &&
          !hasBasePath(redirect.destination, basePath)
          ? basePath + redirect.destination
          : redirect.destination,
      );
      // Use the raw query (when the adapter supplies it) so the redirect Location
      // isn't re-encoded by URL parsing; fall back to the parsed search otherwise.
      const location = preserveRedirectDestinationQuery(dest, deps.rawSearch ?? search);
      return {
        type: "response",
        response: new Response(null, {
          status: redirect.permanent ? 308 : 307,
          headers: { Location: location },
        }),
      };
    }
  }

  // Step 5: Middleware
  let resolvedUrl = pathname + search;
  const middlewareHeaders: HeaderRecord = {};
  let middlewareStatus: number | undefined;

  if (typeof deps.runMiddleware === "function") {
    const result = await deps.runMiddleware(request, deps.ctx ?? null, { isDataRequest });

    // Bubble waitUntil promises
    if (result.waitUntilPromises && result.waitUntilPromises.length > 0) {
      const ctx = deps.ctx as { waitUntil?: (p: Promise<unknown>) => void } | null | undefined;
      if (ctx && typeof ctx.waitUntil === "function") {
        for (const p of result.waitUntilPromises) {
          ctx.waitUntil(p);
        }
      } else {
        // Node: no ctx.waitUntil — settle promises in the background
        void Promise.allSettled(result.waitUntilPromises);
      }
    }

    if (!result.continue) {
      if (result.redirectUrl) {
        const redirectHeaders: Record<string, string | string[]> = {
          Location: result.redirectUrl,
        };
        if (result.responseHeaders) {
          for (const [key, value] of result.responseHeaders) {
            const existing = redirectHeaders[key];
            if (existing === undefined) {
              redirectHeaders[key] = value;
            } else if (Array.isArray(existing)) {
              existing.push(value);
            } else {
              redirectHeaders[key] = [existing, value];
            }
          }
        }
        const headers = new Headers();
        for (const [k, v] of Object.entries(redirectHeaders)) {
          if (Array.isArray(v)) {
            for (const item of v) headers.append(k, item);
          } else {
            headers.set(k, v);
          }
        }
        return {
          type: "response",
          response: new Response(null, {
            status: result.redirectStatus ?? 307,
            headers,
          }),
        };
      }
      if (result.response) {
        return { type: "response", response: result.response };
      }
    }

    // Collect middleware response headers (Set-Cookie as array, same logic as both prod copies)
    if (result.responseHeaders) {
      for (const [key, value] of result.responseHeaders) {
        if (key === "set-cookie") {
          const existing = middlewareHeaders[key];
          if (Array.isArray(existing)) {
            existing.push(value);
          } else if (existing) {
            middlewareHeaders[key] = [existing as string, value];
          } else {
            middlewareHeaders[key] = [value];
          }
        } else {
          middlewareHeaders[key] = value;
        }
      }
    }

    if (result.rewriteUrl) {
      resolvedUrl = result.rewriteUrl;
    }

    // Reconciled superset: result.status takes priority over result.rewriteStatus
    middlewareStatus = result.status ?? result.rewriteStatus;
  }

  // Step 6: Unpack middleware request headers
  const { postMwReqCtx, request: postMwReq } = applyMiddlewareRequestHeaders(
    middlewareHeaders,
    request,
    { preserveCredentialHeaders: isExternalUrl(resolvedUrl) },
  );
  request = postMwReq;
  let resolvedPathname = resolvedUrl.split("?")[0];

  const matchResolvedPathname = (p: string): string =>
    i18nConfig ? normalizeDefaultLocalePathname(p, i18nConfig, { hostname: requestHostname }) : p;

  // Step 7: Config headers staging
  if (configHeaders.length) {
    applyConfigHeadersToHeaderRecord(middlewareHeaders, {
      configHeaders,
      pathname: matchPathname,
      requestContext: reqCtx,
      basePathState,
    });
  }

  // Step 8: External-URL proxy (post-mw rewrite target)
  //
  // Intentional asymmetry: ONLY the post-middleware rewrite path merges the staged
  // middleware headers into the proxied response (`mergeHeaders(...)`). The
  // beforeFiles/afterFiles/fallback external rewrite paths below return the bare
  // `proxyExternal(...)` response without merging. Both the pre-refactor prod and
  // worker copies agreed on this, so it is preserved deliberately — do not "fix" the
  // bare returns into merges without first confirming the originals.
  if (isExternalUrl(resolvedUrl)) {
    const proxyResponse = await proxyExternal(request, resolvedUrl);
    return {
      type: "response",
      response: mergeHeaders(proxyResponse, middlewareHeaders, undefined),
    };
  }

  // Step 8b: Public-directory static files (post-middleware, Node prod only).
  // Served after middleware so middleware can intercept/redirect public files, and
  // before rewrites so a real public file wins over a fallback rewrite — matching the
  // pre-refactor prod-server ordering. Only Node supplies `serveStaticFile`; the
  // callback owns the path guards (skip "/", "/api/", and the asset-prefix dir) and
  // writes directly to Node `res`, so a `true` result means the response is already sent.
  if (deps.serveStaticFile) {
    const served = await deps.serveStaticFile(pathname, middlewareHeaders);
    if (served) {
      return { type: "handled" };
    }
  }

  // Step 9: beforeFiles rewrites
  let configRewriteFired = false;
  if (configRewrites.beforeFiles?.length) {
    const rewritten = matchRewrite(
      matchResolvedPathname(resolvedPathname),
      configRewrites.beforeFiles,
      postMwReqCtx,
      basePathState,
    );
    if (rewritten) {
      if (isExternalUrl(rewritten)) {
        // Bare proxy — no middleware-header merge (see Step 8 asymmetry note).
        return { type: "response", response: await proxyExternal(request, rewritten) };
      }
      resolvedUrl = mergeRewriteQuery(resolvedUrl, rewritten);
      resolvedPathname = resolvedUrl.split("?")[0];
      configRewriteFired = true;
    }
  }

  // Step 10: Out-of-basePath reject
  if (basePath && !hadBasePath && !configRewriteFired) {
    return {
      type: "response",
      response: new Response("This page could not be found", {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    };
  }

  // Step 11: API routes
  const apiLookupUrl = stripI18nLocaleForApiRoute(resolvedUrl, i18nConfig);
  const apiLookupPathname = apiLookupUrl.split("?")[0];
  if (apiLookupPathname.startsWith("/api/") || apiLookupPathname === "/api") {
    if (typeof deps.handleApi === "function") {
      const response = await deps.handleApi(request, apiLookupUrl, deps.ctx ?? null);
      return {
        type: "response",
        // API routes return arbitrary data; default a missing content-type to
        // application/octet-stream (not text/html) to avoid content sniffing.
        defaultContentType: "application/octet-stream",
        response: mergeHeaders(response, middlewareHeaders, middlewareStatus),
      };
    } else {
      // dev: emit intent
      return {
        type: "api",
        apiUrl: apiLookupUrl,
        stagedHeaders: middlewareHeaders,
        requestHeaders: request.headers,
        middlewareStatus,
      };
    }
  }

  // Step 12: afterFiles rewrites
  const pageMatch = deps.matchPageRoute ? deps.matchPageRoute(resolvedPathname, request) : null;
  // matchPageRoute is a route-table scan; only re-run it below if afterFiles
  // actually rewrote resolvedPathname (the common case leaves it unchanged).
  let resolvedPathnameChanged = false;
  if ((!pageMatch || pageMatch.route.isDynamic) && configRewrites.afterFiles?.length) {
    const rewritten = matchRewrite(
      matchResolvedPathname(resolvedPathname),
      configRewrites.afterFiles,
      postMwReqCtx,
      basePathState,
    );
    if (rewritten) {
      if (isExternalUrl(rewritten)) {
        // Bare proxy — no middleware-header merge (see Step 8 asymmetry note).
        return { type: "response", response: await proxyExternal(request, rewritten) };
      }
      resolvedUrl = mergeRewriteQuery(resolvedUrl, rewritten);
      resolvedPathname = resolvedUrl.split("?")[0];
      resolvedPathnameChanged = true;
    }
  }

  // Step 13: Render + fallback rewrites
  if (typeof deps.renderPage === "function") {
    // Reuse the Step 12 match unless afterFiles changed the pathname.
    const renderPageMatch = resolvedPathnameChanged
      ? deps.matchPageRoute
        ? deps.matchPageRoute(resolvedPathname, request)
        : null
      : pageMatch;
    // A data request must not defer-render the error page or run fallback rewrites.
    // Node/dev signal this via `isDataReq` (set when a `/_next/data/` path is
    // normalized); the worker never normalizes those paths (no buildId at request
    // scope), so it relies on the `x-nextjs-data: 1` header captured as `isDataRequest`.
    // Gate on both so the worker matches the pre-refactor behavior (it previously gated
    // on the header). No-op for Node/dev, where a data request already has isDataReq=true.
    const shouldDeferErrorPageOnMiss =
      !isDataReq && !isDataRequest && !!deps.matchPageRoute && !renderPageMatch;
    const initialRenderOptions: PagesRenderOptions | undefined = shouldDeferErrorPageOnMiss
      ? { renderErrorPageOnMiss: false }
      : isDataReq
        ? { isDataReq: true }
        : undefined;

    // Convert staged middleware headers to a Web Headers object for renderPage.
    // Adapters that need to inject per-request values (e.g. CSP nonces) into the
    // rendered HTML can access them via this argument.
    const stagedHeaders = new Headers();
    for (const [k, v] of Object.entries(middlewareHeaders)) {
      if (Array.isArray(v)) {
        for (const item of v) stagedHeaders.append(k, item);
      } else {
        stagedHeaders.set(k, v);
      }
    }

    let response = await deps.renderPage(request, resolvedUrl, initialRenderOptions, stagedHeaders);

    // Fallback rewrites if 404 + deferred
    let matchedFallbackRewrite = false;
    if (response.status === 404 && shouldDeferErrorPageOnMiss && configRewrites.fallback?.length) {
      const fallbackRewrite = matchRewrite(
        matchResolvedPathname(resolvedPathname),
        configRewrites.fallback,
        postMwReqCtx,
        basePathState,
      );
      if (fallbackRewrite) {
        if (isExternalUrl(fallbackRewrite)) {
          // Bare proxy — no middleware-header merge (see Step 8 asymmetry note).
          return {
            type: "response",
            response: await proxyExternal(request, fallbackRewrite),
          };
        }
        response = await deps.renderPage(
          request,
          mergeRewriteQuery(resolvedUrl, fallbackRewrite),
          undefined,
          stagedHeaders,
        );
        matchedFallbackRewrite = true;
      }
    }

    // Deferred 404 re-render
    if (response.status === 404 && shouldDeferErrorPageOnMiss && !matchedFallbackRewrite) {
      response = await deps.renderPage(request, resolvedUrl, undefined, stagedHeaders);
    }

    const merged = mergeHeaders(response, middlewareHeaders, middlewareStatus);
    // Preserve the streaming marker so the adapter can decide stream-vs-buffer.
    // mergeHeaders may create a new Response object (losing non-standard properties),
    // so we copy the marker from the original render response to the merged one.
    if (merged !== response) {
      (merged as { __vinextStreamedHtmlResponse?: boolean }).__vinextStreamedHtmlResponse = (
        response as { __vinextStreamedHtmlResponse?: boolean }
      ).__vinextStreamedHtmlResponse;
    }
    // Page renders default a missing content-type to text/html.
    return { type: "response", response: merged, defaultContentType: "text/html" };
  }
  // dev: apply fallback rewrites eagerly (no renderPage to 404-gate on).
  // If matchPageRoute says there's no match, try fallback rewrites before
  // emitting the render intent — the SSR handler writes to res directly so
  // we cannot inspect its status code after the fact.
  // Reuse the Step 12 match unless afterFiles changed the pathname.
  const devPageMatch = resolvedPathnameChanged
    ? deps.matchPageRoute
      ? deps.matchPageRoute(resolvedPathname, request)
      : null
    : pageMatch;
  if (!devPageMatch && configRewrites.fallback?.length) {
    const fallbackRewrite = matchRewrite(
      matchResolvedPathname(resolvedPathname),
      configRewrites.fallback,
      postMwReqCtx,
      basePathState,
    );
    if (fallbackRewrite) {
      if (isExternalUrl(fallbackRewrite)) {
        // Bare proxy — no middleware-header merge (see Step 8 asymmetry note).
        return { type: "response", response: await proxyExternal(request, fallbackRewrite) };
      }
      resolvedUrl = mergeRewriteQuery(resolvedUrl, fallbackRewrite);
    }
  }

  return {
    type: "render",
    resolvedUrl,
    renderOptions: isDataReq ? { isDataReq: true } : undefined,
    stagedHeaders: middlewareHeaders,
    requestHeaders: request.headers,
    middlewareStatus,
    isDataReq,
  };
}
