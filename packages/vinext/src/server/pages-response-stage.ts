import { PRERENDER_REVALIDATE_HEADER } from "../utils/protocol-headers.js";
import type { VinextResponseStageDispatchOptions } from "./multi-stage.js";
import { getScriptNonceFromHeaderSources } from "./csp.js";
import { MIDDLEWARE_SET_COOKIE_HEADER } from "./headers.js";

const PREVIEW_COOKIE_NAMES = new Set(["__prerender_bypass", "__next_preview_data"]);
const BYPASS_CACHE_CONTROL_DIRECTIVES = new Set(["no-cache", "no-store"]);

function hasPreviewCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    const name = (separator === -1 ? pair : pair.slice(0, separator)).trim();
    if (PREVIEW_COOKIE_NAMES.has(name)) return true;
  }
  return false;
}

function hasCacheBypassDirective(
  cacheControl: string | null,
  directives = BYPASS_CACHE_CONTROL_DIRECTIVES,
): boolean {
  if (!cacheControl) return false;
  return cacheControl.split(",").some((directive) => {
    const separator = directive.indexOf("=");
    const name = (separator === -1 ? directive : directive.slice(0, separator))
      .trim()
      .toLowerCase();
    return directives.has(name);
  });
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
  request: Request;
  /** Middleware changed the request headers visible to the response stage. */
  requestHeadersChanged?: boolean;
  stagedHeaders?: Headers;
};

export type PagesResponseStageCacheDisposition = VinextResponseStageDispatchOptions["cache"];

/**
 * Whether a Pages response may be delegated to a shared response stage.
 *
 * Next.js does not construct a static response-cache key in draft mode and
 * handles authenticated on-demand revalidation outside ordinary cache reuse.
 * Request cache bypass directives and non-idempotent methods likewise need to
 * reach the renderer, while CSP nonces are embedded in the rendered body.
 *
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/pages/pages-handler.ts
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/server/base-server.ts
 */
export function shouldDispatchPagesResponseStage({
  authorizeOnDemandRevalidate,
  request,
  requestHeadersChanged,
  stagedHeaders,
}: PagesResponseStageDispatchOptions): boolean {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;

  if (hasPreviewCookie(request.headers.get("cookie"))) return false;
  if (hasCacheBypassDirective(request.headers.get("cache-control"))) return false;
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
