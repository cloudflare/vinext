export const SERVER_ACTION_CACHE_CONTROL = "no-cache, no-store, max-age=0, must-revalidate";
export const UNRECOGNIZED_ACTION_CACHE_CONTROL = "no-cache, must-revalidate";
const SERVER_ACTION_RESPONSE_HEADER = "x-vinext-server-action-response";
const RECOGNIZED_ACTION_MARKER = "1";
const UNRECOGNIZED_ACTION_MARKER = "unrecognized";

function updateServerActionCacheControl(
  response: Response,
  options: { keepMarker: boolean; recognized: boolean },
): Response {
  const updateHeaders = (headers: Headers): void => {
    headers.set(
      "Cache-Control",
      options.recognized ? SERVER_ACTION_CACHE_CONTROL : UNRECOGNIZED_ACTION_CACHE_CONTROL,
    );
    headers.delete("CDN-Cache-Control");
    headers.delete("Cloudflare-CDN-Cache-Control");
    headers.delete("Cache-Tag");
    if (options.keepMarker) {
      headers.set(
        SERVER_ACTION_RESPONSE_HEADER,
        options.recognized ? RECOGNIZED_ACTION_MARKER : UNRECOGNIZED_ACTION_MARKER,
      );
    } else {
      headers.delete(SERVER_ACTION_RESPONSE_HEADER);
    }
  };

  try {
    updateHeaders(response.headers);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    updateHeaders(headers);
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
}

/**
 * Server Action responses are never cacheable. Next.js applies this policy
 * before action dispatch, so it is preserved for successes and every error
 * path, including progressive page renders.
 */
export function applyServerActionCacheControl(response: Response): Response {
  return updateServerActionCacheControl(response, { keepMarker: true, recognized: true });
}

/**
 * Mark a malformed development progressive POST as action-classified while
 * retaining Next.js' development revalidation policy. The outer response
 * finalizer uses the marker to remove config/CDN cache headers after merging.
 */
export function applyUnrecognizedServerActionCacheControl(response: Response): Response {
  return updateServerActionCacheControl(response, { keepMarker: true, recognized: false });
}

/** Reassert the action policy after outer response headers have been merged. */
export function finalizeServerActionCacheControl(response: Response): Response {
  return updateServerActionCacheControl(response, {
    keepMarker: false,
    recognized: response.headers.get(SERVER_ACTION_RESPONSE_HEADER) !== UNRECOGNIZED_ACTION_MARKER,
  });
}

export function isServerActionResponse(response: Pick<Response, "headers">): boolean {
  const marker = response.headers.get(SERVER_ACTION_RESPONSE_HEADER);
  return marker === RECOGNIZED_ACTION_MARKER || marker === UNRECOGNIZED_ACTION_MARKER;
}
