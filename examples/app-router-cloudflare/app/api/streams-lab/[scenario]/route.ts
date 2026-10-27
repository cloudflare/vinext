// Streamed responses and request bodies, built the ways Next.js route handlers
// build them. Coverage: tests/e2e/cloudflare-workers/streams-lab.spec.ts
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { runChecks } from "../checks";
import { sha256Hex } from "../digest";
import { assetsFetch, detectStreamsImplementation } from "../impl";

export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

// Cancellations seen by /cancel, read back by /cancel-status. Only meaningful
// when one isolate serves both requests, as under wrangler dev.
const cancellations = new Map<string, string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Byte `i` of the deterministic pattern the large bodies stream. */
function patternChunk(offset: number, length: number): Uint8Array {
  const chunk = new Uint8Array(length);
  for (let i = 0; i < length; i++) chunk[i] = (offset + i) % 251;
  return chunk;
}

const MIB = 1024 * 1024;

type Handler = (request: NextRequest) => Response | Promise<Response>;

const getHandlers: Record<string, Handler> = {
  impl: async (request) => Response.json(await detectStreamsImplementation(request)),
  checks: async (request) =>
    Response.json(await runChecks(request, request.nextUrl.searchParams.get("only"))),

  // Server-sent events written after the handler has returned.
  sse() {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    void (async () => {
      for (let i = 0; i < 30; i++) {
        await writer.write(encoder.encode(`id: ${i}\ndata: {"n":${i}}\n\n`));
        await sleep(i % 5 === 0 ? 10 : 0);
      }
      await writer.close();
    })();
    return new Response(readable, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },

  // One byte per chunk.
  tiny() {
    const text = "one byte at a time ✓";
    const data = encoder.encode(text);
    let i = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i === data.length) controller.close();
          else controller.enqueue(data.subarray(i, ++i));
        },
      }),
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },

  // A byte stream answering BYOB requests, used directly as the body.
  "byte-body"() {
    let offset = 0;
    const total = 256 * 1024;
    return new Response(
      new ReadableStream({
        type: "bytes",
        autoAllocateChunkSize: 8192,
        pull(controller) {
          const request = controller.byobRequest;
          if (request) {
            const view = request.view as Uint8Array;
            const length = Math.min(view.byteLength, total - offset);
            view.set(patternChunk(offset, length));
            offset += length;
            request.respond(length);
          } else {
            const length = Math.min(4096, total - offset);
            controller.enqueue(patternChunk(offset, length));
            offset += length;
          }
          if (offset === total) controller.close();
        },
      }),
      { headers: { "content-type": "application/octet-stream" } },
    );
  },

  // ReadableStream.from() over an async generator.
  generator() {
    async function* lines() {
      for (let i = 0; i < 1000; i++) {
        if (i % 100 === 0) await sleep(1);
        yield encoder.encode(`line ${i}\n`);
      }
    }
    const from = (ReadableStream as unknown as { from(i: unknown): ReadableStream }).from;
    return new Response(from(lines()), { headers: { "content-type": "text/plain" } });
  },

  // 1 MiB of text compressed on the fly; the client gunzips it.
  gzip() {
    const text = encoder.encode("compress me now ".repeat(1024));
    let sent = 0;
    const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        if (sent >= 1024 * 1024) return controller.close();
        controller.enqueue(text);
        sent += text.byteLength;
      },
    });
    return new Response(source.pipeThrough(new CompressionStream("gzip")), {
      headers: { "content-type": "application/octet-stream" },
    });
  },

  // 10 MiB in 64 KiB chunks.
  big() {
    let offset = 0;
    const total = 10 * MIB;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const length = Math.min(64 * 1024, total - offset);
          controller.enqueue(patternChunk(offset, length));
          offset += length;
          if (offset === total) controller.close();
        },
      }),
      { headers: { "content-type": "application/octet-stream" } },
    );
  },

  // FixedLengthStream lets the Worker send Content-Length with a streamed body.
  "fixed-length"() {
    const total = 3 * MIB;
    const { readable, writable } = new FixedLengthStream(total);
    void (async () => {
      const writer = writable.getWriter();
      for (let offset = 0; offset < total; offset += MIB) {
        await writer.write(patternChunk(offset, MIB));
      }
      await writer.close();
    })();
    return new Response(readable, { headers: { "content-type": "application/octet-stream" } });
  },

  // A native body piped through a JavaScript TransformStream.
  async "assets-proxy"(request) {
    const asset = await assetsFetch(request, "/vinext-image.png");
    const passthrough = new TransformStream<Uint8Array, Uint8Array>();
    void asset.body!.pipeTo(passthrough.writable);
    return new Response(passthrough.readable, { headers: { "content-type": "image/png" } });
  },

  // A native body returned untouched.
  async "assets-direct"(request) {
    const asset = await assetsFetch(request, "/vinext-image.png");
    return new Response(asset.body, { headers: { "content-type": "image/png" } });
  },

  // Node's Readable converted to a web stream.
  "node-readable"() {
    async function* parts() {
      for (let i = 0; i < 50; i++) yield Buffer.from(`node chunk ${i}\n`);
    }
    return new Response(Readable.toWeb(Readable.from(parts())) as ReadableStream, {
      headers: { "content-type": "text/plain" },
    });
  },

  // NextResponse with a stream body and cookies.
  nextresponse() {
    const response = new NextResponse(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode("next"));
          await sleep(5);
          controller.enqueue(encoder.encode("response"));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/plain" } },
    );
    response.cookies.set("streams-lab", "1");
    return response;
  },

  // A stream that never ends on its own; the client aborts it.
  cancel(request) {
    const token = request.nextUrl.searchParams.get("token") ?? "none";
    let i = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          await sleep(20);
          controller.enqueue(encoder.encode(`tick ${i++}\n`));
        },
        cancel(reason) {
          cancellations.set(token, reason instanceof Error ? reason.name : String(reason));
        },
      }),
      { headers: { "content-type": "text/plain" } },
    );
  },
  "cancel-status"(request) {
    const token = request.nextUrl.searchParams.get("token") ?? "none";
    return Response.json({ cancelled: cancellations.has(token) });
  },

  // A body that errors after it has started streaming.
  "error-mid"() {
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode("before the error\n"));
          await sleep(20);
          controller.error(new Error("upstream failed mid-stream"));
        },
      }),
      { headers: { "content-type": "text/plain" } },
    );
  },
};

