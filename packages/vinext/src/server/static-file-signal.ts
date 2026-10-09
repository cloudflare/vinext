const STATIC_FILE_SIGNAL = Symbol.for("vinext.static-file-signal");
const STATIC_FILE_REQUEST_HEADERS = Symbol.for("vinext.static-file-request-headers");
const STATIC_FILE_SIGNAL_TRANSPORT_HEADER = "x-vinext-stage-static-file";
const STATIC_FILE_REQUEST_HEADERS_TRANSPORT_HEADER = "x-vinext-stage-static-file-request-headers";
const STATIC_FILE_REPRESENTATION_HEADERS = [
  "content-encoding",
  "content-length",
  "content-type",
  "transfer-encoding",
] as const;

export type StaticFileSignalContext = {
  headers: Headers | null;
  status: number | null;
};

/**
 * Mark a response created by vinext's public-file router.
 *
 * The symbol carries the encoded pathname across the built RSC module boundary
 * before the host runtime can fetch the asset. Application response headers
 * remain ordinary metadata and cannot alter framework control flow.
 */
function markStaticFileSignal(
  response: Response,
  pathname: string,
  requestHeaders: Headers | null,
): Response {
  return markEncodedStaticFileSignal(response, encodeURIComponent(pathname), requestHeaders);
}

function markEncodedStaticFileSignal(
  response: Response,
  encodedPathname: string,
  requestHeaders: Headers | null,
): Response {
  Object.defineProperty(response, STATIC_FILE_SIGNAL, {
    value: encodedPathname,
  });
  if (requestHeaders) {
    Object.defineProperty(response, STATIC_FILE_REQUEST_HEADERS, { value: requestHeaders });
  }
  return response;
}

function withoutTransportHeader(response: Response): Response {
  if (
    !response.headers.has(STATIC_FILE_SIGNAL_TRANSPORT_HEADER) &&
    !response.headers.has(STATIC_FILE_REQUEST_HEADERS_TRANSPORT_HEADER)
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete(STATIC_FILE_SIGNAL_TRANSPORT_HEADER);
  headers.delete(STATIC_FILE_REQUEST_HEADERS_TRANSPORT_HEADER);
  if (response.status < 200 || response.status > 599) {
    // Non-standard responses such as Worker WebSocket upgrades cannot be
    // reconstructed with the standard Response constructor. They can never be
    // static-file signals, so leave the untrusted header inert.
    return response;
  }
  const body =
    response.status === 204 || response.status === 205 || response.status === 304
      ? null
      : response.body;
  return new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * Create the only response shape that host runtimes may resolve as an asset.
 * `requestHeaders` are the request headers after middleware's overrides, which
 * the asset fetch uses in place of the original request's headers.
 */
export function createStaticFileSignal(
  pathname: string,
  context: StaticFileSignalContext,
  requestHeaders: Headers | null = null,
): Response {
  const headers = new Headers();
  if (context.headers) {
    for (const [key, value] of context.headers) {
      headers.append(key, value);
    }
  }
  return markStaticFileSignal(
    new Response(null, {
      status: context.status ?? 200,
      headers,
    }),
    pathname,
    requestHeaders,
  );
}

/** Whether this response was created by vinext's public-file router. */
export function isStaticFileSignal(response: Response): boolean {
  return typeof Reflect.get(response, STATIC_FILE_SIGNAL) === "string";
}

/** Return the encoded asset pathname only for a framework-created signal. */
export function readStaticFileSignal(response: Response): string | null {
  const signal = Reflect.get(response, STATIC_FILE_SIGNAL);
  return typeof signal === "string" ? signal : null;
}

/** Return the post-middleware request headers a framework-created signal carries. */
export function readStaticFileSignalRequestHeaders(response: Response): Headers | null {
  const headers = Reflect.get(response, STATIC_FILE_REQUEST_HEADERS);
  return headers instanceof Headers ? headers : null;
}

/** Encode a framework-authenticated signal for a standards-only stage transport. */
export function serializeStaticFileSignalForTransport(response: Response, token: string): Response {
  const signal = readStaticFileSignal(response);
  if (signal === null) return response;
  const headers = new Headers(response.headers);
  for (const name of STATIC_FILE_REPRESENTATION_HEADERS) headers.delete(name);
  headers.set(STATIC_FILE_SIGNAL_TRANSPORT_HEADER, `${token}:${signal}`);
  const requestHeaders = readStaticFileSignalRequestHeaders(response);
  if (requestHeaders) {
    headers.set(
      STATIC_FILE_REQUEST_HEADERS_TRANSPORT_HEADER,
      `${token}:${encodeURIComponent(JSON.stringify([...requestHeaders]))}`,
    );
  }
  return new Response(null, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/** Restore and consume a signal returned by the trusted response-stage wrapper. */
export function restoreStaticFileSignalFromTransport(response: Response, token: string): Response {
  const transported = response.headers.get(STATIC_FILE_SIGNAL_TRANSPORT_HEADER);
  const transportedRequestHeaders = response.headers.get(
    STATIC_FILE_REQUEST_HEADERS_TRANSPORT_HEADER,
  );
  const cleaned = withoutTransportHeader(response);
  const prefix = `${token}:`;
  if (transported === null || !transported.startsWith(prefix)) return cleaned;
  const encodedPathname = transported.slice(prefix.length);
  let requestHeaders: Headers | null = null;
  try {
    if (!decodeURIComponent(encodedPathname).startsWith("/")) return cleaned;
    if (transportedRequestHeaders !== null) {
      if (!transportedRequestHeaders.startsWith(prefix)) return cleaned;
      requestHeaders = new Headers(
        JSON.parse(decodeURIComponent(transportedRequestHeaders.slice(prefix.length))),
      );
    }
  } catch {
    return cleaned;
  }
  return markEncodedStaticFileSignal(cleaned, encodedPathname, requestHeaders);
}
