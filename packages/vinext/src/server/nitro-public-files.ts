/**
 * Public files for vinext services hosted by Nitro on Node-like presets.
 *
 * Nitro serves `public/` with its own static handler, which runs before the
 * vinext service, and gives the service no ASSETS-style binding. A request
 * that reaches a public file only after a rewrite (a next.config rewrite or a
 * middleware rewrite) is therefore fetched back through the running Nitro
 * app, where that static handler answers it.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { VinextAssetFetcher } from "./multi-stage.js";
import { isStaticFileSignal } from "./static-file-signal.js";
import { notFoundResponse } from "./http-error-responses.js";
import { createStaticAssetRequest, resolveStaticAssetSignal } from "./worker-utils.js";

type NitroApp = { fetch(request: Request): Response | Promise<Response> };

// Marks the sub-request. If Nitro has no such file, the sub-request reaches
// vinext again, and it must end in a 404 there rather than fetch again.
const publicFileSubrequest = new AsyncLocalStorage<true>();

function getNitroApp(): NitroApp | undefined {
  const app = (globalThis as { __nitro__?: { default?: Partial<NitroApp> } }).__nitro__?.default;
  return typeof app?.fetch === "function" ? (app as NitroApp) : undefined;
}

/**
 * A fetcher for `public/` files backed by the running Nitro app. Undefined
 * when no Nitro app is running, or inside one of its own sub-requests.
 */
export function getNitroPublicFileFetcher(): VinextAssetFetcher | undefined {
  if (publicFileSubrequest.getStore()) return undefined;
  const app = getNitroApp();
  if (!app) return undefined;
  return {
    fetch(request) {
      return publicFileSubrequest.run(true, () => app.fetch(request));
    },
  };
}

/**
 * Serve the public file an App Router static-file signal points at. Any other
 * response is returned unchanged.
 */
export async function resolveNitroStaticFileSignal(
  response: Response,
  request: Request,
): Promise<Response> {
  if (!isStaticFileSignal(response)) return response;
  if (publicFileSubrequest.getStore()) {
    void response.body?.cancel().catch(() => {});
    return notFoundResponse();
  }
  const fetcher = getNitroPublicFileFetcher();
  if (!fetcher) return response;
  const assetResponse = await resolveStaticAssetSignal(response, {
    fetchAsset: (assetPath) =>
      Promise.resolve(fetcher.fetch(createStaticAssetRequest(assetPath, request))),
  });
  return assetResponse ?? response;
}
