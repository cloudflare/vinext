/**
 * Image optimization for the App Router Worker entries, after the RSC handler
 * admitted the image endpoint through middleware and rewrites.
 */
import { isNextStaticPath } from "../utils/asset-prefix.js";
import { hasBasePath } from "../utils/base-path.js";
import {
  handleConfiguredImageOptimization,
  type ImageConfig,
  type ImageOptimizationSignal,
} from "./image-optimization.js";
import { VINEXT_PRERENDER_SPECIAL_ERROR_HEADER } from "./headers.js";
import { readStaticFileSignal } from "./static-file-signal.js";
import { mergeHeaders } from "./worker-utils.js";

// Middleware headers never sent with the image: its own representation
// headers, and the internal header only a page's special error carries.
const OMIT_MIDDLEWARE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "content-range",
  "content-type",
  VINEXT_PRERENDER_SPECIAL_ERROR_HEADER,
]);

export type WorkerImageOptimizationOptions = {
  allowedWidths: number[];
  assetPathPrefix: string;
  basePath: string;
  fetchAsset(request: Request): Promise<Response>;
  imageConfig?: ImageConfig;
  /** Run a request through the application as a direct request. */
  resolveSource(request: Request): Promise<Response>;
  /** Prefix for sources outside basePath, when the endpoint was requested outside it. */
  sourceBasePath: string;
};

function cancelResponseBody(response: Response): void {
  const body = response.body;
  if (!body || body.locked) return;
  void body.cancel().catch(() => {
    /* ignore cancellation failures on discarded bodies */
  });
}

function middlewareHeaderRecord(headers: Headers): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = {};
  headers.forEach((value, name) => {
    if (name === "set-cookie" || OMIT_MIDDLEWARE_HEADERS.has(name)) return;
    record[name] = value;
  });
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) record["set-cookie"] = cookies;
  return record;
}

// Serve the source only as an anonymous direct request would receive it.
async function fetchImageSource(
  sourcePath: string,
  request: Request,
  options: WorkerImageOptimizationOptions,
): Promise<Response> {
  // Build assets under a distinct assetPrefix path are not under the basePath.
  const sourceUrl = new URL(
    options.sourceBasePath &&
      !hasBasePath(sourcePath, options.sourceBasePath) &&
      !(options.assetPathPrefix && hasBasePath(sourcePath, options.assetPathPrefix))
      ? options.sourceBasePath + sourcePath
      : sourcePath,
    request.url,
  );
  // Workers Static Assets serves build assets before middleware for direct
  // requests too.
  if (isNextStaticPath(sourceUrl.pathname, options.basePath, options.assetPathPrefix)) {
    const asset = await options.fetchAsset(new Request(sourceUrl, { signal: request.signal }));
    if (asset.ok) return asset;
    cancelResponseBody(asset);
  }
  // Any other source goes through the application as a GET without the
  // caller's headers, like Next.js' fetchInternalImage, so middleware admits
  // it. Without a Host header, host conditions never match. Only a public
  // file that the application selects is served.
  const sourceResponse = await options.resolveSource(
    new Request(sourceUrl, { headers: { host: "" }, signal: request.signal }),
  );
  const staticFile = sourceResponse.ok ? readStaticFileSignal(sourceResponse) : null;
  cancelResponseBody(sourceResponse);
  if (staticFile === null || request.signal.aborted) {
    return new Response("Image not found", { status: 404 });
  }
  let assetPath = staticFile;
  try {
    assetPath = decodeURIComponent(staticFile);
  } catch {
    // Fetch the encoded form, as the static-file signal branch does.
  }
  return options.fetchAsset(
    new Request(new URL(assetPath, request.url), { signal: request.signal }),
  );
}

/**
 * Serve the image for an endpoint response the RSC handler marked, with the
 * query middleware and rewrites selected and middleware's response headers,
 * as Next.js sends them with the image.
 */
export async function handleWorkerImageOptimization(
  request: Request,
  signal: ImageOptimizationSignal,
  options: WorkerImageOptimizationOptions,
): Promise<Response> {
  const imageUrl = new URL(request.url);
  imageUrl.search = signal.search;
  const image = await handleConfiguredImageOptimization(
    new Request(imageUrl, request),
    (sourcePath) => fetchImageSource(sourcePath, request, options),
    options.allowedWidths,
    options.imageConfig,
  );
  return mergeHeaders(image, middlewareHeaderRecord(signal.middlewareHeaders));
}
