import { normalizePath } from "./normalize-path.js";
import { normalizePathnameForRouteMatchStrict } from "../routing/utils.js";
import { guardProtocolRelativeUrl } from "./request-pipeline.js";
import { hasBasePath, stripBasePath } from "../utils/base-path.js";
import {
  RSC_HEADER,
  VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_RSC_RENDER_MODE_HEADER,
} from "./headers.js";
import {
  parseClientReuseManifestHeader,
  type ClientReuseManifestParseResult,
} from "./client-reuse-manifest.js";
import { normalizeInterceptionContextHeader } from "./app-interception-context-header.js";
import { normalizeMountedSlotsHeader } from "./app-mounted-slots-header.js";
import { stripRscSuffix } from "./app-rsc-cache-busting.js";
import {
  APP_RSC_RENDER_MODE_NAVIGATION,
  parseAppRscRenderMode,
  type AppRscRenderMode,
} from "./app-rsc-render-mode.js";
import { extractSegmentPrefetchRsc } from "./app-segment-prefetch-normalizer.js";
import { badRequestResponse, notFoundResponse } from "./http-error-responses.js";

/**
 * Matches an unresolved `..` segment bounded by a real or percent-encoded
 * structural delimiter (`/`, `%2F`, `%5C`, `%23`, `%3F`, any case).
 *
 * - `%5C`: the strict decoder (normalizePathnameForRouteMatchStrict)
 *   re-encodes both `\` and `%5C` to `%5C`, so `..%5C` survives as an opaque
 *   token exactly like `..%2F` — and backslash acts as a path separator on
 *   Windows and in some downstream path stacks.
 * - `%23` / `%3F`: encoded `#` and `?` are not path separators, but a
 *   downstream re-decode followed by URL re-parsing would truncate at the
 *   fragment/query delimiter, leaving a trailing `..` in separator position
 *   (e.g. `/foo/..%23bar` → `/foo/..#bar` → path `/foo/..`). No legitimate
 *   path places `..` adjacent to these sequences, so rejecting is free.
 *
 * Used by the segment-prefetch traversal guard below.
 */
