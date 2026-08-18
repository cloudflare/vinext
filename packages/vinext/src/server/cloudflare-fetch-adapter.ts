import type { Readable as NodeReadable } from "node:stream";

type SupportedContentEncoding = "br" | "deflate" | "gzip";

type WorkersRequestInit = RequestInit & {
  encodeResponseBody?: "automatic" | "manual";
};

type WorkersResponse = Response & {
  cf?: unknown;
};

const INSTALL_KEY = Symbol.for("vinext.cloudflareFetchAdapter.installed");
const ORIGINAL_FETCH_KEY = Symbol.for("vinext.cloudflareFetchAdapter.originalFetch");
const NODE_DEFAULT_ACCEPT_ENCODING = "gzip, deflate";

function isCloudflareWorkersRuntime(): boolean {
  return globalThis.navigator?.userAgent === "Cloudflare-Workers";
}

function getEffectiveRequestHeaders(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Headers | null {
  if (init?.headers !== undefined) return new Headers(init.headers);
  return input instanceof Request ? input.headers : null;
}

function requestsEncodedPassthrough(init: RequestInit | undefined): boolean {
  return (init as WorkersRequestInit | undefined)?.encodeResponseBody === "manual";
}

function parseContentEncodings(headers: Headers): SupportedContentEncoding[] | null {
  const contentEncoding = headers.get("content-encoding");
  if (!contentEncoding) return [];

  const encodings: SupportedContentEncoding[] = [];
  for (const value of contentEncoding.split(",")) {
    const encoding = value.trim().toLowerCase();
    if (!encoding || encoding === "identity") continue;
    if (encoding === "x-gzip") {
      encodings.push("gzip");
    } else if (encoding === "br" || encoding === "deflate" || encoding === "gzip") {
      encodings.push(encoding);
    } else {
      return null;
    }
  }
  return encodings;
}

async function createDecodedBodyReader(
  body: ReadableStream<Uint8Array>,
  encodings: SupportedContentEncoding[],
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const [{ Readable }, zlib] = await Promise.all([import("node:stream"), import("node:zlib")]);
  let decoded: NodeReadable = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);

  // Content codings are listed in the order in which they were applied, so
  // decoding runs in reverse. Node's zlib streams accept concatenated gzip
  // members, matching the HTTP decoder used by Next.js's native fetch.
  for (const encoding of [...encodings].reverse()) {
    const decoder =
      encoding === "br"
        ? zlib.createBrotliDecompress()
        : encoding === "deflate"
          ? zlib.createInflate()
          : zlib.createGunzip();
    decoded = decoded.pipe(decoder);
  }

  return (Readable.toWeb(decoded) as unknown as ReadableStream<Uint8Array>).getReader();
}

function decodeBodyLazily(
  body: ReadableStream<Uint8Array>,
  encodings: SupportedContentEncoding[],
): ReadableStream<Uint8Array> {
  let readerPromise: Promise<ReadableStreamDefaultReader<Uint8Array>> | undefined;

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const reader = await (readerPromise ??= createDecodedBodyReader(body, encodings));
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
      async cancel(reason) {
        if (readerPromise) {
          await (await readerPromise).cancel(reason);
        } else {
          await body.cancel(reason);
        }
      },
    },
    // Do not pull from the origin until the caller consumes the body. Native
    // fetch (and Next.js) resolves as soon as response headers are available.
    { highWaterMark: 0 },
  );
}

function copyResponseProperty(
  target: Response,
  source: Response,
  property: "redirected" | "url",
): void {
  Object.defineProperty(target, property, {
    value: source[property],
    configurable: true,
    enumerable: true,
    writable: false,
  });
}

function preserveFetchResponseMetadata(target: Response, source: Response): Response {
  const nativeClone = target.clone.bind(target);

  copyResponseProperty(target, source, "redirected");
  copyResponseProperty(target, source, "url");
  Object.defineProperty(target, "type", {
    // Server-side HTTP fetches are `basic` in Node/Undici. Workerd reports
    // `default`, so normalize this observable field to the Next.js oracle.
    value: "basic",
    configurable: true,
    enumerable: true,
    writable: false,
  });

  const cf = (source as WorkersResponse).cf;
  if (cf !== undefined) {
    Object.defineProperty(target, "cf", {
      value: structuredClone(cf),
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  // Response.clone() operates on internal slots, which do not include the URL
  // list from the original fetch response after reconstruction. Decorate each
  // clone so metadata parity survives the same operation Next.js performs.
  // Keep the Response constructor's own Headers object: Next's cloneResponse
  // helper does the same, giving every response and clone distinct header
  // storage instead of exposing a separate copied object.
  Object.defineProperty(target, "clone", {
    value: () => preserveFetchResponseMetadata(nativeClone(), source),
    configurable: true,
    enumerable: false,
    writable: false,
  });

  return target;
}

function decodeResponse(response: Response): Response {
  if (!response.body) return response;

  const encodings = parseContentEncodings(response.headers);
  if (!encodings || encodings.length === 0) return response;

  return preserveFetchResponseMetadata(
    new Response(decodeBodyLazily(response.body, encodings), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    response,
  );
}

/**
 * Reproduce the complete content decoding performed by Node's native fetch.
 *
 * Workerd's automatic decoder currently handles only a single `gzip` or `br`
 * token. Asking it for the raw body lets vinext decode the complete advertised
 * chain while preserving the response headers and metadata that Next.js sees.
 * Explicit Workers compressed-passthrough requests remain untouched.
 */
export function createCloudflareFetchAdapter(
  originalFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async function cloudflareFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    if (requestsEncodedPassthrough(init)) return originalFetch(input, init);

    const headers = new Headers(getEffectiveRequestHeaders(input, init) ?? undefined);
    // Node's native fetch (the transport used by Next.js) sends this default.
    // Workerd stops adding Accept-Encoding when manual body mode is selected,
    // so provide the same value explicitly before decoding the raw response.
    if (!headers.has("accept-encoding")) {
      headers.set("accept-encoding", NODE_DEFAULT_ACCEPT_ENCODING);
    }
    const response = await originalFetch(input, {
      ...init,
      headers,
      encodeResponseBody: "manual",
    } as WorkersRequestInit);
    return decodeResponse(response);
  } as typeof globalThis.fetch;
}

/** Install once, before generated server entries evaluate user modules. */
export function installCloudflareFetchAdapter(): void {
  if (!isCloudflareWorkersRuntime()) return;

  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  if (globals[INSTALL_KEY]) return;

  const originalFetch = (globals[ORIGINAL_FETCH_KEY] ??=
    globalThis.fetch) as typeof globalThis.fetch;
  globalThis.fetch = createCloudflareFetchAdapter(originalFetch);
  globals[INSTALL_KEY] = true;
}
