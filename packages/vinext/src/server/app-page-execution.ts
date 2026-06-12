import type { LayoutFlags } from "./app-elements.js";
import type { ClassificationReason } from "../build/layout-classification-types.js";
import {
  applyRscCompatibilityIdHeader,
  createRscRedirectLocation,
  VINEXT_RSC_CONTENT_TYPE,
} from "./app-rsc-cache-busting.js";
import { VINEXT_RSC_REDIRECT_HEADER } from "./headers.js";
import { applyEdgeRuntimeHeader } from "./app-page-response.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import { parseNextHttpErrorDigest, parseNextRedirectDigest } from "./next-error-digest.js";
import { renderSsrErrorMetaTags } from "./app-ssr-error-meta.js";
import { addBasePathToPathname } from "../utils/base-path.js";
import { isPromiseLike } from "../utils/promise.js";
import { runWithConnectionProbe } from "vinext/shims/headers";

/**
 * Builds the canonical `NEXT_REDIRECT;<type>;<url>;<status>;` digest that
 * Next.js encodes on `redirect()` / `permanentRedirect()` throws. Used when
 * we synthesize a flight payload for an RSC navigation: the digest must
 * round-trip through the client's `RedirectErrorBoundary` so the same
 * `getURLFromRedirectError` / `getRedirectTypeFromError` helpers decode it.
 *
 * The URL is included verbatim, not encoded — Next.js's `getRedirectError`
 * sets `digest = ${CODE};${type};${url};${status};` with the raw URL, and the
 * client decodes via `error.digest.split(';').slice(2, -2).join(';')`. We
 * default `type=replace` because `redirect()` is replace-style outside of
 * server actions, matching Next.js's `getRedirectError` default.
 *
 * Reference:
 *   `.nextjs-ref/packages/next/src/client/components/redirect.ts:20-23`
 *   `.nextjs-ref/packages/next/src/client/components/redirect-error.ts`
 */
function formatNextRedirectDigest(options: { url: string; statusCode: number }): string {
  return `NEXT_REDIRECT;replace;${options.url};${options.statusCode};`;
}

export type { LayoutFlags };

/**
 * Marker we tag onto a thrown redirect/notFound error when it originates from
 * `generateMetadata()` (vs. a server component itself). Metadata resolution is
 * suspended/streamed in Next.js, so a redirect from metadata is not emitted as
 * a plain HTTP-level 307. Instead the transport depends on the request:
 *   - RSC navigation requests (`Rsc: 1`) ride inside the flight payload with a
 *     200 status; the client router decodes the redirect digest.
 *   - Streaming-capable document requests get a 200 HTML response carrying a
 *     refresh meta tag (the streamed document can't switch to a 307 after the
 *     head has flushed).
 *   - html-limited bots (which Next.js serves a blocking, non-streamed
 *     response) get the HTTP-level 307.
 * Page-level redirect()s, by contrast, still produce a 307 for SSR document
 * requests.
 *
 * See Next.js test:
 *   test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
 */
const APP_PAGE_METADATA_ERROR_MARKER = Symbol.for("vinext.appPage.metadataError");

