/**
 * Nitro runtime plugin that records each request's raw target before h3 sees
 * it. srvx 0.11 writes the pathname h3 decodes (one with a `%`) back into the
 * Node request's `url`, dropping the authority of an absolute-form target,
 * so vinext's request-based entries read the target this plugin saved.
 *
 * This module runs in Nitro's server bundle, separate from vinext's request
 * handlers, so it imports nothing and shares state through `Symbol.for`.
 */

export const NITRO_REQUEST_TARGET_KEY = "vinext.nitro.requestTarget";

type NitroApp = {
  fetch: (request: Request) => Response | Promise<Response>;
};

type SrvxNodeRequest = Request & {
  runtime?: { node?: { req?: { url?: string } } };
};

export default function nitroRequestTargetPlugin(nitroApp: NitroApp): void {
  const appFetch = nitroApp.fetch;
  const key = Symbol.for(NITRO_REQUEST_TARGET_KEY);
  nitroApp.fetch = (request) => {
    const req = (request as SrvxNodeRequest).runtime?.node?.req;
    if (req && !Reflect.has(req, key)) Reflect.set(req, key, req.url);
    return appFetch(request);
  };
}
