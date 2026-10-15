/**
 * Resolve static-file signals for plain Node `vinext dev` App Router requests.
 *
 * The App Router handler runs inside Vite's module runner and @vitejs/plugin-rsc
 * writes its Response straight to Node, so nothing downstream consumes the
 * signal the way prod-server and the Worker entry do. The dev host scopes a
 * public-file server to each request through an AsyncLocalStorage kept on
 * globalThis. Workers and external runtimes (Nitro) have no such scope and keep
 * resolving signals in their own entry.
 *
 * This module stays free of Node imports because it is bundled into every
 * App Router runtime; the host side lives in dev-static-file-server.ts.
 */
import { resolveStaticAssetSignal } from "./worker-utils.js";

export const DEV_STATIC_FILE_SERVER_STORAGE_KEY = Symbol.for("vinext.devStaticFileServerStorage");

export type DevStaticFileServer = (pathname: string, request: Request) => Promise<Response>;

type DevStaticFileServerStorage = {
  getStore(): DevStaticFileServer | undefined;
};

export async function resolveDevStaticFileSignal(
  response: Response,
  request: Request,
): Promise<Response> {
  const storage = (globalThis as unknown as Record<PropertyKey, unknown>)[
    DEV_STATIC_FILE_SERVER_STORAGE_KEY
  ] as DevStaticFileServerStorage | undefined;
  const serveStaticFile = storage?.getStore();
  if (!serveStaticFile) return response;

  const staticFileResponse = await resolveStaticAssetSignal(response, {
    fetchAsset: (pathname) => serveStaticFile(pathname, request),
  });
  return staticFileResponse ?? response;
}
