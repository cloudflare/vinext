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
import { extractSegmentPrefetchRsc } from "./app-segment-prefetch-normalizer.js";
import { badRequestResponse, notFoundResponse } from "./http-error-responses.js";

export { normalizeMountedSlotsHeader } from "./app-mounted-slots-header.js";

export type NormalizedRscRequest = {
  /** Parsed URL. Callers may mutate `url.search` after middleware runs. */
  url: URL;
  /** Normalized pathname with basePath stripped. Used for all internal routing. */
  pathname: string;
  /** Pathname with `.rsc` suffix removed. Used for route matching and navigation context. */
  cleanPathname: string;
  /** True when the request targets a canonical `.rsc` payload URL. */
  isRscRequest: boolean;
  /** Sanitized X-Vinext-Interception-Context header (null bytes stripped). null when absent. */
  interceptionContextHeader: string | null;
  /** Normalized x-vinext-mounted-slots header (deduplicated, sorted). null when absent or blank. */
  mountedSlotsHeader: string | null;
  /** Semantic RSC payload mode. HTML requests always normalize to "navigation". */
  renderMode: AppRscRenderMode;
  /** Disabled ClientReuseManifest hint. Never authorizes skip transport in this stage. */
  clientReuseManifest: ClientReuseManifestParseResult;
  /**
   * When present, this is a segment-prefetch RSC request for a specific
   * route segment (e.g. "/_tree", "/dashboard/__PAGE__"). The cleanPathname
   * is the original page path after the .segments/ prefix was stripped.
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
 *   7. RSC detection: `.rsc` suffix only. Segment-prefetch requests are always treated as RSC.
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

  // Step 2: Guard against protocol-relative open redirects on the raw pathname.
  // normalizePath (step 4) would collapse //evil.com to /evil.com, causing the
  // guard to miss it. Raw pathname must be checked first.
  const protoGuard = guardProtocolRelativeUrl(url.pathname);
  if (protoGuard) return protoGuard;

  // Step 3: Strict segment-wise percent-decode. Preserves encoded path delimiters
  // (%2F stays %2F) to prevent encoded slashes from acting as path separators.
  // Throws on malformed sequences like %GG — caller must return 400.
  let decoded: string;
  try {
    decoded = normalizePathnameForRouteMatchStrict(url.pathname);
  } catch {
    return badRequestResponse();
  }

  // Step 4: Collapse double-slashes and resolve . / .. segments.
  let pathname = normalizePath(decoded);

  // Step 5: basePath check and strip.
  // Skipped when basePath is empty (no basePath configured).
  // /__vinext/ prefix bypasses the check for internal prerender endpoints
  // that must be reachable regardless of basePath configuration.
  if (basePath) {
    if (!hasBasePath(pathname, basePath) && !pathname.startsWith("/__vinext/")) {
      return notFoundResponse();
    }
    pathname = stripBasePath(pathname, basePath);
  }

  // Step 6: Segment-prefetch URL detection.
  // extractSegmentPrefetchRsc returns null for non-matching paths (single
  // regex run) so no separate match guard is needed.
  let segmentPrefetchPath: string | null = null;
  const extracted = extractSegmentPrefetchRsc(pathname);
  if (extracted) {
    segmentPrefetchPath = extracted.segmentPath;
    pathname = extracted.originalPathname;
  }

  // Steps 7-8: RSC detection and cleanPathname.
  // Segment-prefetch requests are always treated as RSC requests regardless
  // of whether the rewritten pathname ends with .rsc, because the original
  // URL had a .segment.rsc suffix.
  const isRscRequest = pathname.endsWith(".rsc") || segmentPrefetchPath !== null;
  const cleanPathname = stripRscSuffix(pathname);

  // Step 9: Sanitize X-Vinext-Interception-Context.
  // Null bytes in header values can be used for injection in some HTTP stacks.
  const interceptionContextHeader =
    request.headers.get(VINEXT_INTERCEPTION_CONTEXT_HEADER)?.replaceAll("\0", "") || null;

  // Step 10: Normalize mounted-slots header for canonical cache keying.
  const mountedSlotsHeader = normalizeMountedSlotsHeader(
    request.headers.get(VINEXT_MOUNTED_SLOTS_HEADER),
  );

  // Step 11: Read semantic render mode for refresh/action payload rendering.
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
