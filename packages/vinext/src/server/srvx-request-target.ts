import type { IncomingMessage } from "node:http";

/** srvx, which serves Nitro's Node presets, exposes the Node request it wraps. */
type SrvxNodeRequest = Request & {
  runtime?: { node?: { req?: Pick<IncomingMessage, "headers" | "url"> } };
};

/**
 * Whether srvx, serving the request on Node, took the origin of `request.url`
 * from an absolute-form request target (`GET https://other.example/x`), as
 * RFC 9112 §3.2.2 asks of an origin server. `vinext start` 404s every target
 * that is not origin-form (see `getRepeatedSlashRedirect`) and Next.js never
 * routes one, so the request-based entries Nitro calls refuse them too.
 */
export function isSrvxAbsoluteFormTarget(request: Request): boolean {
  const req = (request as SrvxNodeRequest).runtime?.node?.req;
  if (!req) return false;
  if (req.url && !req.url.startsWith("/")) return true;

  // srvx 0.11 writes the pathname h3 decodes (one with a `%`) back into
  // req.url, dropping the target's authority. For an origin-form target it
  // builds an http(s) URL on the Host header (`_invalid_` when malformed);
  // later versions keep req.url and may use a trusted X-Forwarded-Host.
  if (!URL.canParse(request.url)) return false;
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const host = req.headers.host || req.headers[":authority"];
  if (!host || typeof host !== "string" || url.hostname === "_invalid_") return false;
  const forwardedHost = req.headers["x-forwarded-host"];
  const names = [host, ...(typeof forwardedHost === "string" ? forwardedHost.split(",") : [])];
  return !names.some((name) => {
    const origin = `${url.protocol}//${name.trim()}`;
    return URL.canParse(origin) && new URL(origin).host === url.host;
  });
}
