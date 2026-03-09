/**
 * Cloudflare Worker entry point with image optimization.
 *
 * For apps without image optimization, use vinext/server/app-router-entry
 * directly in wrangler.jsonc: "main": "vinext/server/app-router-entry"
 */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import type { ImageConfig } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
// @ts-expect-error -- virtual module resolved by vinext at build time
import vinextImageConfig from "virtual:vinext-image-config";

interface Env {
  ASSETS: Fetcher;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

const imageConfig: ImageConfig | undefined = vinextImageConfig ? {
  path: vinextImageConfig.path,
  deviceSizes: vinextImageConfig.deviceSizes,
  imageSizes: vinextImageConfig.imageSizes,
  domains: vinextImageConfig.domains,
  remotePatterns: vinextImageConfig.remotePatterns,
  localPatterns: vinextImageConfig.localPatterns,
  qualities: vinextImageConfig.qualities,
  formats: vinextImageConfig.formats,
  minimumCacheTTL: vinextImageConfig.minimumCacheTTL,
  maximumRedirects: vinextImageConfig.maximumRedirects,
  maximumResponseBody: vinextImageConfig.maximumResponseBody,
  dangerouslyAllowLocalIP: vinextImageConfig.dangerouslyAllowLocalIP,
  dangerouslyAllowSVG: vinextImageConfig.dangerouslyAllowSVG,
  contentDispositionType: vinextImageConfig.contentDispositionType,
  contentSecurityPolicy: vinextImageConfig.contentSecurityPolicy,
} : undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Image optimization via Cloudflare Images binding
    if (url.pathname === (imageConfig?.path ?? "/_vinext/image")) {
      const allowedWidths = [...(imageConfig?.deviceSizes ?? DEFAULT_DEVICE_SIZES), ...(imageConfig?.imageSizes ?? DEFAULT_IMAGE_SIZES)];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths, imageConfig);
    }

    // Delegate everything else to vinext
    return handler.fetch(request);
  },
};
