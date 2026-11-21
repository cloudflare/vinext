import { MIDDLEWARE_SET_COOKIE_HEADER } from "./headers.js";

export function isEdgeApiRuntime(runtime: string | undefined): boolean {
  return runtime === "edge" || runtime === "experimental-edge";
}

export type EdgeApiExecutionRuntime = "node" | "worker";

const NODE_EDGE_RESPONSE_FORBIDDEN_HEADERS = [
  "content-length",
  "content-encoding",
  "transfer-encoding",
] as const;

/**
 * Remove wire-level body headers after Node's fetch implementation has decoded
 * an Edge API response. Next.js applies the same boundary in its edge sandbox.
 *
 * Workers otherwise keep the original response untouched: workerd preserves
 * the encoded body/header pair and can stream it directly to the client.
 *
 * Both runtimes drop `x-middleware-set-cookie`, the internal copy of the
 * cookies that `NextResponse.cookies` keeps for middleware. Next.js's
 * send-response never writes it to the client.
 */
export function finalizeEdgeApiResponse(
  response: Response,
  runtime: EdgeApiExecutionRuntime,
): Response {
  if (runtime === "worker") {
    if (!response.headers.has(MIDDLEWARE_SET_COOKIE_HEADER)) return response;
    try {
      response.headers.delete(MIDDLEWARE_SET_COOKIE_HEADER);
      return response;
    } catch {
      // fetch() and service-binding responses have immutable headers. Using
      // the response as the init keeps workerd's encodeBody, webSocket and cf.
      const copy = new Response(response.body, response);
      copy.headers.delete(MIDDLEWARE_SET_COOKIE_HEADER);
      return copy;
    }
  }

  const headers = new Headers(response.headers);
  let changed = headers.has(MIDDLEWARE_SET_COOKIE_HEADER);
  headers.delete(MIDDLEWARE_SET_COOKIE_HEADER);
  for (const name of NODE_EDGE_RESPONSE_FORBIDDEN_HEADERS) {
    if (!headers.has(name)) continue;
    headers.delete(name);
    changed = true;
  }
  if (!changed) return response;

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