export function tagAppPageMetadataError<T>(error: T): T {
  if (error && typeof error === "object") {
    try {
      Object.defineProperty(error, APP_PAGE_METADATA_ERROR_MARKER, {
        value: true,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    } catch {
      // The error object may be frozen (rare). The marker is best-effort —
      // callers fall back to the page-level 307 path when missing, which
      // matches the historical behavior.
    }
  }
  return error;
}

export type AppPageSpecialError =
  | { kind: "redirect"; location: string; statusCode: number; fromMetadata?: boolean }
  | { kind: "http-access-fallback"; statusCode: number; fromMetadata?: boolean };

export type AppPageFontPreload = {
  href: string;
  type: string;
};

type AppPageRscStreamCapture = {
  /** Stream for createFromReadableStream (SSR). Always set. */
  ssrStream: ReadableStream<Uint8Array>;
  /** When capturing, the combined embed+capture stream. handleSsr consumes this. */
  sideStream?: ReadableStream<Uint8Array>;
};

/**
 * Builds an RSC flight payload that encodes a `redirect()` as a React error
 * with the canonical `NEXT_REDIRECT;<type>;<url>;<status>;` digest. Mirrors
 * Next.js's behavior in `app-render.tsx generateDynamicFlightRenderResult`
 * where a redirect thrown during RSC rendering propagates through
 * `renderToFlightStream`'s `onError` handler and is serialized into the
 * stream — the HTTP response stays 200 because the redirect rides in the
 * flight body, not the status line.
 *
 * Returns a stream that the caller wraps in a 200 response with the standard
 * `text/x-component` content type. The client's `RedirectErrorBoundary`
 * decodes the digest and performs the navigation.
 */
type BuildRscRedirectFlightStream = (options: { digest: string }) => ReadableStream<Uint8Array>;

type BuildAppPageSpecialErrorResponseOptions = {
  /**
   * Optional configured basePath (e.g. "/blog"). When set, redirect Locations
   * pointing at app-internal paths get prefixed so callers see e.g.
   * `Location: /blog/about` for `redirect("/about")`. Mirrors Next.js's
   * `addPathPrefix(getURLFromRedirectError(err), basePath)` in app-render.tsx.
   * External URLs (those that resolve to a different origin than the request)
   * are left untouched.
   */
  basePath?: string;
  /**
   * Builds the RSC flight payload used when a redirect must be encoded inside
   * the response body instead of the status line — required for RSC navigations
   * and for `generateMetadata()` redirects (always 200, never 307). When
   * omitted, redirect responses fall back to the 307 + Location path; callers
   * that handle RSC requests must supply this.
   */
  buildRscRedirectFlightStream?: BuildRscRedirectFlightStream;
  clearRequestContext: () => void;
  /**
   * Drains and returns Set-Cookie header values that were accumulated during
   * this render via cookies().set() / cookies().delete(). Appended to redirect
   * responses so an auth flow that does `cookies().set("session", "...");
   * redirect("/")` preserves the cookie on the 307. Mirrors Next.js's
   * `appendMutableCookies(headers, requestStore.mutableCookies)` in
   * app-render.tsx. Only applied to redirect responses to match Next.js;
   * the http-access-fallback path leaves cookies to the rendered boundary.
   */
  getAndClearPendingCookies?: () => string[];
  isEdgeRuntime?: boolean;
  isRscRequest: boolean;
  middlewareContext?: { headers: Headers | null };
  renderFallbackPage?: (statusCode: number) => Promise<Response | null>;
  request: Request;
  serveStreamingMetadata?: boolean;
  specialError: AppPageSpecialError;
};

type ProbeAppPageLayoutsResult = {
  response: Response | null;
  layoutFlags: LayoutFlags;
};

export type LayoutClassificationOptions = {
  /** Build-time classifications from segment config or module graph, keyed by layout index. */
  buildTimeClassifications?: ReadonlyMap<number, "static" | "dynamic"> | null;
  /**
   * Per-layout classification reasons keyed by layout index. Requires
   * `VINEXT_DEBUG_CLASSIFICATION` at BOTH lifecycle points: at build time so
   * the plugin patches the `__VINEXT_CLASS_REASONS` dispatch stub, and at
   * runtime so the route object actually calls it. Setting the flag only at
   * runtime leaves the stub returning `null`, and every build-time classified
   * layout will fall through to `{ layer: "no-classifier" }` in the debug
   * channel. The hot path never reads this and the wire payload is unchanged.
   */
  buildTimeReasons?: ReadonlyMap<number, ClassificationReason> | null;
  /**
   * Emits one log line per layout with the classification reason, keyed by
   * layout ID. Set by the generator when `VINEXT_DEBUG_CLASSIFICATION` is
   * active. When undefined, the probe loop skips debug emission entirely.
   */
  debugClassification?: (layoutId: string, reason: ClassificationReason) => void;
  /** Maps layout index to its layout ID (e.g. "layout:/blog"). */
  getLayoutId: (layoutIndex: number) => string;
  /**
   * Returns whether the completed per-layout observation makes static reuse
   * unsafe even if the older dynamic scope did not report dynamic usage.
   */
  isLayoutObservationDynamic?: (layoutId: string) => boolean;
  /** Runs a function with isolated dynamic usage tracking per layout. */
  runWithIsolatedDynamicScope: <T>(
    fn: () => T | Promise<T>,
  ) => Promise<{ result: T; dynamicDetected: boolean }>;
};

type ProbeAppPageLayoutsOptions = {
  layoutCount: number;
  onLayoutError: (error: unknown, layoutIndex: number) => Promise<Response | null>;
  probeLayoutAt: (layoutIndex: number) => unknown;
  runWithSuppressedHookWarning<T>(probe: () => Promise<T>): Promise<T>;
  /** When provided, enables per-layout static/dynamic classification. */
  classification?: LayoutClassificationOptions | null;
};

type ProbeAppPageComponentOptions = {
  awaitAsyncResult: boolean;
  onError: (error: unknown) => Promise<Response | null>;
  probePage: () => unknown;
  runWithSuppressedHookWarning<T>(probe: () => Promise<T>): Promise<T>;
};

type ProbeAppPageThrownErrorOptions = {
  probePage: () => unknown;
  runWithSuppressedHookWarning<T>(probe: () => Promise<T>): Promise<T>;
};

function getAppPageStatusText(statusCode: number): string {
  return statusCode === 403 ? "Forbidden" : statusCode === 401 ? "Unauthorized" : "Not Found";
}

function mergeAppPageSpecialErrorHeaders(
  response: Response,
  middlewareContext: { headers: Headers | null } | undefined,
): Response {
  const headers = new Headers(response.headers);
  mergeMiddlewareResponseHeaders(headers, middlewareContext?.headers ?? null);

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function resolveAppPageSpecialError(error: unknown): AppPageSpecialError | null {
  if (!(error && typeof error === "object" && "digest" in error)) {
    return null;
  }

  const digest = String(error.digest);
  const fromMetadata = (error as Record<symbol, unknown>)[APP_PAGE_METADATA_ERROR_MARKER] === true;

  const redirect = parseNextRedirectDigest(digest);
  if (redirect) {
    return {
      kind: "redirect",
      location: redirect.url,
      statusCode: redirect.status,
      ...(fromMetadata ? { fromMetadata: true } : {}),
    };
  }

  const httpError = parseNextHttpErrorDigest(digest);
  if (httpError) {
    return {
      kind: "http-access-fallback",
      statusCode: httpError.status,
      ...(fromMetadata ? { fromMetadata: true } : {}),
    };
  }

  return null;
}

/**
 * Resolves a redirect() target against the request URL and prepends the
 * configured basePath when the target is an app-internal absolute path.
 *
 * Mirrors Next.js's `addPathPrefix(getURLFromRedirectError(err), basePath)`
 * in `app-render.tsx`: a `redirect("/about")` call from a page mounted at
 * `/blog` (basePath) produces `Location: /blog/about`.
 *
 * Skips prefixing when:
 *  - basePath is unset / empty
 *  - the target is a full URL pointing at a different origin (external redirect)
 *  - the target already starts with the basePath (caller did the work themselves)
 */
function applyAppPageRedirectBasePath(
  location: string,
  requestUrl: string,
  basePath: string | undefined,
): string {
  const resolved = new URL(location, requestUrl);
  const requestOrigin = new URL(requestUrl).origin;
  if (!basePath || resolved.origin !== requestOrigin) {
    return resolved.toString();
  }
  resolved.pathname = addBasePathToPathname(resolved.pathname, basePath);
  return resolved.toString();
}

/**
 * Returns a path-relative form (`/foo?bar`) of an absolute URL when it shares
 * the request's origin; otherwise returns the URL verbatim. Used so the digest
 * we embed in the flight payload matches Next.js's convention — the digest
 * stores the path the developer passed to `redirect("/about")`, not a
 * fully-qualified URL like `https://example.com/about`.
 */
function sameOriginPathOrAbsolute(location: string, requestUrl: string): string {
  try {
    const resolved = new URL(location, requestUrl);
    const requestOrigin = new URL(requestUrl).origin;
    if (resolved.origin !== requestOrigin) {
      return resolved.toString();
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return location;
  }
}

function buildMetadataRedirectHtmlResponse(options: {
  digest: string;
  getAndClearPendingCookies?: () => string[];
  isEdgeRuntime?: boolean;
  middlewareContext?: { headers: Headers | null };
}): Response {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
  });
  applyEdgeRuntimeHeader(headers, options.isEdgeRuntime);
  mergeMiddlewareResponseHeaders(headers, options.middlewareContext?.headers ?? null);

  const pendingCookies = options.getAndClearPendingCookies?.() ?? [];
  for (const cookie of pendingCookies) {
    headers.append("Set-Cookie", cookie);
  }

  const errorMetaTags = renderSsrErrorMetaTags([{ digest: options.digest }]);
  // Intentional divergence from Next.js: Next.js inserts the redirect meta tag
  // into the otherwise fully-rendered streamed document, whereas we emit a
  // minimal stub (refresh meta tag, empty body). For a redirect this is
  // functionally equivalent — the browser follows the refresh regardless of
  // body content — and avoids re-rendering page content we're about to discard.
  return new Response(`<!DOCTYPE html><html><head>${errorMetaTags}</head><body></body></html>`, {
    headers,
    status: 200,
  });
}

export async function buildAppPageSpecialErrorResponse(
  options: BuildAppPageSpecialErrorResponseOptions,
): Promise<Response> {
  if (options.specialError.kind === "redirect") {
    options.clearRequestContext();
    // Apply configured basePath first so app-internal targets land at
    // /<basePath>/<target> before the RSC cache-busting transform sees them.
    const prefixedLocation = applyAppPageRedirectBasePath(
      options.specialError.location,
      options.request.url,
      options.basePath,
    );
    const digestUrl = sameOriginPathOrAbsolute(prefixedLocation, options.request.url);
    const digest = formatNextRedirectDigest({
      url: digestUrl,
      statusCode: options.specialError.statusCode,
    });

    if (
      options.specialError.fromMetadata === true &&
      !options.isRscRequest &&
      options.serveStreamingMetadata !== false
    ) {
      return buildMetadataRedirectHtmlResponse({
        digest,
        getAndClearPendingCookies: options.getAndClearPendingCookies,
        isEdgeRuntime: options.isEdgeRuntime,
        middlewareContext: options.middlewareContext,
      });
    }

    // Two cases need a 200 + flight-payload encoding instead of an HTTP 307:
    //   1. RSC navigation requests (`Rsc: 1` header) — the client router
    //      decodes the redirect digest from the flight stream. A raw 307
    //      bypasses that path and breaks cache-busting validation.
    // Document requests that redirect from `generateMetadata()` are HTML
    // responses instead: streaming-capable user agents get a refresh meta tag
    // and html-limited bots get the blocking 307 above.
    // Mirrors Next.js's `generateDynamicFlightRenderResult` path in
    // `app-render.tsx`, where the redirect error propagates through
    // `renderToFlightStream` and is serialized with its digest.
    const shouldEmbedRedirectInFlight =
      Boolean(options.buildRscRedirectFlightStream) && options.isRscRequest;

    if (shouldEmbedRedirectInFlight && options.buildRscRedirectFlightStream) {
      // Reduce the resolved (absolute) URL back to a path-only form for
      // same-origin redirects. Next.js's digest stores the raw URL passed to
      // `redirect()` (typically a path like "/about"), and the client router's
      // `router.push(url)` happily accepts paths. Cross-origin targets keep
      // their absolute form, matching Next.js's external-redirect handling.
      const stream = options.buildRscRedirectFlightStream({ digest });

      const headers = new Headers({
        "Content-Type": VINEXT_RSC_CONTENT_TYPE,
        // Side-channel signal so vinext's client loop can detect the redirect
        // without having to decode the flight body first. See
        // `VINEXT_RSC_REDIRECT_HEADER` in server/headers.ts for the rationale.
        [VINEXT_RSC_REDIRECT_HEADER]: digestUrl,
      });
      applyEdgeRuntimeHeader(headers, options.isEdgeRuntime);
      // Mirror the regular RSC response by stamping the build-time compatibility
      // ID. Without it, the client treats the response as cross-build and hard-
      // navigates instead of following the redirect through the soft-nav loop.
      applyRscCompatibilityIdHeader(headers);
      // Preserve middleware response headers (Set-Cookie, custom headers, etc.)
      // exactly like the 307 path does — the client will still see them.
      mergeMiddlewareResponseHeaders(headers, options.middlewareContext?.headers ?? null);
      const pendingCookies = options.getAndClearPendingCookies?.() ?? [];
      for (const cookie of pendingCookies) {
        headers.append("Set-Cookie", cookie);
      }

      return new Response(stream, {
        headers,
        status: 200,
      });
    }

    const location = options.isRscRequest
      ? await createRscRedirectLocation(prefixedLocation, options.request)
      : prefixedLocation;
    const headers = new Headers({
      Location: location,
    });
    // Middleware may contribute response headers here, but redirect() owns the
    // status. Do not apply middlewareContext.status on special-error responses.
    mergeMiddlewareResponseHeaders(headers, options.middlewareContext?.headers ?? null);
    // Preserve cookies set via cookies().set() / cookies().delete() during the
    // page render — auth flows commonly set a session cookie and immediately
    // redirect, and those Set-Cookie values must ride on the 307.
    const pendingCookies = options.getAndClearPendingCookies?.() ?? [];
    for (const cookie of pendingCookies) {
      headers.append("Set-Cookie", cookie);
    }

    return new Response(null, {
      headers,
      status: options.specialError.statusCode,
    });
  }

  if (options.renderFallbackPage) {
    const fallbackResponse = await options.renderFallbackPage(options.specialError.statusCode);
    if (fallbackResponse) {
      // When notFound() / forbidden() / unauthorized() is thrown from
      // generateMetadata(), Next.js treats the error as a suspended metadata
      // result — the not-found UI is rendered through the React boundary
      // client-side while the HTTP response itself stays 200. Mirror that
      // behavior by overriding the rendered boundary response status to 200.
      // Mirrors the redirect-from-metadata path above, which also returns 200.
      // Reference: test/e2e/app-dir/metadata-navigation
      //   "should support notFound in generateMetadata"
      //
      // Exception: when serveStreamingMetadata === false (html-limited bots),
      // metadata blocks the render synchronously. Next.js sets the real HTTP
      // error status in this case (app-render.tsx ~2845). Mirror by not
      // overriding the status, symmetrically with the redirect-from-metadata
      // path which is already gated on serveStreamingMetadata !== false.
      const responseToMerge =
        options.specialError.fromMetadata === true && options.serveStreamingMetadata !== false
          ? new Response(fallbackResponse.body, {
              headers: fallbackResponse.headers,
              status: 200,
              statusText: fallbackResponse.statusText,
            })
          : fallbackResponse;
      return mergeAppPageSpecialErrorHeaders(responseToMerge, options.middlewareContext);
    }
  }

  options.clearRequestContext();
  // When notFound() is thrown from generateMetadata() with no fallback page
  // available, keep the 200 status to stay consistent with the streamed
  // metadata contract (the error is surfaced in the page UI, not the status).
  // Exception: when serveStreamingMetadata === false (html-limited bots),
  // metadata blocks the render synchronously — Next.js sets the real HTTP
  // error status in this case (app-render.tsx ~2845), symmetric with the
  // redirect-from-metadata path that is already gated on the same flag.
  const responseStatus =
    options.specialError.fromMetadata === true && options.serveStreamingMetadata !== false
      ? 200
      : options.specialError.statusCode;
  return mergeAppPageSpecialErrorHeaders(
    new Response(getAppPageStatusText(options.specialError.statusCode), {
      status: responseStatus,
    }),
    options.middlewareContext,
  );
}

/** See `LayoutFlags` type docblock in app-elements.ts for lifecycle. */
export async function probeAppPageLayouts(
  options: ProbeAppPageLayoutsOptions,
): Promise<ProbeAppPageLayoutsResult> {
  const layoutFlags: Record<string, "s" | "d"> = {};
  const cls = options.classification ?? null;

  const response = await options.runWithSuppressedHookWarning(async () => {
    for (let layoutIndex = options.layoutCount - 1; layoutIndex >= 0; layoutIndex--) {
      const buildTimeResult = cls?.buildTimeClassifications?.get(layoutIndex);

      if (cls && buildTimeResult) {
        const layoutId = cls.getLayoutId(layoutIndex);
        // Build-time classified (Layer 1 or Layer 2): skip dynamic isolation,
        // but still probe for special errors (redirects, not-found). Record the
        // build-time flag up front so it survives a short-circuit if the error
        // probe returns a special-error response below.
        layoutFlags[layoutId] = buildTimeResult === "static" ? "s" : "d";
        const errorResponse = await probeLayoutForErrors(options, layoutIndex);
        if (errorResponse) return errorResponse;
        // Compute the final flag before reporting so the emitted debug reason
        // always agrees with `layoutFlags[layoutId]`. A runtime observation can
        // override a build-time `static` decision to dynamic; in that case we
        // report a `runtime-probe` reason rather than the stale build-time one.
        const observationDynamic = cls.isLayoutObservationDynamic?.(layoutId) === true;
        const layoutDynamic = buildTimeResult === "dynamic" || observationDynamic;
        layoutFlags[layoutId] = layoutDynamic ? "d" : "s";
        if (cls.debugClassification) {
          if (observationDynamic && buildTimeResult === "static") {
            cls.debugClassification(layoutId, {
              layer: "runtime-probe",
              outcome: "dynamic",
            });
          } else {
            // `no-classifier` is the documented fallback for a layout that was
            // build-time classified but whose reason payload is absent — either
            // because the build was run without `VINEXT_DEBUG_CLASSIFICATION` or
            // because no Layer 1/2 classifier attached a reason. This is the sole
            // producer of the variant; see `layout-classification-types.ts`.
            cls.debugClassification(
              layoutId,
              cls.buildTimeReasons?.get(layoutIndex) ?? { layer: "no-classifier" },
            );
          }
        }
        continue;
      }

      if (cls) {
        const layoutId = cls.getLayoutId(layoutIndex);
        // Layer 3: probe with isolated dynamic scope to detect per-layout
        // dynamic API usage (headers(), cookies(), connection(), etc.)
        try {
          const { dynamicDetected } = await cls.runWithIsolatedDynamicScope(async () => {
            const outcome = await runWithConnectionProbe(() => options.probeLayoutAt(layoutIndex));
            return outcome.completed ? outcome.result : null;
          });
          const observationDynamic = cls.isLayoutObservationDynamic?.(layoutId) === true;
          const layoutDynamic = dynamicDetected || observationDynamic;
          layoutFlags[layoutId] = layoutDynamic ? "d" : "s";
          if (cls.debugClassification) {
            cls.debugClassification(layoutId, {
              layer: "runtime-probe",
              outcome: layoutDynamic ? "dynamic" : "static",
            });
          }
        } catch (error) {
          // Probe failed — conservatively treat as dynamic.
          layoutFlags[layoutId] = "d";
          if (cls.debugClassification) {
            cls.debugClassification(layoutId, {
              layer: "runtime-probe",
              outcome: "dynamic",
              error: error instanceof Error ? error.message : String(error),
            });
          }
          const errorResponse = await options.onLayoutError(error, layoutIndex);
          if (errorResponse) return errorResponse;
        }
        continue;
      }

      // No classification options — original behavior
      const errorResponse = await probeLayoutForErrors(options, layoutIndex);
      if (errorResponse) return errorResponse;
    }

    return null;
  });

  return { response, layoutFlags };
}

async function probeLayoutForErrors(
  options: ProbeAppPageLayoutsOptions,
  layoutIndex: number,
): Promise<Response | null> {
  const outcome = await runWithConnectionProbe(async () => {
    try {
      const layoutResult = options.probeLayoutAt(layoutIndex);
      if (isPromiseLike(layoutResult)) {
        await layoutResult;
      }
    } catch (error) {
      return options.onLayoutError(error, layoutIndex);
    }
    return null;
  });

  return outcome.completed ? outcome.result : null;
}

export async function probeAppPageComponent(
  options: ProbeAppPageComponentOptions,
): Promise<Response | null> {
  return options.runWithSuppressedHookWarning(async () => {
    const outcome = await runWithConnectionProbe(async () => {
      try {
        const pageResult = options.probePage();
        if (isPromiseLike(pageResult)) {
          if (options.awaitAsyncResult) {
            await pageResult;
          } else {
            void Promise.resolve(pageResult).catch(() => {});
          }
        }
      } catch (error) {
        return options.onError(error);
      }

      return null;
    });

    return outcome.completed ? outcome.result : null;
  });
}

export async function probeAppPageThrownError(
  options: ProbeAppPageThrownErrorOptions,
): Promise<unknown> {
  return options.runWithSuppressedHookWarning(async () => {
    const outcome = await runWithConnectionProbe(async () => {
      try {
        const pageResult = options.probePage();
        if (isPromiseLike(pageResult)) {
          await pageResult;
        }
      } catch (error) {
        return { error, thrown: true } as const;
      }

      return { error: null, thrown: false } as const;
    });

    return outcome.completed && outcome.result.thrown ? outcome.result.error : null;
  });
}

export async function readAppPageBinaryStream(
  stream: ReadableStream<Uint8Array>,
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    totalLength += value.byteLength;
  }

  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return buffer.buffer;
}

export function teeAppPageRscStreamForCapture(
  stream: ReadableStream<Uint8Array>,
  shouldCapture: boolean,
): AppPageRscStreamCapture {
  if (!shouldCapture) {
    return {
      ssrStream: stream,
    };
  }

  const [ssrStream, sideStream] = stream.tee();
  return {
    ssrStream,
    sideStream,
  };
}

export function buildAppPageFontLinkHeader(
  preloads: readonly AppPageFontPreload[] | null | undefined,
): string {
  if (!preloads || preloads.length === 0) {
    return "";
  }

  return preloads
    .map((preload) => `<${preload.href}>; rel=preload; as=font; type=${preload.type}; crossorigin`)
    .join(", ");
}
