/**
 * Shared utilities for Cloudflare Worker entries.
 *
 * Used by hand-written example worker entries and by the generated Pages
 * Router worker entry through "vinext/server/worker-utils".
 */
import { notFoundStaticAssetResponse } from "./http-error-responses.js";
import { readStaticFileSignal, readStaticFileSignalRequestHeaders } from "./static-file-signal.js";

/**
 * Merge middleware/config headers into a response.
 * Response headers take precedence over middleware headers for all headers
 * except Set-Cookie, which is additive (both middleware and response cookies
 * are preserved). Uses getSetCookie() to preserve multiple Set-Cookie values.
 * Keep this in sync with prod-server.ts.
 */
const NO_BODY_RESPONSE_STATUSES = new Set([204, 205, 304]);

type ResponseWithVinextStreamingMetadata = Response & {
  __vinextStreamedHtmlResponse?: boolean;
};

function isVinextStreamedHtmlResponse(response: Response): boolean {
  return (response as ResponseWithVinextStreamingMetadata).__vinextStreamedHtmlResponse === true;
}

function isContentLengthHeader(name: string): boolean {
  return name.toLowerCase() === "content-length";
}

function cancelResponseBody(response: Response): void {
  const body = response.body;
  if (!body || body.locked) return;
  void body.cancel().catch(() => {
    /* ignore cancellation failures on discarded bodies */
  });
}

export function finalizeMissingStaticAssetResponse(
  response: Response,
  missingBuildAsset: boolean,
): Response {
  if (!missingBuildAsset || response.status !== 404) return response;
  cancelResponseBody(response);
  // The missing asset still ran through middleware before route handling.
  // Replace the rendered 404 body without dropping headers middleware added.
  return notFoundStaticAssetResponse(response.headers);
}

function buildHeaderRecord(
  response: Response,
  omitNames: readonly string[] = [],
): Record<string, string | string[]> {
  const omitted = new Set(omitNames.map((name) => name.toLowerCase()));
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (omitted.has(key.toLowerCase()) || key === "set-cookie") return;
    headers[key] = value;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  return headers;
}

export function mergeHeaders(
  response: Response,
  extraHeaders: Record<string, string | string[]>,
  statusOverride?: number,
): Response {
  // As in Next.js, which sets a 304 after middleware's status, a 304 answers
  // the request's own validator.
  const status = response.status === 304 ? 304 : (statusOverride ?? response.status);
  const merged = new Headers();
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (isContentLengthHeader(k)) continue;
    if (Array.isArray(v)) {
      for (const item of v) merged.append(k, item);
    } else {
      merged.set(k, v);
    }
  }
  response.headers.forEach((v, k) => {
    if (k === "set-cookie") return;
    merged.set(k, v);
  });
  const responseCookies = response.headers.getSetCookie?.() ?? [];
  for (const cookie of responseCookies) merged.append("set-cookie", cookie);

  const shouldDropBody = NO_BODY_RESPONSE_STATUSES.has(status);
  const shouldStripStreamLength =
    isVinextStreamedHtmlResponse(response) && merged.has("content-length");

  if (
    !Object.keys(extraHeaders).some((key) => !isContentLengthHeader(key)) &&
    statusOverride === undefined &&
    !shouldDropBody &&
    !shouldStripStreamLength
  ) {
    return response;
  }

  if (shouldDropBody) {
    cancelResponseBody(response);
    merged.delete("content-encoding");
    merged.delete("content-length");
    merged.delete("content-type");
    merged.delete("transfer-encoding");
    return new Response(null, {
      status,
      statusText: status === response.status ? response.statusText : undefined,
      headers: merged,
    });
  }

  if (shouldStripStreamLength) {
    merged.delete("content-length");
  }

  return new Response(response.body, {
    status,
    statusText: status === response.status ? response.statusText : undefined,
    headers: merged,
  });
}

export async function resolveStaticAssetSignal(
  signalResponse: Response,
  options: {
    /** `requestHeaders` are the post-middleware request headers, when middleware set any. */
    fetchAsset(path: string, requestHeaders: Headers | null): Promise<Response>;
  },
): Promise<Response | null> {
  const signal = readStaticFileSignal(signalResponse);
  if (!signal) return null;

  let assetPath = "/";
  try {
    assetPath = decodeURIComponent(signal);
  } catch {
    assetPath = signal;
  }

  const extraHeaders = buildHeaderRecord(signalResponse, [
    "content-encoding",
    "content-length",
    "content-type",
    "transfer-encoding",
  ]);

  const requestHeaders = readStaticFileSignalRequestHeaders(signalResponse);
  cancelResponseBody(signalResponse);
  const assetResponse = await options.fetchAsset(assetPath, requestHeaders);
  // Only preserve the middleware/status-layer override when we actually got a
  // real asset response back. If the asset lookup misses (404/other non-ok),
  // or returns a partial response, keep that filesystem result instead of
  // masking its status while retaining mismatched range headers and body.
  const statusOverride =
    assetResponse.ok && assetResponse.status !== 206 && signalResponse.status !== 200
      ? signalResponse.status
      : undefined;
  return mergeHeaders(assetResponse, extraHeaders, statusOverride);
}

/**
 * Retarget a Worker asset request without dropping its conditional/range
 * fields. `headers` replaces the source request's headers with middleware's
 * overrides, so a removed `Range` or replaced validator reaches the asset fetch.
 */
export function createStaticAssetRequest(
  assetPath: string,
  sourceRequest: Request,
  headers: Headers | null = null,
): Request {
  const assetUrl = new URL(assetPath, sourceRequest.url);
  if (sourceRequest.method === "GET" || sourceRequest.method === "HEAD") {
    return headers
      ? new Request(new Request(assetUrl, sourceRequest), { headers })
      : new Request(assetUrl, sourceRequest);
  }
  return new Request(assetUrl, {
    method: sourceRequest.method,
    headers: headers ?? sourceRequest.headers,
  });
}
