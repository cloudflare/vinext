import { normalizePath } from "./normalize-path.js";
import { normalizePathnameForRouteMatchStrict } from "../routing/utils.js";
import { guardProtocolRelativeUrl } from "./request-pipeline.js";
import { hasBasePath, stripBasePath } from "../utils/base-path.js";
import { normalizeMountedSlotsHeader } from "./app-mounted-slots-header.js";
import { stripRscSuffix } from "./app-rsc-cache-busting.js";
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
  segmentPrefetchPath: string | null;
};

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
    request.headers.get("X-Vinext-Interception-Context")?.replaceAll("\0", "") || null;

  const mountedSlotsHeader = normalizeMountedSlotsHeader(
    request.headers.get("x-vinext-mounted-slots"),
  );

  return {
    url,
    pathname,
    cleanPathname,
    isRscRequest,
    interceptionContextHeader,
    mountedSlotsHeader,
    segmentPrefetchPath,
  };
}
