// Detects which Web Streams implementation the Worker runs. The markers come from
// workerd's src/workerd/api/tests/ts-webstreams-test.js: the TypeScript classes
// are not `[native code]`, C++-created streams are instances of the global
// ReadableStream, and every class is an own property of globalThis.
import { env } from "cloudflare:workers";

const CLASSES = [
  "ReadableStream",
  "ReadableStreamDefaultReader",
  "ReadableStreamBYOBReader",
  "ReadableStreamDefaultController",
  "ReadableByteStreamController",
  "ReadableStreamBYOBRequest",
  "WritableStream",
  "WritableStreamDefaultWriter",
  "WritableStreamDefaultController",
  "TransformStream",
  "TransformStreamDefaultController",
  "ByteLengthQueuingStrategy",
  "CountQueuingStrategy",
  "TextEncoderStream",
  "TextDecoderStream",
  "CompressionStream",
  "DecompressionStream",
  "FixedLengthStream",
  "IdentityTransformStream",
] as const;

export function assetsFetch(request: Request, path: string): Promise<Response> {
  return (env as unknown as { ASSETS: Fetcher }).ASSETS.fetch(new URL(path, request.url));
}

type Globals = Record<string, unknown> & {
  Cloudflare?: { compatibilityFlags?: Record<string, boolean> };
};

export async function detectStreamsImplementation(request: Request) {
  const g = globalThis as unknown as Globals;
  const classes = CLASSES.map((name) => {
    const value = g[name];
    return {
      name,
      exists: typeof value === "function",
      native:
        typeof value === "function" && /\[native code\]/.test(Function.prototype.toString.call(value)),
      ownGlobal: Object.prototype.hasOwnProperty.call(globalThis, name),
    };
  });

  const webStreams = (await import("node:stream/web")) as unknown as Record<string, unknown>;
  // A body from a native fetcher, the closest local stand-in for a fetch() body.
  const echoed = await assetsFetch(request, "/vinext-image.png");

  const instances = {
    blobStream: new Blob(["x"]).stream() instanceof ReadableStream,
    responseBody: new Response("x").body instanceof ReadableStream,
    requestBody: request.body === null ? null : request.body instanceof ReadableStream,
    fetchBody: echoed?.body ? echoed.body instanceof ReadableStream : null,
    nodeStreamWebIsGlobal: webStreams.ReadableStream === ReadableStream,
    // C++ streams expose a native TransformStream subclass; the TypeScript one is
    // standalone (encoding ledger #2, compression ledger #5).
    compressionExtendsTransform: new CompressionStream("gzip") instanceof TransformStream,
  };

  const notNative = classes.every((c) => c.exists && !c.native && c.ownGlobal);
  return {
    typescript:
      notNative &&
      instances.blobStream &&
      instances.responseBody &&
      instances.requestBody !== false &&
      instances.fetchBody !== false,
    compatibilityFlag: g.Cloudflare?.compatibilityFlags?.typescript_implemented_streams ?? null,
    nativeClasses: classes.filter((c) => c.native).map((c) => c.name),
    missingOrInherited: classes.filter((c) => !c.exists || !c.ownGlobal).map((c) => c.name),
    instances,
  };
}
