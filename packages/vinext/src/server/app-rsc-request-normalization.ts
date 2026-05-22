import { normalizePath } from "./normalize-path.js";
import { normalizePathnameForRouteMatchStrict } from "../routing/utils.js";
import { guardProtocolRelativeUrl } from "./request-pipeline.js";
import { hasBasePath, stripBasePath } from "../utils/base-path.js";
import {
  VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_RSC_RENDER_MODE_HEADER,
} from "./headers.js";
import {
  parseClientReuseManifestHeader,
  type ClientReuseManifestParseResult,
} from "./client-reuse-manifest.js";
import { normalizeMountedSlotsHeader } from "./app-mounted-slots-header.js";
import { stripRscSuffix } from "./app-rsc-cache-busting.js";
import {
  APP_RSC_RENDER_MODE_NAVIGATION,
  parseAppRscRenderMode,
  type AppRscRenderMode,
} from "./app-rsc-render-mode.js";
import {
  matchSegmentPrefetchRsc,
  extractSegmentPrefetchRsc,
} from "./app-segment-prefetch-normalizer.js";
import { badRequestResponse, notFoundResponse } from "./http-error-responses.js";

export { normalizeMountedSlotsHeader } from "./app-mounted-slots-header.js";

export type NormalizedRscRequest = {
  url: URL;
  pathname: string;
  cleanPathname: string;
  isRscRequest: boolean;
  interceptionContextHeader: string | null;
  mountedSlotsHeader: string | null;
  /** Semantic RSC payload mode. HTML requests always normalize to "navigation". */
  renderMode: AppRscRenderMode;
  /** Disabled ClientReuseManifest hint. Never authorizes skip transport in this stage. */
  clientReuseManifest: ClientReuseManifestParseResult;
  /**
   * When present, this is a segment-prefetch RSC request for a specific
   * route segment. Contains the segment path (e.g. "/_tree", "/_index",
   * "/dashboard/__PAGE__"). The cleanPathname is the original page path.
   *
   * Currently threaded through DispatchMatchedPageOptions for Phase 1 plumbing.
   * Not yet consumed by render — the handler returns full-page RSC for all
   * segment prefetch requests until Phase 2 adds segment-level response
   * generation.
   */
  segmentPrefetchPath: string | null;
};

/**
 * Normalize an App Router RSC request.
 *
 * Performs all security-sensitive and compatibility-sensitive preprocessing before
 * route matching. The ordering of steps is security-critical — changing it introduces
 * vulnerabilities:
 *
 *   1. Parse URL
 *   2. Protocol-relative URL guard — on the raw pathname, BEFORE normalizePath collapses
 *      `//` to `/`. If the guard ran after normalization, `//evil.com` → `/evil.com`
 *      would bypass the check and reach the trailing-slash redirector, which echoes the
 *      path into a `Location` header that browsers interpret as protocol-relative.
 *   3. Strict percent-decode each segment — throws on malformed sequences (→ 400). Must
 *      run before basePath check so %2F-encoded slashes cannot create fake basePath prefixes.
 *   4. Collapse double-slashes, resolve `.` and `..` segments (normalizePath)
 *   5. basePath check + strip — 404 when pathname lacks the basePath prefix.
 *      `/__vinext/` bypasses this for internal prerender endpoints.
 *   6. Segment-prefetch detection: `.segments/*.segment.rsc` URLs are normalized back
 *      to the original page path. The segment path is extracted for downstream handling.
 *   7. RSC detection: `.rsc` suffix only. Segment-prefetch requests are always RSC.
 *   8. cleanPathname — pathname with `.rsc` suffix stripped
 *   9. Sanitize X-Vinext-Interception-Context — strip null bytes (header injection)
 *   10. Normalize x-vinext-mounted-slots — dedup and sort for canonical cache keys
 *   11. Read semantic render mode for refresh/action payload rendering
 *   12. Parse disabled ClientReuseManifest hints on canonical RSC payload requests
 *
 * @returns A 400 or 404 Response for invalid or out-of-scope inputs,
 *          or a NormalizedRscRequest for valid requests.
 */
export function normalizeRscRequest(
  request: Request,
  basePath: string,
): Response | NormalizedRscRequest {
  const url = new URL(request.url);

  const protoGuard = guardProtocolRelativeUrl(url.pathname);
  if (protoGuard) return protoGuard;

  let decoded: string;
  try {
    decoded = normalizePathnameForRouteMatchStrict(url.pathname);
  } catch {
    return badRequestResponse();
  }

  let pathname = normalizePath(decoded);

  if (basePath) {
    if (!hasBasePath(pathname, basePath) && !pathname.startsWith("/__vinext/")) {
      return notFoundResponse();
    }
    pathname = stripBasePath(pathname, basePath);
  }

  let segmentPrefetchPath: string | null = null;
  if (matchSegmentPrefetchRsc(pathname)) {
    const extracted = extractSegmentPrefetchRsc(pathname);
    if (extracted) {
      segmentPrefetchPath = extracted.segmentPath;
      pathname = extracted.originalPathname;
    }
  }

  const isRscRequest = pathname.endsWith(".rsc") || segmentPrefetchPath !== null;
  const cleanPathname = stripRscSuffix(pathname);

  const interceptionContextHeader =
    request.headers.get(VINEXT_INTERCEPTION_CONTEXT_HEADER)?.replaceAll("\0", "") || null;

  const mountedSlotsHeader = normalizeMountedSlotsHeader(
    request.headers.get(VINEXT_MOUNTED_SLOTS_HEADER),
  );
  const renderMode = isRscRequest
    ? parseAppRscRenderMode(request.headers.get(VINEXT_RSC_RENDER_MODE_HEADER))
    : APP_RSC_RENDER_MODE_NAVIGATION;
  const clientReuseManifest = isRscRequest
    ? parseClientReuseManifestHeader(request.headers.get(VINEXT_CLIENT_REUSE_MANIFEST_HEADER))
    : ({ kind: "absent" } satisfies ClientReuseManifestParseResult);

  return {
    clientReuseManifest,
    url,
    pathname,
    cleanPathname,
    isRscRequest,
    interceptionContextHeader,
    mountedSlotsHeader,
    renderMode,
    segmentPrefetchPath,
  };
}
