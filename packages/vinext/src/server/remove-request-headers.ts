import type { IncomingMessage } from "node:http";
import type { Http2ServerRequest } from "node:http2";

/**
 * Remove headers from every view of a Node request.
 *
 * Node keeps each client header in req.rawHeaders as well as req.headers, and
 * srvx (plugin-rsc's dev request adapter) answers Headers reads from rawHeaders
 * once anything iterates them, so later handlers must not find a removed
 * header in either. On HTTP/1, Node builds req.headers and req.headersDistinct
 * lazily from rawHeaders and the header count it parsed, so both must exist
 * before rawHeaders gets shorter. HTTP/2 compatibility requests (Vite with
 * `server.https`) have no headersDistinct.
 */
export function removeRequestHeaders(
  req: IncomingMessage | Http2ServerRequest,
  names: ReadonlySet<string>,
): void {
  const headersDistinct = "headersDistinct" in req ? req.headersDistinct : undefined;
  for (const name of names) {
    delete req.headers[name];
    if (headersDistinct) delete headersDistinct[name];
  }
  const rawHeaders = req.rawHeaders;
  for (let i = rawHeaders.length - 2; i >= 0; i -= 2) {
    if (names.has(rawHeaders[i].toLowerCase())) rawHeaders.splice(i, 2);
  }
}
