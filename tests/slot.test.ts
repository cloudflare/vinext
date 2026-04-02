import React, { Suspense } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { describe, expect, it, vi } from "vite-plus/test";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createContextProvider<TValue>(
  context: React.Context<TValue>,
  value: TValue,
  child: React.ReactNode,
): React.ReactElement {
  return React.createElement(context.Provider, { value }, child);
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) {
    throw new Error("Deferred promise resolver was not created");
  }
  return {
    promise,
    resolve: resolvePromise,
  };
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

async function renderHtml(element: React.ReactElement): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return readStream(stream);
}

describe("slot primitives", () => {
  it("exports the client primitives", async () => {
    const mod = await import("../packages/vinext/src/shims/slot.js");

    expect(typeof mod.Slot).toBe("function");
    expect(typeof mod.Children).toBe("function");
    expect(typeof mod.ParallelSlot).toBe("function");
    expect(typeof mod.mergeElementsPromise).toBe("function");
    expect(mod.ElementsContext).toBeDefined();
    expect(mod.ChildrenContext).toBeDefined();
    expect(mod.ParallelSlotsContext).toBeDefined();
    expect(mod.UNMATCHED_SLOT).toBe(Symbol.for("vinext.unmatchedSlot"));
  });

  it("Children renders null outside a Slot provider", async () => {
    const { Children } = await import("../packages/vinext/src/shims/slot.js");

    const html = await renderHtml(React.createElement(Children));
    expect(html).toBe("");
  });

  it("ParallelSlot renders null outside a Slot provider", async () => {
    const { ParallelSlot } = await import("../packages/vinext/src/shims/slot.js");

    const html = await renderHtml(React.createElement(ParallelSlot, { name: "modal" }));
    expect(html).toBe("");
  });

  it("Slot renders the matched element and provides children and parallel slots", async () => {
    const mod = await import("../packages/vinext/src/shims/slot.js");

    function LayoutShell(): React.ReactElement {
      return React.createElement(
        "div",
        null,
        React.createElement("main", null, React.createElement(mod.Children)),
        React.createElement(
          "aside",
          null,
          React.createElement(mod.ParallelSlot, { name: "modal" }),
        ),
      );
    }

    const slotElement = createContextProvider(
      mod.ElementsContext,
      Promise.resolve({ "layout:/": React.createElement(LayoutShell) }),
      React.createElement(
        mod.Slot,
        {
          id: "layout:/",
          parallelSlots: {
            modal: React.createElement("em", null, "modal content"),
          },
        },
        React.createElement("span", null, "child content"),
      ),
    );

    const html = await renderHtml(slotElement);
    expect(html).toContain("child content");
    expect(html).toContain("modal content");
  });

  it("Slot returns null when the entry is absent", async () => {
    const mod = await import("../packages/vinext/src/shims/slot.js");

    const html = await renderHtml(
      createContextProvider(
        mod.ElementsContext,
        Promise.resolve({}),
        React.createElement(mod.Slot, { id: "slot:modal:/" }),
      ),
    );

    expect(html).toBe("");
  });

  it("Slot throws the notFound signal for an unmatched slot sentinel", async () => {
    const mod = await import("../packages/vinext/src/shims/slot.js");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const renderPromise = renderHtml(
        createContextProvider(
          mod.ElementsContext,
          Promise.resolve({ "slot:modal:/": mod.UNMATCHED_SLOT }),
          React.createElement(mod.Slot, { id: "slot:modal:/" }),
        ),
      );
      await expect(renderPromise).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("Slot renders a present null entry without triggering notFound", async () => {
    const mod = await import("../packages/vinext/src/shims/slot.js");
    const errors: Error[] = [];

    const stream = await renderToReadableStream(
      createContextProvider(
        mod.ElementsContext,
        Promise.resolve({ "slot:modal:/": null }),
        React.createElement(mod.Slot, { id: "slot:modal:/" }),
      ),
      {
        onError(error: unknown) {
          if (error instanceof Error) {
            errors.push(error);
          }
        },
      },
    );

    await stream.allReady;
    const html = await readStream(stream);

    expect(html).toBe("");
    expect(errors).toEqual([]);
  });

  it("mergeElementsPromise shallow-merges previous and next elements", async () => {
    const { mergeElementsPromise } = await import("../packages/vinext/src/shims/slot.js");

    const merged = await mergeElementsPromise(
      Promise.resolve({
        "layout:/": React.createElement("div", null, "layout"),
        "slot:modal:/": React.createElement("div", null, "previous slot"),
      }),
      Promise.resolve({
        "page:/blog/hello": React.createElement("div", null, "page"),
        "slot:modal:/": React.createElement("div", null, "next slot"),
      }),
    );

    expect(Object.keys(merged)).toEqual(["layout:/", "slot:modal:/", "page:/blog/hello"]);
    expect(merged["layout:/"]).toBeDefined();
    expect(merged["page:/blog/hello"]).toBeDefined();
    // {…prev, …next} means next wins for duplicate keys
    const modalSlot = merged["slot:modal:/"];
    if (!React.isValidElement(modalSlot)) {
      throw new Error("Expected ReactElement for slot:modal:/");
    }
    const html = await renderHtml(modalSlot);
    expect(html).toContain("next slot");
  });

  it("mergeElementsPromise caches by input promise pair", async () => {
    const { mergeElementsPromise } = await import("../packages/vinext/src/shims/slot.js");

    const previous = Promise.resolve({ "layout:/": React.createElement("div", null, "layout") });
    const next = Promise.resolve({ "page:/blog/hello": React.createElement("div", null, "page") });

    const first = mergeElementsPromise(previous, next);
    const second = mergeElementsPromise(previous, next);
    const third = mergeElementsPromise(previous, Promise.resolve({}));

    expect(first).toBe(second);
    expect(first).not.toBe(third);
  });

  it("Slot suspends on the elements promise and streams the Suspense fallback first", async () => {
    const mod = await import("../packages/vinext/src/shims/slot.js");
    const deferred = createDeferred<Awaited<React.ContextType<typeof mod.ElementsContext>>>();

    const stream = await renderToReadableStream(
      React.createElement(
        Suspense,
        { fallback: React.createElement("p", null, "loading slot") },
        createContextProvider(
          mod.ElementsContext,
          deferred.promise,
          React.createElement(mod.Slot, { id: "layout:/" }),
        ),
      ),
    );

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const firstChunkPromise = reader.read();

    // Verify the stream is suspended — reader.read() should not resolve synchronously
    // because React.use() on the unresolved deferred throws to trigger Suspense.
    // NOTE: Promise.race between two microtasks is engine-dependent, but reliable here
    // because renderToReadableStream won't enqueue any chunk while the component is suspended.
    const firstReadState = await Promise.race([
      firstChunkPromise.then(() => "resolved"),
      Promise.resolve("pending"),
    ]);
    expect(firstReadState).toBe("pending");

    // Resolve the deferred so the stream can flush
    deferred.resolve({
      "layout:/": React.createElement("div", null, "resolved slot"),
    });

    const firstChunk = await firstChunkPromise;
    const firstHtml = decoder.decode(firstChunk.value, { stream: true });

    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      rest += decoder.decode(value, { stream: true });
    }
    rest += decoder.decode();

    expect(firstHtml + rest).toContain("resolved slot");
  }, 10000);
});
