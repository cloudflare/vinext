import { NITRO_REQUEST_TARGET_KEY } from "./nitro-request-target-plugin.js";

/** srvx, which serves Nitro's Node presets, exposes the Node request it wraps. */
type SrvxNodeRequest = Request & {
  runtime?: { node?: { req?: { url?: string } } };
};

/**
 * Whether srvx, serving the request on Node, got a request target that is not
 * origin-form (`GET https://other.example/x`). srvx then takes the origin of
 * `request.url` from the target, as RFC 9112 §3.2.2 asks of an origin server.
 * `vinext start` 404s every such target (see `getRepeatedSlashRedirect`) and
 * Next.js never routes one, so the request-based entries Nitro calls refuse
 * them too. The raw target is the one `nitroRequestTargetPlugin` saved before
 * h3 could rewrite `req.url`.
 */
export function isSrvxAbsoluteFormTarget(request: Request): boolean {
  const req = (request as SrvxNodeRequest).runtime?.node?.req;
  if (!req) return false;
  const saved: unknown = Reflect.get(req, Symbol.for(NITRO_REQUEST_TARGET_KEY));
  const target = typeof saved === "string" ? saved : req.url;
  return !!target && !target.startsWith("/");
}
