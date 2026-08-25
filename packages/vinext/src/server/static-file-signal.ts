const STATIC_FILE_SIGNAL = Symbol.for("vinext.static-file-signal");
const ORIGIN_MANAGED_STATIC_FILE_SIGNAL = Symbol.for("vinext.origin-managed-static-file-signal");

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
  Object.defineProperty(response, STATIC_FILE_SIGNAL, {
    value: encodeURIComponent(pathname),
  });
  return response;
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

/** Mark a static-file signal whose composed response must bypass shared edge caching. */
export function markOriginManagedStaticFileSignal(response: Response): Response {
  Object.defineProperty(response, ORIGIN_MANAGED_STATIC_FILE_SIGNAL, { value: true });
  return response;
}

/** Whether cache safety must be reapplied after the host resolves the asset body. */
export function isOriginManagedStaticFileSignal(response: Response): boolean {
  return Reflect.get(response, ORIGIN_MANAGED_STATIC_FILE_SIGNAL) === true;
}

/** Return the encoded asset pathname only for a framework-created signal. */
export function readStaticFileSignal(response: Response): string | null {
  const signal = Reflect.get(response, STATIC_FILE_SIGNAL);
  return typeof signal === "string" ? signal : null;
}
