import { PRERENDER_REVALIDATE_HEADER } from "../utils/protocol-headers.js";
import type { VinextResponseStageDispatchOptions } from "./multi-stage.js";
import { getScriptNonceFromHeaderSources } from "./csp.js";
import { MIDDLEWARE_SET_COOKIE_HEADER } from "./headers.js";
import type { PagesRouteDataKind } from "./pages-route-data-kind.js";

const PREVIEW_COOKIE_NAMES = new Set(["__prerender_bypass", "__next_preview_data"]);

export function hasPagesPreviewCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    const name = (separator === -1 ? pair : pair.slice(0, separator)).trim();
    if (PREVIEW_COOKIE_NAMES.has(name)) return true;
  }
  return false;
}

function hasStagedCacheBypass(stagedHeaders: Headers | undefined): boolean {
  // Middleware cookie overlays affect the same-request render and are not part
  // of the shared artifact identity. Pure response headers (Cache-Control,
  // Vary, Set-Cookie) remain outer composition and must not disable reuse of
  // the underlying ISR artifact, matching Next's cache layering.
  return stagedHeaders?.has(MIDDLEWARE_SET_COOKIE_HEADER) === true;
}

export type PagesResponseStageDispatchOptions = {
  authorizeOnDemandRevalidate?: (headerValue: string | null) => boolean;
  /** A custom Document getInitialProps can observe the request/response pair. */
  hasRequestAwareDocument?: boolean;
  request: Request;
  /** Middleware changed the request headers visible to the response stage. */
  requestHeadersChanged?: boolean;
  routeDataKind?: PagesRouteDataKind;
  stagedHeaders?: Headers;
};

export type PagesResponseStageCacheDisposition = VinextResponseStageDispatchOptions["cache"];

/**
 * Whether a Pages response may be delegated to a shared response stage.
 *
 * Next.js does not construct a static response-cache key in draft mode and
 * handles authenticated on-demand revalidation outside ordinary cache reuse.
 * Non-idempotent methods need to reach the renderer, while CSP nonces are
 * embedded in the rendered body. Request Cache-Control remains visible on a
 * cache miss, but does not bypass an existing host-cache entry in production.
 *
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/pages/pages-handler.ts
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/server/base-server.ts
 */
export function shouldDispatchPagesResponseStage({
  authorizeOnDemandRevalidate,
  hasRequestAwareDocument,
  request,
  requestHeadersChanged,
  routeDataKind,
  stagedHeaders,
}: PagesResponseStageDispatchOptions): boolean {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (
    request.headers
      .get("upgrade")
      ?.split(",")
      .some((value) => value.trim().toLowerCase() === "websocket")
  ) {
    return false;
  }

  // Next.js supplies req/res to `_document.getInitialProps` for getStaticProps
  // renders (`isAutoExport` is false). That makes the ostensibly static render
  // request-aware, so it cannot sit below request-stage middleware/config state.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/render.tsx
  if (hasRequestAwareDocument && routeDataKind === "static") return false;

  if (hasPagesPreviewCookie(request.headers.get("cookie"))) return false;
  if (requestHeadersChanged) return false;
  if (hasStagedCacheBypass(stagedHeaders)) return false;

  const revalidateHeader = request.headers.get(PRERENDER_REVALIDATE_HEADER);
  if (authorizeOnDemandRevalidate?.(revalidateHeader) === true) return false;

  return getScriptNonceFromHeaderSources(request.headers, stagedHeaders) === undefined;
}

/** Decide whether a host response-stage transport may share the rendered response. */
export function getPagesResponseStageCacheDisposition(
  options: PagesResponseStageDispatchOptions,
): PagesResponseStageCacheDisposition {
  const revalidateHeader = options.request.headers.get(PRERENDER_REVALIDATE_HEADER);
  if (options.authorizeOnDemandRevalidate?.(revalidateHeader) === true) return "bypass";
  return shouldDispatchPagesResponseStage(options) ? "shared" : "bypass";
}
