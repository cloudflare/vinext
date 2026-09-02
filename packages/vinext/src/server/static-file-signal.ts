const STATIC_FILE_SIGNAL = Symbol.for("vinext.static-file-signal");
const STATIC_FILE_SIGNAL_TRANSPORT_HEADER = "x-vinext-stage-static-file";
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
function markStaticFileSignal(response: Response, pathname: string): Response {
  return markEncodedStaticFileSignal(response, encodeURIComponent(pathname));
}

function markEncodedStaticFileSignal(response: Response, encodedPathname: string): Response {
  Object.defineProperty(response, STATIC_FILE_SIGNAL, {
    value: encodedPathname,
  });
  return response;
}

function withoutTransportHeader(response: Response): Response {
  if (!response.headers.has(STATIC_FILE_SIGNAL_TRANSPORT_HEADER)) return response;
  const headers = new Headers(response.headers);
  headers.delete(STATIC_FILE_SIGNAL_TRANSPORT_HEADER);
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

/** Create the only response shape that host runtimes may resolve as an asset. */
export function createStaticFileSignal(
  pathname: string,
  context: StaticFileSignalContext,
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

/** Encode a framework-authenticated signal for a standards-only stage transport. */
export function serializeStaticFileSignalForTransport(response: Response, token: string): Response {
  const signal = readStaticFileSignal(response);
  if (signal === null) return response;
  const headers = new Headers(response.headers);
  for (const name of STATIC_FILE_REPRESENTATION_HEADERS) headers.delete(name);
  headers.set(STATIC_FILE_SIGNAL_TRANSPORT_HEADER, `${token}:${signal}`);
  return new Response(null, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/** Restore and consume a signal returned by the trusted response-stage wrapper. */
export function restoreStaticFileSignalFromTransport(response: Response, token: string): Response {
  const transported = response.headers.get(STATIC_FILE_SIGNAL_TRANSPORT_HEADER);
  const cleaned = withoutTransportHeader(response);
  const prefix = `${token}:`;
  if (transported === null || !transported.startsWith(prefix)) return cleaned;
  const encodedPathname = transported.slice(prefix.length);
  try {
    if (!decodeURIComponent(encodedPathname).startsWith("/")) return cleaned;
  } catch {
    return cleaned;
  }
  return markEncodedStaticFileSignal(cleaned, encodedPathname);
}
