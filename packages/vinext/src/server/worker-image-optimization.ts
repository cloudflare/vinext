/**
 * Image optimization for Worker hosts. A local source is fetched as an
 * anonymous direct request would receive it, like Next.js' fetchInternalImage
 * (packages/next/src/server/image-optimizer.ts), so middleware that denies or
 * redirects a direct request also denies the optimizer.
 */
import { isNextStaticPath } from "../utils/asset-prefix.js";
import { resolveClientBuildFile } from "./client-build-files.js";
import {
  handleConfiguredImageOptimization,
  invalidImageSourceResponse,
  isImageSourceBodyStatus,
  type ImageConfig,
  type ImageOptimizationSignal,
} from "./image-optimization.js";
import { VINEXT_PRERENDER_SPECIAL_ERROR_HEADER } from "./headers.js";
import type { VinextAssetFetcher } from "./multi-stage.js";
import { attachRequestCfMetadata, cloneRequestWithUrl } from "./request-pipeline.js";
import { readStaticFileSignal, readStaticFileSignalRequestHeaders } from "./static-file-signal.js";
import { createStaticAssetRequest, mergeHeaders } from "./worker-utils.js";

export type WorkerImageSourceOptions = {
  assets: VinextAssetFetcher;
  basePath: string;
  assetPathPrefix: string;
  clientBuildFiles: ReadonlySet<string>;
  /**
   * Run `sourceRequest`, a GET without the caller's headers, through the
   * application pipeline and return the public file it selects with a 2xx
   * outcome, or null.
   */
  fetchPublicFile(sourceRequest: Request): Promise<Response | null>;
};

// Representation headers belong to the image, not to middleware's response,
// and only a page's special error carries the internal header.
const OMITTED_MIDDLEWARE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "content-range",
  "content-type",
  "transfer-encoding",
  VINEXT_PRERENDER_SPECIAL_ERROR_HEADER,
]);

function cancelResponseBody(response: Response): void {
  const body = response.body;
  if (!body || body.locked) return;
  void body.cancel().catch(() => {
    /* ignore cancellation failures on discarded bodies */
  });
}

/**
 * Return the pathname of the `_next/static` file a source's decoded pathname
 * names, or null. Next.js matches the decoded pathname against its
 * `.next/static` files literally, so a `.`, `..` or empty segment names no
 * file. The asset binding decodes each segment once, so each segment is
 * encoded once from the name checked here. Parsing the decoded pathname as a
 * URL again would resolve a segment that decoded to `%2E%2E` as `..`, outside
 * `_next/static`.
 */
function resolveNextStaticFile(
  decodedPathname: string,
  options: WorkerImageSourceOptions,
): string | null {
  if (!isNextStaticPath(decodedPathname, options.basePath, options.assetPathPrefix)) return null;
  const segments = decodedPathname.split("/").slice(1);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return "/" + segments.map(encodeURIComponent).join("/");
}

/**
 * Fetch a local image source. Build output is fetched from the asset binding,
 * which serves it before the Worker and its middleware. Any other source is
 * served only when the application pipeline selects a public file for it.
 */
export async function fetchWorkerImageSource(
  imageUrl: string,
  request: Request,
  options: WorkerImageSourceOptions,
): Promise<Response> {
  const sourceUrl = new URL(imageUrl, request.url);
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(sourceUrl.pathname);
  } catch {
    return invalidImageSourceResponse();
  }

  const buildAssetPath =
    resolveNextStaticFile(decodedPathname, options) ??
    resolveClientBuildFile(sourceUrl.pathname, options.basePath, options.clientBuildFiles);
  if (buildAssetPath !== null) {
    return options.assets.fetch(new Request(new URL(buildAssetPath, request.url)));
  }

  // Without the caller's headers, but with the connection's Cloudflare
  // metadata, as Next.js keeps the caller's socket.
  const sourceResponse = await options.fetchPublicFile(
    attachRequestCfMetadata(new Request(sourceUrl, { signal: request.signal }), request),
  );
  if (sourceResponse && isImageSourceBodyStatus(sourceResponse.status)) return sourceResponse;
  if (sourceResponse) cancelResponseBody(sourceResponse);
  return invalidImageSourceResponse();
}

/**
 * Return the public file a framework static-file signal selects, provided the
 * pipeline answered with a body-bearing 2xx outcome. The file is fetched with middleware's
 * request header overrides, as resolveStaticAssetSignal fetches it.
 */
export function fetchSignalledPublicFile(
  response: Response,
  sourceRequest: Request,
  assets: VinextAssetFetcher,
): Promise<Response> | null {
  const signal = isImageSourceBodyStatus(response.status) ? readStaticFileSignal(response) : null;
  const requestHeaders = readStaticFileSignalRequestHeaders(response);
  cancelResponseBody(response);
  if (signal === null) return null;
  let assetPath = signal;
  try {
    assetPath = decodeURIComponent(signal);
  } catch {
    // Fetch the encoded form, as resolveStaticAssetSignal does.
  }
  return Promise.resolve(
    assets.fetch(createStaticAssetRequest(assetPath, sourceRequest, requestHeaders)),
  );
}

/**
 * Serve the App Router image endpoint once the request handler admitted it
 * through middleware and rewrites. Middleware's response headers are sent with
 * the image, as Next.js does.
 */
export async function serveWorkerImageOptimization(
  request: Request,
  signal: ImageOptimizationSignal,
  allowedWidths: number[] | undefined,
  imageConfig: ImageConfig | undefined,
  options: WorkerImageSourceOptions,
): Promise<Response> {
  // The query middleware and rewrites selected, which the handler validated.
  const imageUrl = new URL(request.url);
  imageUrl.search = signal.search;
  const imageRequest = cloneRequestWithUrl(request, imageUrl.href);
  const response = await handleConfiguredImageOptimization(
    // Format negotiation reads the request headers after middleware's overrides.
    signal.requestHeaders
      ? new Request(imageRequest, { headers: signal.requestHeaders })
      : imageRequest,
    (sourceUrl) => fetchWorkerImageSource(sourceUrl, imageRequest, options),
    allowedWidths,
    imageConfig,
  );
  const middlewareHeaders: Record<string, string | string[]> = {};
  signal.middlewareHeaders.forEach((value, name) => {
    if (name === "set-cookie" || OMITTED_MIDDLEWARE_HEADERS.has(name)) return;
    middlewareHeaders[name] = value;
  });
  const cookies = signal.middlewareHeaders.getSetCookie();
  if (cookies.length > 0) middlewareHeaders["set-cookie"] = cookies;
  return mergeHeaders(response, middlewareHeaders);
}
