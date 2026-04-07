import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { describe, expect, it, vi } from "vite-plus/test";
import { UNMATCHED_SLOT } from "../packages/vinext/src/server/app-elements.js";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

function createContextProvider<TValue>(
  context: React.Context<TValue>,
  value: TValue,
  child: React.ReactNode,
): React.ReactElement {
  return React.createElement(context.Provider, { value }, child);
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
    expect(typeof mod.mergeElements).toBe("function");
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
      { "layout:/": React.createElement(LayoutShell) },
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
        {},
        React.createElement(mod.Slot, { id: "slot:modal:/" }),
      ),
    );

    expect(html).toBe("");
  });

  it("warns in development when a non-slot entry is absent", async () => {
    const mod = await import("../packages/vinext/src/shims/slot.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const html = await renderHtml(
        createContextProvider(
          mod.ElementsContext,
          {},
          React.createElement(mod.Slot, { id: "route:/missing" }),
        ),
      );

      expect(html).toBe("");
      expect(warn).toHaveBeenCalledWith(
        "[vinext] Missing App Router element entry during render: route:/missing",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn when an absent parallel slot key is omitted on soft navigation", async () => {
    const mod = await import("../packages/vinext/src/shims/slot.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const html = await renderHtml(
        createContextProvider(
          mod.ElementsContext,
          {},
          React.createElement(mod.Slot, { id: "slot:modal:/" }),
        ),
      );

      expect(html).toBe("");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("Slot throws the notFound signal for an unmatched slot sentinel", async () => {
    const mod = await import("../packages/vinext/src/shims/slot.js");
    const renderPromise = renderHtml(
      createContextProvider(
        mod.ElementsContext,
        { "slot:modal:/": mod.UNMATCHED_SLOT },
        React.createElement(mod.Slot, { id: "slot:modal:/" }),
      ),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
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
        { "slot:modal:/": null },
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

  it("normalizes the server unmatched-slot marker to the client sentinel", async () => {
    const { normalizeAppElements, APP_UNMATCHED_SLOT_WIRE_VALUE } =
      await import("../packages/vinext/src/server/app-elements.js");
    const mod = await import("../packages/vinext/src/shims/slot.js");

    const normalized = normalizeAppElements({
      __rootLayout: "/",
      __route: "route:/dashboard",
      "slot:modal:/": APP_UNMATCHED_SLOT_WIRE_VALUE,
    });

    expect(normalized["slot:modal:/"]).toBe(mod.UNMATCHED_SLOT);
  });

  it("mergeElements shallow-merges previous and next elements", async () => {
    const { mergeElements } = await import("../packages/vinext/src/shims/slot.js");

    const merged = mergeElements(
      {
        "layout:/": React.createElement("div", null, "layout"),
        "slot:modal:/": React.createElement("div", null, "previous slot"),
      },
      {
        "page:/blog/hello": React.createElement("div", null, "page"),
        "slot:modal:/": React.createElement("div", null, "next slot"),
      },
    );

    expect(Object.keys(merged)).toEqual(["layout:/", "slot:modal:/", "page:/blog/hello"]);
    expect(merged["layout:/"]).toBeDefined();
    expect(merged["page:/blog/hello"]).toBeDefined();
    expect(merged["slot:modal:/"]).not.toBeNull();
  });

  it("mergeElements preserves previous slot content when next marks it unmatched", async () => {
    const { mergeElements } = await import("../packages/vinext/src/shims/slot.js");

    const previousSlotContent = React.createElement("div", null, "previous modal");
    const merged = mergeElements(
      {
        "layout:/": React.createElement("div", null, "layout"),
        "slot:modal:/": previousSlotContent,
        "page:/dashboard": React.createElement("div", null, "dashboard"),
      },
      {
        "page:/blog": React.createElement("div", null, "blog page"),
        "slot:modal:/": UNMATCHED_SLOT,
      },
    );

    // The slot should keep its previous content, not become UNMATCHED_SLOT.
    // This matches Next.js soft navigation behavior: unmatched parallel slots
    // preserve their previous subtree instead of showing 404.
    expect(merged["slot:modal:/"]).toBe(previousSlotContent);
    expect(merged["page:/blog"]).toBeDefined();
    expect(merged["layout:/"]).toBeDefined();
  });

  it("mergeElements allows UNMATCHED_SLOT for slots absent from previous state", async () => {
    const { mergeElements } = await import("../packages/vinext/src/shims/slot.js");

    const merged = mergeElements(
      {
        "layout:/": React.createElement("div", null, "layout"),
        "page:/": React.createElement("div", null, "home"),
      },
      {
        "page:/blog": React.createElement("div", null, "blog"),
        "slot:modal:/": UNMATCHED_SLOT,
      },
    );

    // No previous value to preserve — the sentinel passes through.
    expect(merged["slot:modal:/"]).toBe(UNMATCHED_SLOT);
  });

  it("Slot renders element from resolved context", async () => {
    const mod = await import("../packages/vinext/src/shims/slot.js");

    const stream = await renderToReadableStream(
      createContextProvider(
        mod.ElementsContext,
        { "layout:/": React.createElement("div", null, "resolved slot") },
        React.createElement(mod.Slot, { id: "layout:/" }),
      ),
    );

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let html = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    html += decoder.decode();

    expect(html).toContain("resolved slot");
  });
});
