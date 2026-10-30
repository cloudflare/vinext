import type { IncomingMessage } from "node:http";
import { resolveTrustedForwardedHost } from "./proxy-trust.js";

/**
 * srvx, which serves Nitro's Node presets and @vitejs/plugin-rsc's dev and
 * preview handlers, exposes the Node request it wraps.
 */
type SrvxNodeRequest = Request & {
  runtime?: { node?: { req?: Pick<IncomingMessage, "socket"> } };
};

/**
 * The server-owned origin middleware runs against when srvx serves the
 * request on Node. srvx builds `request.url` from the client's Host header,
 * which must not decide whether a rewrite to another host is external, so
 * like the Node production server (and Next.js, which uses its hostname and
 * port) this uses the local port, or a trusted `X-Forwarded-Host`. Undefined
 * on other hosts, and on Vercel, which routes by hostname like Workers; they
 * keep the request URL's origin.
 */
export function resolveSrvxMiddlewareOrigin(request: Request): string | undefined {
  const socket = (request as SrvxNodeRequest).runtime?.node?.req?.socket;
  if (!socket || process.env.VERCEL) return undefined;
  const protocol = request.url.startsWith("https:") ? "https:" : "http:";
  const host =
    resolveTrustedForwardedHost(request.headers) ??
    (socket.localPort === undefined ? "localhost" : `localhost:${socket.localPort}`);
  return `${protocol}//${host}`;
}