const TRAVERSAL_GUARD_PATTERN = /(^|\/|%2f|%5c|%23|%3f)\.\.($|\/|%2f|%5c|%23|%3f)/i;

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
  /** Parsed ClientReuseManifest hint. Verification and skip authorization happen later. */
  clientReuseManifest: ClientReuseManifestParseResult;
  /** Whether the incoming pathname included the configured basePath. */
  hadBasePath: boolean;
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
 *   7. RSC detection: `.rsc` suffix or Next-style `RSC: 1`. The internal
 *      `_rsc` cache-busting query is validated separately so full-route Flight
 *      responses do not share the canonical HTML URL in caches that ignore Vary.
 *   8. cleanPathname — pathname with `.rsc` suffix stripped
 *   9. Sanitize X-Vinext-Interception-Context — strip null bytes, bound length,
 *      reject non-pathname values (header injection & cache-key fan-out defense)
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
  allowOutsideBasePath = false,
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
  let hadBasePath = true;

  // Step 5: basePath check and strip.
  // Skipped when basePath is empty (no basePath configured).
  // /__vinext/ prefix bypasses the check for internal prerender endpoints
  // that must be reachable regardless of basePath configuration.
  if (basePath) {
    hadBasePath = hasBasePath(pathname, basePath);
    if (!hadBasePath && !pathname.startsWith("/__vinext/") && !allowOutsideBasePath) {
      return notFoundResponse();
    }
    if (hadBasePath) pathname = stripBasePath(pathname, basePath);
  }

  // Step 6: Segment-prefetch URL detection.
  // extractSegmentPrefetchRsc returns null for non-matching paths (single
  // regex run) so no separate match guard is needed.
  let segmentPrefetchPath: string | null = null;
  const extracted = extractSegmentPrefetchRsc(pathname);
  if (extracted) {
    // Security: neither the extracted originalPathname nor the segmentPath may
    // reintroduce path traversal sequences. normalizePath (step 4) resolved
    // literal .. segments against / separators, but percent-encoded forms like
    // ..%2F and ..%5C survive the strict decode (step 3) as single opaque
    // segments and can be decoded later. Both captures are checked:
    // segmentPath is threaded through for Phase 2 segment-level response
    // generation, so a .. sequence there is a latent traversal for any future
    // consumer that walks a tree keyed on it. No legitimate client produces
    // traversal sequences in either capture.
    //
    // Double-encoded ..%252F is intentionally NOT rejected: the strict decode
    // turns %25 into a literal %, leaving the opaque text "%252F" that
    // normalizePath cannot resolve to a parent directory. This is safe ONLY
    // because no downstream layer performs a second percent-decode pass on
    // pathname. If a re-decode is ever added, this guard must also reject
    // ..%25 sequences.
    //
    // NUL bytes are rejected outright: the strict decoder converts %00 to a
    // literal \0 (it only re-encodes delimiters), and both captures feed
    // Phase 2 consumers (cache keys, segment tree walks) where an embedded
    // NUL enables key truncation and header-injection style attacks. This
    // mirrors the step 9 interception-context sanitizer, which strips NULs
    // for the same reason. No legitimate client emits NUL in either capture.
    if (
      TRAVERSAL_GUARD_PATTERN.test(extracted.originalPathname) ||
      TRAVERSAL_GUARD_PATTERN.test(extracted.segmentPath) ||
      extracted.originalPathname.includes("\0") ||
      extracted.segmentPath.includes("\0")
    ) {
      return badRequestResponse();
    }
    segmentPrefetchPath = extracted.segmentPath;
    pathname = normalizePath(extracted.originalPathname);
  }

  // Steps 7-8: RSC detection and cleanPathname.
  // Segment-prefetch requests are always treated as RSC requests regardless
  // of whether the rewritten pathname ends with .rsc, because the original
  // URL had a .segment.rsc suffix.
  const isRscRequest =
    pathname.endsWith(".rsc") ||
    request.headers.get(RSC_HEADER) === "1" ||
    segmentPrefetchPath !== null;
  const cleanPathname = stripRscSuffix(pathname);

  // Step 9: Validate and sanitize X-Vinext-Interception-Context.
  //
  // The legitimate value is always a same-origin URL pathname (`/feed`,
  // `/photos/42`, …) emitted by the vinext browser entry. We strip null bytes
  // (header-injection defense), bound length, and require a pathname-shaped
  // value so an attacker cannot fan out unbounded distinct values into the
  // RSC / optimistic-route cache keys. See SECURITY-AUDIT-2026-05.md F-PROD-1.
  const interceptionContextHeader = normalizeInterceptionContextHeader(
    request.headers.get(VINEXT_INTERCEPTION_CONTEXT_HEADER),
  );

  // Step 10: Normalize mounted-slots header for canonical cache keying.
  const mountedSlotsHeader = normalizeMountedSlotsHeader(
    request.headers.get(VINEXT_MOUNTED_SLOTS_HEADER),
  );

  // Step 11: Read semantic render mode for refresh/action payload rendering.
  const renderMode = isRscRequest
    ? parseAppRscRenderMode(request.headers.get(VINEXT_RSC_RENDER_MODE_HEADER))
    : APP_RSC_RENDER_MODE_NAVIGATION;
  // Step 12: Parse ClientReuseManifest hints on canonical RSC payload requests.
  const clientReuseManifest = isRscRequest
    ? parseClientReuseManifestHeader(request.headers.get(VINEXT_CLIENT_REUSE_MANIFEST_HEADER))
    : ({ kind: "absent" } satisfies ClientReuseManifestParseResult);

  return {
    clientReuseManifest,
    hadBasePath,
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
