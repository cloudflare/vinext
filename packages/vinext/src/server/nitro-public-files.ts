import type { VinextAssetFetcher } from "./multi-stage.js";
import { NITRO_ASSETS_KEY, type NitroAssets } from "./nitro-public-files-plugin.js";
import { createStaticAssetRequest, resolveStaticAssetSignal } from "./worker-utils.js";

function getNitroAssets(): NitroAssets {
  const assets: unknown = Reflect.get(globalThis, Symbol.for(NITRO_ASSETS_KEY));
  if (!assets) {
    throw new Error("[vinext] The Nitro public files plugin did not run.");
  }
  return assets as NitroAssets;
}

// An asset fetch reaches vinext only when Nitro's static handler has no such
// file. Answering it here keeps the router from resolving the same file again.
function notFound(): Response {
  return new Response(null, { status: 404 });
}

type NitroFetchEntry = {
  fetch(request: Request): Promise<Response>;
};

/**
 * Wrap the App Router SSR service that Nitro dispatches requests to, so a
 * public file the router resolves is served by Nitro's static handler.
 */
export function withNitroPublicFiles(entry: NitroFetchEntry): NitroFetchEntry {
  return {
    async fetch(request) {
      const assets = getNitroAssets();
      if (assets.isAssetRequest(request)) return notFound();
      const response = await entry.fetch(request);
      const assetResponse = await resolveStaticAssetSignal(response, {
        fetchAsset: (path, requestHeaders) =>
          assets.fetch(createStaticAssetRequest(path, request, requestHeaders)),
      });
      return assetResponse ?? response;
    },
  };
}

type PagesWorkerEntry<Env, Context extends object> = {
  fetch(request: Request, env: Env, ctx: Context & { assets?: VinextAssetFetcher }): unknown;
};

/**
 * Give the Pages Router worker that Nitro dispatches requests to an asset
 * fetcher that reads files through Nitro's static handler.
 */
export function withNitroPagesPublicFiles<Env, Context extends object>(
  worker: PagesWorkerEntry<Env, Context>,
): PagesWorkerEntry<Env, Context> {
  return {
    fetch(request, env, ctx) {
      const assets = getNitroAssets();
      if (assets.isAssetRequest(request)) return notFound();
      return worker.fetch(request, env, { ...ctx, assets });
    },
  };
}
