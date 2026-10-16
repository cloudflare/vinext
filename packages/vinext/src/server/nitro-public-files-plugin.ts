/**
 * Nitro runtime plugin that lets vinext serve files through Nitro's static
 * handler.
 *
 * vinext's router decides which public file a request resolves to, for
 * example the destination of a rewrite, but on Nitro only the static handler
 * can read the file from the server output. The plugin publishes an asset
 * fetcher that sends a request back through the Nitro app, where the static
 * handler answers it.
 *
 * This module runs in Nitro's server bundle, separate from vinext's request
 * handlers, so it imports nothing and shares state through `globalThis`.
 */

export const NITRO_ASSETS_KEY = "vinext.nitro.assets";

const ASSET_REQUEST_HEADER = "x-vinext-nitro-asset";

type NitroApp = {
  fetch: (request: Request) => Response | Promise<Response>;
};

export type NitroAssets = {
  fetch(request: Request): Promise<Response>;
  /** Whether a request is an asset fetch that Nitro's static handler did not answer. */
  isAssetRequest(request: Request): boolean;
};

export function createNitroPublicFilesPlugin(): (nitroApp: NitroApp) => void {
  return (nitroApp) => {
    const appFetch = nitroApp.fetch;
    // Marks asset fetches so vinext can tell one that reached it apart from a
    // client request. Clients can't know the value, and it only makes vinext
    // answer 404.
    const token = crypto.randomUUID();
    const assets: NitroAssets = {
      async fetch(request) {
        const headers = new Headers(request.headers);
        headers.set(ASSET_REQUEST_HEADER, token);
        return appFetch(new Request(request, { headers }));
      },
      isAssetRequest: (request) => request.headers.get(ASSET_REQUEST_HEADER) === token,
    };
    Reflect.set(globalThis, Symbol.for(NITRO_ASSETS_KEY), assets);
  };
}
