// Stream patterns Next.js apps use in route handlers, run inside the Worker.
// "usage" checks use streams correctly and must pass on both implementations.
// "divergence" checks record behaviour the workerd divergence ledgers expect to
// differ between the C++ and TypeScript implementations.
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sha256Hex } from "./digest";
import { assetsFetch } from "./impl";

type Check = { kind: "usage" | "divergence"; run: (request: Request) => Promise<unknown> };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function bytes(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

function fromChunks<T>(chunks: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return decoder.decode(await readAll(stream));
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : `non-error: ${String(error)}`;
}

async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    const value = await promise;
    return `fulfilled: ${JSON.stringify(value)}`;
  } catch (error) {
    return `rejected: ${describeError(error)}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const checks: Record<string, Check> = {
  // --- Response bodies built the ways route handlers build them ---
  responseFromUint8Views: {
    kind: "usage",
    async run() {
      const backing = bytes("xxhello world!xx");
      const stream = fromChunks<ArrayBufferView>([
        backing.subarray(2, 7),
        new DataView(backing.buffer, 7, 1),
        new Uint8Array(backing.buffer, 8, 6),
      ]);
      const text = await new Response(stream as ReadableStream<Uint8Array>).text();
      assert(text === "hello world!", text);
      return text;
    },
  },
  responseClone: {
    kind: "usage",
    async run() {
      const response = new Response(fromChunks([bytes("a"), bytes("b")]));
      const copy = response.clone();
      const [first, second] = await Promise.all([response.text(), copy.text()]);
      assert(first === "ab" && second === "ab", `${first} ${second}`);
      return first;
    },
  },
  requestClone: {
    kind: "usage",
    async run() {
      const request = new Request("https://example.com/", {
        method: "POST",
        body: fromChunks([bytes("x".repeat(1000)), bytes("y".repeat(1000))]),
        // @ts-expect-error duplex is required for stream bodies but missing from older types.
        duplex: "half",
      });
      const copy = request.clone();
      const [first, second] = await Promise.all([request.text(), copy.text()]);
      assert(first.length === 2000 && first === second, `${first.length} ${second.length}`);
      return first.length;
    },
  },
  bodyUsedAfterRead: {
    kind: "usage",
    async run() {
      const response = new Response(fromChunks([bytes("once")]));
      await response.text();
      const again = await outcome(response.text());
      assert(response.bodyUsed && again.startsWith("rejected: TypeError"), again);
      return again;
    },
  },
  blobStreamRoundTrip: {
    kind: "usage",
    async run() {
      const blob = new Blob(["part-1|", bytes("part-2|"), new Blob(["part-3"])]);
      const text = await readText(blob.stream());
      assert(text === "part-1|part-2|part-3", text);
      const viaResponse = await new Response(blob.stream()).blob();
      assert(viaResponse.size === blob.size, String(viaResponse.size));
      return text;
    },
  },
  assetsBodyThroughTransform: {
    kind: "usage",
    async run(request) {
      const asset = await assetsFetch(request, "/vinext-image.png");
      assert(asset.ok && asset.body, `assets status ${asset.status}`);
      let chunks = 0;
      const counted = asset.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            chunks++;
            controller.enqueue(chunk);
          },
        }),
      );
      const body = await readAll(counted);
      const direct = new Uint8Array(await (await assetsFetch(request, "/vinext-image.png")).arrayBuffer());
      assert(body.byteLength === direct.byteLength && body.byteLength > 0, `${body.byteLength}`);
      assert(body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47, "png magic");
      return { bytes: body.byteLength, chunks };
    },
  },

  // --- tee / pipe / locks ---
  teeBothBranches: {
    kind: "usage",
    async run() {
      const [a, b] = fromChunks([bytes("one,"), bytes("two,"), bytes("three")]).tee();
      const [left, right] = await Promise.all([readText(a), readText(b)]);
      assert(left === "one,two,three" && right === left, `${left} | ${right}`);
      return left;
    },
  },
  teeSlowAndFastBranches: {
    kind: "usage",
    async run() {
      let i = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i === 200) controller.close();
          else controller.enqueue(bytes(`${i++},`));
        },
      });
      const [fast, slow] = source.tee();
      const fastText = await readText(fast);
      const reader = slow.getReader();
      let slowText = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        slowText += decoder.decode(value);
        await sleep(0);
      }
      assert(fastText === slowText && fastText.endsWith("199,"), "tee branches differ");
      return fastText.length;
    },
  },
  teeCancelBothReasons: {
    kind: "divergence",
    async run() {
      // readable ledger #11: C++ passes only the second reason, the TypeScript
      // implementation an AggregateError (the spec passes an array).
      let reason: unknown;
      const [a, b] = new ReadableStream({
        cancel(r) {
          reason = r;
        },
      }).tee();
      await Promise.all([a.cancel("left"), b.cancel("right")]);
      if (reason instanceof AggregateError) return `AggregateError ${JSON.stringify(reason.errors)}`;
      return `${Array.isArray(reason) ? "array" : typeof reason} ${JSON.stringify(reason)}`;
    },
  },
  pipeChainAndLocks: {
    kind: "usage",
    async run() {
      const source = fromChunks(["a", "b", "c"]);
      const upper = new TransformStream<string, string>({
        transform: (chunk, controller) => controller.enqueue(chunk.toUpperCase()),
      });
      const doubled = new TransformStream<string, string>({
        transform: (chunk, controller) => controller.enqueue(chunk + chunk),
      });
      const collected: string[] = [];
      const sink = new WritableStream<string>({ write: (chunk) => void collected.push(chunk) });
      const piped = source.pipeThrough(upper).pipeThrough(doubled).pipeTo(sink);
      assert(source.locked, "source locked during pipe");
      await piped;
      assert(collected.join("") === "AABBCC", collected.join(""));
      assert(!sink.locked, "sink released after pipe");
      return collected;
    },
  },
  pipeToPreventClose: {
    kind: "usage",
    async run() {
      const collected: string[] = [];
      const sink = new WritableStream<string>({ write: (chunk) => void collected.push(chunk) });
      await fromChunks(["a"]).pipeTo(sink, { preventClose: true });
      await fromChunks(["b"]).pipeTo(sink);
      assert(collected.join("") === "ab", collected.join(""));
      return collected;
    },
  },
  pipeToAbortSignal: {
    kind: "usage",
    async run() {
      let cancelled: unknown;
      const source = new ReadableStream({
        cancel(reason) {
          cancelled = reason;
        },
      });
      const controller = new AbortController();
      const piped = source.pipeTo(new WritableStream(), { signal: controller.signal });
      controller.abort(new Error("stop"));
      const result = await outcome(piped);
      assert(result === "rejected: Error: stop", result);
      assert(cancelled instanceof Error, "source cancelled with the abort reason");
      return result;
    },
  },
  digestStream: {
    kind: "usage",
    async run() {
      const value = await sha256Hex(fromChunks([bytes("hello "), bytes("world")]));
      assert(
        value === "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
        value,
      );
      return value;
    },
  },

  // --- iteration ---
  forAwaitEarlyBreakCancels: {
    kind: "usage",
    async run() {
      let cancelled = false;
      let i = 0;
      const stream = new ReadableStream<number>({
        pull: (controller) => controller.enqueue(i++),
        cancel() {
          cancelled = true;
        },
      });
      for await (const value of stream as unknown as AsyncIterable<number>) {
        if (value === 3) break;
      }
      assert(cancelled && !stream.locked, `cancelled=${cancelled} locked=${stream.locked}`);
      return i;
    },
  },
  valuesPreventCancel: {
    kind: "usage",
    async run() {
      const stream = fromChunks([1, 2, 3]);
      const iterator = (
        stream as unknown as { values(o: object): AsyncIterableIterator<number> }
      ).values({ preventCancel: true });
      for await (const value of iterator) if (value === 1) break;
      const rest: number[] = [];
      for await (const value of stream as unknown as AsyncIterable<number>) rest.push(value);
      assert(rest.join() === "2,3", rest.join());
      return rest;
    },
  },
  readableStreamFrom: {
    kind: "usage",
    async run() {
      const from = (ReadableStream as unknown as { from(i: unknown): ReadableStream }).from;
      async function* generate() {
        yield bytes("gen-");
        await sleep(1);
        yield bytes("erator");
      }
      const generated = await readText(from(generate()));
      const fromArray = await readText(from([bytes("ar"), bytes("ray")]));
      const strings: string[] = [];
      for await (const s of from(["x", "y"]) as unknown as AsyncIterable<string>) strings.push(s);
      assert(generated === "gen-erator" && fromArray === "array", `${generated} ${fromArray}`);
      assert(strings.join("") === "xy", strings.join(""));
      return { generated, fromArray, strings };
    },
  },

  // --- byte streams ---
  byteStreamByobOffsetView: {
    kind: "usage",
    async run() {
      const stream = new ReadableStream({
        type: "bytes",
        pull(controller) {
          const request = controller.byobRequest!;
          const view = request.view as Uint8Array;
          view.set(bytes("abc").subarray(0, Math.min(3, view.byteLength)));
          request.respond(Math.min(3, view.byteLength));
          controller.close();
        },
      });
      const reader = stream.getReader({ mode: "byob" });
      const buffer = new ArrayBuffer(16);
      const { value } = await reader.read(new Uint8Array(buffer, 4, 8));
      assert(value && value.byteOffset === 4 && decoder.decode(value) === "abc", "byob read");
      assert(buffer.byteLength === 0, "the original buffer is detached");
      return { byteOffset: value.byteOffset, byteLength: value.byteLength };
    },
  },
  byteStreamAutoAllocate: {
    kind: "usage",
    async run() {
      let pulls = 0;
      const stream = new ReadableStream({
        type: "bytes",
        autoAllocateChunkSize: 1024,
        pull(controller) {
          const request = controller.byobRequest!;
          const view = request.view as Uint8Array;
          view.fill(0x61, 0, 10);
          request.respond(10);
          if (++pulls === 5) controller.close();
        },
      });
      const text = await readText(stream as ReadableStream<Uint8Array>);
      assert(text === "a".repeat(50), `${text.length}`);
      return { pulls, length: text.length };
    },
  },
  byteStreamEnqueueDetaches: {
    kind: "usage",
    async run() {
      const chunk = bytes("detach me");
      const stream = new ReadableStream({
        type: "bytes",
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      });
      // enqueue() transfers the buffer: reusing it afterwards is a bug the spec catches.
      const detached = chunk.byteLength === 0;
      const text = await readText(stream as ReadableStream<Uint8Array>);
      assert(detached && text === "detach me", `detached=${detached} ${text}`);
      return { detached };
    },
  },

  // --- encoding and compression ---
  textEncoderStreamMultibyte: {
    kind: "usage",
    async run() {
      const text = "héllo 🌍 wörld ✓";
      const stream = fromChunks(["hé", "llo \ud83c", "\udf0d w", "örld ✓"]).pipeThrough(
        new TextEncoderStream(),
      );
      const encoded = await readText(stream);
      assert(encoded === text, encoded);
      return encoded;
    },
  },
  textDecoderStreamSplitBytes: {
    kind: "usage",
    async run() {
      const encoded = bytes("€😀✓");
      const chunks = [...encoded].map((b) => new Uint8Array([b]));
      const parts: string[] = [];
      await fromChunks(chunks)
        .pipeThrough(new TextDecoderStream())
        .pipeTo(new WritableStream({ write: (s) => void parts.push(s) }));
      assert(parts.join("") === "€😀✓", parts.join(""));
      return { parts: parts.length };
    },
  },
  compressionRoundTrip: {
    kind: "usage",
    async run() {
      const results: Record<string, number> = {};
      const input = bytes("streams ".repeat(20_000));
      for (const format of ["gzip", "deflate", "deflate-raw"] as const) {
        const compressed = await readAll(
          fromChunks([input.slice(0, 1000), input.slice(1000)]).pipeThrough(
            new CompressionStream(format),
          ),
        );
        const restored = await readAll(
          fromChunks([compressed]).pipeThrough(new DecompressionStream(format)),
        );
        assert(restored.byteLength === input.byteLength, `${format} ${restored.byteLength}`);
        results[format] = compressed.byteLength;
      }
      return results;
    },
  },
  decompressGarbageErrors: {
    kind: "usage",
    async run() {
      const result = await outcome(
        readAll(fromChunks([bytes("not gzip at all")]).pipeThrough(new DecompressionStream("gzip"))),
      );
      assert(result.startsWith("rejected:"), result);
      return result;
    },
  },

  // --- Workers stream classes ---
  fixedLengthStreamExact: {
    kind: "usage",
    async run() {
      const { readable, writable } = new FixedLengthStream(6);
      const writer = writable.getWriter();
      void writer.write(bytes("abc"));
      void writer.write(bytes("def"));
      void writer.close();
      const text = await readText(readable);
      assert(text === "abcdef", text);
      return text;
    },
  },
  identityTransformStream: {
    kind: "usage",
    async run() {
      const { readable, writable } = new IdentityTransformStream();
      const piped = fromChunks([bytes("id"), bytes("entity")]).pipeTo(writable);
      const [text] = await Promise.all([readText(readable), piped]);
      assert(text === "identity", text);
      return text;
    },
  },

  // --- backpressure and readers ---
  writerBackpressure: {
    kind: "usage",
    async run() {
      const written: number[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const stream = new WritableStream<number>(
        {
          async write(chunk) {
            await gate;
            written.push(chunk);
          },
        },
        new CountQueuingStrategy({ highWaterMark: 2 }),
      );
      const writer = stream.getWriter();
      await writer.ready;
      const writes = [1, 2, 3].map((n) => writer.write(n));
      const desiredWhileBlocked = writer.desiredSize;
      release();
      await Promise.all(writes);
      await writer.close();
      assert(desiredWhileBlocked === -1, `desiredSize ${desiredWhileBlocked}`);
      assert(written.join() === "1,2,3", written.join());
      return { desiredWhileBlocked };
    },
  },
  byteLengthStrategy: {
    kind: "usage",
    async run() {
      let desired: number | null = null;
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            controller.enqueue(new Uint8Array(10));
            controller.enqueue(new Uint8Array(20));
            desired = controller.desiredSize;
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: 64 }),
      );
      const reader = stream.getReader();
      const first = await reader.read();
      await reader.cancel();
      assert(first.value?.byteLength === 10 && desired === 34, `${first.value?.byteLength} ${desired}`);
      return { desired };
    },
  },
  concurrentReadsQueue: {
    kind: "usage",
    async run() {
      let controller!: ReadableStreamDefaultController<string>;
      const reader = new ReadableStream<string>({ start: (c) => void (controller = c) }).getReader();
      const reads = [reader.read(), reader.read(), reader.read()];
      controller.enqueue("a");
      controller.enqueue("b");
      controller.close();
      const results = await Promise.all(reads);
      assert(
        results[0].value === "a" && results[1].value === "b" && results[2].done,
        JSON.stringify(results),
      );
      return results;
    },
  },
  releaseLockWithPendingRead: {
    kind: "usage",
    async run() {
      const stream = new ReadableStream();
      const reader = stream.getReader();
      const pending = reader.read();
      reader.releaseLock();
      // Since 2022 the spec rejects pending reads instead of throwing from releaseLock().
      const result = await outcome(pending);
      assert(result.startsWith("rejected: TypeError") && !stream.locked, result);
      return result;
    },
  },
  controllerErrorMidStream: {
    kind: "usage",
    async run() {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes("partial"));
          controller.error(new Error("upstream failed"));
        },
      });
      const result = await outcome(readText(stream));
      assert(result === "rejected: Error: upstream failed", result);
      return result;
    },
  },
  writableAbortSignal: {
    kind: "usage",
    async run() {
      let signalReason: unknown;
      const stream = new WritableStream({
        start(controller) {
          controller.signal.addEventListener("abort", () => {
            signalReason = controller.signal.reason;
          });
        },
      });
      await stream.abort(new Error("client went away"));
      assert(signalReason instanceof Error, describeError(signalReason));
      return describeError(signalReason);
    },
  },
  lateWriterAfterReturn: {
    kind: "usage",
    async run() {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      setTimeout(async () => {
        for (let i = 0; i < 5; i++) {
          await writer.write(bytes(`tick ${i};`));
          await sleep(2);
        }
        await writer.close();
      }, 5);
      const text = await new Response(readable).text();
      assert(text === "tick 0;tick 1;tick 2;tick 3;tick 4;", text);
      return text;
    },
  },
  htmlRewriterOverJsStream: {
    kind: "usage",
    async run() {
      const source = new Response(
        fromChunks([bytes("<html><body><h1>ti"), bytes("tle</h1><p>body</p></body></html>")]),
        { headers: { "content-type": "text/html" } },
      );
      const rewritten = new HTMLRewriter()
        .on("h1", { element: (element) => void element.setAttribute("data-rewritten", "yes") })
        .transform(source);
      const html = await rewritten.text();
      assert(html.includes('<h1 data-rewritten="yes">title</h1>'), html);
      return html;
    },
  },

  // --- Node interop (nodejs_compat) ---
  nodeReadableFromWeb: {
    kind: "usage",
    async run() {
      const readable = Readable.fromWeb(
        fromChunks([bytes("node "), bytes("from "), bytes("web")]) as never,
      );
      let text = "";
      for await (const chunk of readable) text += decoder.decode(chunk as Uint8Array);
      assert(text === "node from web", text);
      return text;
    },
  },
  nodeReadableToWeb: {
    kind: "usage",
    async run() {
      const web = Readable.toWeb(Readable.from([bytes("to "), bytes("web")])) as ReadableStream<Uint8Array>;
      const text = await readText(web);
      assert(text === "to web", text);
      return text;
    },
  },
  nodePipelineFromWeb: {
    kind: "usage",
    async run() {
      let text = "";
      await pipeline(
        Readable.fromWeb(fromChunks([bytes("pipe"), bytes("line")]) as never),
        new Writable({
          write(chunk, _encoding, callback) {
            text += decoder.decode(chunk as Uint8Array);
            callback();
          },
        }),
      );
      assert(text === "pipeline", text);
      return text;
    },
  },
  nodeStreamWebIdentity: {
    kind: "usage",
    async run() {
      const web = (await import("node:stream/web")) as unknown as Record<string, unknown>;
      const same = ["ReadableStream", "WritableStream", "TransformStream"].map(
        (name) => web[name] === (globalThis as unknown as Record<string, unknown>)[name],
      );
      assert(same.every(Boolean), JSON.stringify(same));
      return same;
    },
  },

  // --- known divergences: incorrect usage that the spec-compliant implementation catches ---
  stringChunkInResponseBody: {
    kind: "divergence",
    async run() {
      // A common mistake: enqueueing strings into a Response body.
      return outcome(new Response(fromChunks(["not", "bytes"]) as never).text());
    },
  },
  stringChunkIntoCompressionStream: {
    kind: "divergence",
    async run() {
      // compression ledger #1: C++ UTF-8 encodes strings, the spec rejects them.
      return outcome(readAll(fromChunks(["text"] as never[]).pipeThrough(new CompressionStream("gzip"))));
    },
  },
  syncStartThrow: {
    kind: "divergence",
    async run() {
      // readable/writable/transform ledgers: C++ captures it, the spec rethrows from the constructor.
      try {
        const stream = new ReadableStream({
          start() {
            throw new Error("start failed");
          },
        });
        return `constructed; read ${await outcome(stream.getReader().read())}`;
      } catch (error) {
        return `constructor threw ${describeError(error)}`;
      }
    },
  },
  transformInfinityHighWaterMark: {
    kind: "divergence",
    async run() {
      // transform ledger #9: C++ rejects Infinity, the spec accepts it.
      try {
        new TransformStream({}, undefined, { highWaterMark: Infinity });
        return "accepted";
      } catch (error) {
        return `threw ${describeError(error)}`;
      }
    },
  },
  invalidHighWaterMark: {
    kind: "divergence",
    async run() {
      try {
        new WritableStream({}, { highWaterMark: -1 });
        return "accepted";
      } catch (error) {
        return `threw ${describeError(error)}`;
      }
    },
  },
  fixedLengthOverflow: {
    kind: "divergence",
    async run() {
      const { readable, writable } = new FixedLengthStream(3);
      const writer = writable.getWriter();
      const reading = readAll(readable).catch((error) => error);
      const write = await outcome(writer.write(bytes("too long")));
      void reading;
      return write;
    },
  },
  secondConcurrentCompressionRead: {
    kind: "divergence",
    async run() {
      // compression ledger #14: C++ allows a single pending read.
      const { readable } = new CompressionStream("gzip");
      const reader = readable.getReader();
      void reader.read().catch(() => {});
      const second = reader.read();
      const result = await Promise.race([outcome(second), sleep(50).then(() => "pending")]);
      void reader.cancel().catch(() => {});
      return result;
    },
  },
};

export async function runChecks(request: Request, only?: string | null) {
  const results: Record<string, { kind: string; ok: boolean; value?: unknown; error?: string }> =
    {};
  for (const [name, check] of Object.entries(checks)) {
    if (only && name !== only) continue;
    try {
      const value = await Promise.race([
        check.run(request),
        sleep(5000).then(() => {
          throw new Error("timed out after 5s");
        }),
      ]);
      results[name] = { kind: check.kind, ok: true, value };
    } catch (error) {
      results[name] = { kind: check.kind, ok: false, error: describeError(error) };
    }
  }
  return results;
}
