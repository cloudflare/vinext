import { describe, expect, it } from "vite-plus/test";
import {
  createClientReferencePreloader,
  loadClientReferencesAheadOfReact,
} from "../packages/vinext/src/server/app-client-reference-preloader.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function readChunks(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const chunks: string[] = [];
  const reader = stream.getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) return chunks;
    chunks.push(decoder.decode(result.value));
  }
}

function flightTextRow(id: number, text: string): string {
  return `${id.toString(16)}:T${encoder.encode(text).byteLength.toString(16)},${text}`;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveDeferred: () => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = () => resolve();
  });
  return { promise, resolve: resolveDeferred };
}

describe("app client reference preloader", () => {
  it("shares one in-flight preload across concurrent cold SSR calls", async () => {
    const refs = { "comp-a": true, "comp-b": true, "comp-c": true };
    const calls: string[] = [];
    const preloadGate = createDeferred();

    const preloader = createClientReferencePreloader({
      getReferences: () => refs,
      getClientRequire: () => async (id) => {
        calls.push(id);
        await preloadGate.promise;
      },
    });

    const first = preloader.preload();
    const second = preloader.preload();
    const third = preloader.preload();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(calls).toEqual(["comp-a", "comp-b", "comp-c"]);

    preloadGate.resolve();
    await Promise.all([first, second, third]);

    await preloader.preload();
    expect(calls).toEqual(["comp-a", "comp-b", "comp-c"]);
  });

  it("does not mark preload complete when references or client require are unavailable", async () => {
    const refs = { "comp-a": true };
    let currentRefs: Record<string, unknown> | undefined;
    let currentRequire: ((id: string) => Promise<unknown>) | undefined;
    const calls: string[] = [];

    const preloader = createClientReferencePreloader({
      getReferences: () => currentRefs,
      getClientRequire: () => currentRequire,
    });

    await preloader.preload();

    currentRefs = refs;
    await preloader.preload();

    currentRequire = async (id) => {
      calls.push(id);
    };
    await preloader.preload();

    expect(calls).toEqual(["comp-a"]);
  });

  it("dedupes overlapping scoped preload requests per reference id", async () => {
    const calls: string[] = [];
    const preloadGate = createDeferred();
    const preloader = createClientReferencePreloader({
      getReferences: () => ({ "comp-a": true, "comp-b": true, "comp-c": true }),
      getClientRequire: () => async (id) => {
        calls.push(id);
        await preloadGate.promise;
      },
    });

    const firstRoute = preloader.preload(["comp-a", "comp-b"]);
    const secondRoute = preloader.preload(["comp-b", "comp-c"]);

    expect(calls).toEqual(["comp-a", "comp-b", "comp-c"]);

    preloadGate.resolve();
    await Promise.all([firstRoute, secondRoute]);

    await preloader.preload(["comp-b"]);
    expect(calls).toEqual(["comp-a", "comp-b", "comp-c"]);
  });

  it("reports individual preload failures and completes the manifest pass", async () => {
    const reported: Array<{ id: string; error: unknown }> = [];
    const calls: string[] = [];
    const preloader = createClientReferencePreloader({
      getReferences: () => ({ "comp-a": true, "comp-b": true }),
      getClientRequire: () => async (id) => {
        calls.push(id);
        if (id === "comp-a") {
          throw new Error("load failed");
        }
      },
      onPreloadError: (id, error) => reported.push({ id, error }),
    });

    await preloader.preload();
    await preloader.preload();

    expect(calls).toEqual(["comp-a", "comp-b"]);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.id).toBe("comp-a");
    expect(reported[0]?.error).toBeInstanceOf(Error);
  });
});

describe("loadClientReferencesAheadOfReact", () => {
  const preloadChunksReferenceId = "preload-chunks";

  it("starts loading the client references a chunk names and forwards it at once", async () => {
    const chunk = '1:I["ref-a",[],"default",1]\n0:["$L1"]\n';
    const loadGate = createDeferred();
    const calls: string[][] = [];
    const reader = loadClientReferencesAheadOfReact(
      streamFromChunks([chunk]),
      async (ids) => {
        calls.push([...ids]);
        await loadGate.promise;
      },
      preloadChunksReferenceId,
    ).getReader();

    expect(decoder.decode((await reader.read()).value)).toBe(chunk);
    expect(calls).toEqual([["ref-a"]]);
    loadGate.resolve();
  });

  it("holds a chunk naming the DynamicPreloadChunks reference until it has loaded", async () => {
    const chunk =
      '1:I["preload-chunks",[],"DynamicPreloadChunks",1]\n2:I["ref-a",[],"default",1]\n0:["$L1"]\n';
    const loadGate = createDeferred();
    const calls: string[][] = [];
    const reader = loadClientReferencesAheadOfReact(
      streamFromChunks([chunk]),
      async (ids) => {
        calls.push([...ids]);
        if (ids.includes("preload-chunks")) await loadGate.promise;
      },
      preloadChunksReferenceId,
    ).getReader();

    let forwarded = false;
    const read = reader.read().then((result) => {
      forwarded = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([["ref-a"], ["preload-chunks"]]);
    expect(forwarded).toBe(false);

    loadGate.resolve();
    expect(decoder.decode((await read).value)).toBe(chunk);
  });

  it("does not hold a chunk for another reference exported as DynamicPreloadChunks", async () => {
    const chunk = '1:I["user-ref",[],"DynamicPreloadChunks",1]\n0:["$L1"]\n';
    const loadGate = createDeferred();
    const calls: string[][] = [];
    const reader = loadClientReferencesAheadOfReact(
      streamFromChunks([chunk]),
      async (ids) => {
        calls.push([...ids]);
        await loadGate.promise;
      },
      preloadChunksReferenceId,
    ).getReader();

    expect(decoder.decode((await reader.read()).value)).toBe(chunk);
    expect(calls).toEqual([["user-ref"]]);
    loadGate.resolve();
  });

  it("reads an import row split across chunks and skips rows inside length-prefixed bodies", async () => {
    const chunks = [
      `${flightTextRow(2, 'text with\n3:I["not-a-reference",[],"default",1]\n inside')}4:I["ref-b",[],"def`,
      'ault",1]\n5:{"a":1}\n',
      '6:["$L4"]\n',
    ];
    const calls: string[][] = [];
    const forwarded = await readChunks(
      loadClientReferencesAheadOfReact(
        streamFromChunks(chunks),
        async (ids) => {
          calls.push([...ids]);
        },
        preloadChunksReferenceId,
      ),
    );

    expect(calls).toEqual([["ref-b"]]);
    expect(forwarded).toEqual(chunks);
  });

  it("stops reading rows at a tag it does not know and forwards the rest untouched", async () => {
    const chunks = ['7:Z1,x1:I["ref-c",[],"default",1]\n', '8:I["ref-d",[],"default",1]\n'];
    const calls: string[][] = [];
    const forwarded = await readChunks(
      loadClientReferencesAheadOfReact(
        streamFromChunks(chunks),
        async (ids) => {
          calls.push([...ids]);
        },
        preloadChunksReferenceId,
      ),
    );

    expect(calls).toEqual([]);
    expect(forwarded).toEqual(chunks);
  });
});