const postHandlers: Record<string, Handler> = {
  impl: async (request) => Response.json(await detectStreamsImplementation(request)),

  // Streams the request body back, upper-cased, through decode/transform/encode.
  echo(request) {
    const upper = request
      .body!.pipeThrough(new TextDecoderStream())
      .pipeThrough(
        new TransformStream<string, string>({
          transform: (chunk, controller) => controller.enqueue(chunk.toUpperCase()),
        }),
      )
      .pipeThrough(new TextEncoderStream());
    return new Response(upper, { headers: { "content-type": "text/plain; charset=utf-8" } });
  },

  // Reads the request body through tee() and request.clone() at once.
  async "tee-request"(request) {
    const clone = request.clone();
    const [a, b] = request.body!.tee();
    const [first, second, cloned] = await Promise.all([
      sha256Hex(a),
      sha256Hex(b),
      clone.arrayBuffer().then((buffer) => buffer.byteLength),
    ]);
    return Response.json({ first, second, clonedBytes: cloned });
  },

  // A multipart upload read through file.stream().
  async formdata(request) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "no file" }, { status: 400 });
    return Response.json({
      name: file.name,
      size: file.size,
      field: form.get("field"),
      sha256: await sha256Hex(file.stream()),
    });
  },
};

function dispatch(handlers: Record<string, Handler>) {
  return async (request: NextRequest, { params }: { params: Promise<{ scenario: string }> }) => {
    const { scenario } = await params;
    const handler = handlers[scenario];
    if (!handler) return new Response(`unknown scenario ${scenario}`, { status: 404 });
    return handler(request);
  };
}

export const GET = dispatch(getHandlers);
export const POST = dispatch(postHandlers);
