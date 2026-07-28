import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  APP_BFCACHE_SEGMENT_IDENTITIES_KEY,
  UNMATCHED_SLOT,
} from "../packages/vinext/src/server/app-elements.js";

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
    expect(typeof mod.getNonCacheComponentsSegmentKey).toBe("function");
    expect(typeof mod.resolveBfcacheSegmentStateKey).toBe("function");
    expect(typeof mod.BfcacheSegmentBoundary).toBe("function");
    expect(mod.ElementsContext).toBeDefined();
    expect(mod.ChildrenContext).toBeDefined();
    expect(mod.ParallelSlotsContext).toBeDefined();
    expect(mod.UNMATCHED_SLOT).toBe(Symbol.for("vinext.unmatchedSlot"));
  });

  it("keys active segment carriers without remounting named-slot owner shells", async () => {
    const { getNonCacheComponentsSegmentKey } =
      await import("../packages/vinext/src/shims/slot.js");

    expect(getNonCacheComponentsSegmentKey("page:/0", "page:/0@/0")).toBe("page:/0@/0");
    expect(getNonCacheComponentsSegmentKey("slot:children:/", "slot:children:/@route:/0")).toBe(
      "slot:children:/@route:/0",
    );
    expect(getNonCacheComponentsSegmentKey("layout:/", "layout:/@/0")).toBe("layout:/@/0");
    expect(getNonCacheComponentsSegmentKey("slot:breadcrumbs:/", "slot:breadcrumbs:/@/0")).toBe(
      "slot:breadcrumbs:/@/0",
    );
  });

  it("falls back to freshly minted BFCache ids when identity proof is unavailable", async () => {
    const { resolveBfcacheSegmentStateKey } = await import("../packages/vinext/src/shims/slot.js");
    const id = "page:/dashboard";

    expect(resolveBfcacheSegmentStateKey(id, { [id]: "graph-proof" }, { [id]: "_b_1_" })).toBe(
      "graph-proof",
    );
    expect(resolveBfcacheSegmentStateKey(id, {}, { [id]: "_b_1_" })).toBe("_b_1_");
    expect(resolveBfcacheSegmentStateKey(id, {}, { [id]: "_b_2_" })).toBe("_b_2_");
    expect(resolveBfcacheSegmentStateKey(id, {}, null)).toBeUndefined();
  });

  it("keeps nested BFCache segment ownership unambiguous across parent prefixes", async () => {
    const { createNestedBfcacheSlotSegmentId, isNestedBfcacheSlotSegmentIdFor } =
      await import("../packages/vinext/src/server/bfcache-identity.js");
    const shortParent = "slot:foo:/";
    const extendedParent = "slot:foo:/_bar";
    const nestedId = createNestedBfcacheSlotSegmentId(extendedParent, 1);
    const collidingUserSlotId = "slot:__vinext_bfcache_segment_slot%3Afoo%3A%2F_bar_1:/";

    expect(isNestedBfcacheSlotSegmentIdFor(nestedId, extendedParent)).toBe(true);
    expect(isNestedBfcacheSlotSegmentIdFor(nestedId, shortParent)).toBe(false);
    expect(nestedId).not.toBe(collidingUserSlotId);
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

  it("Slot does not treat empty objects as transport metadata", async () => {
    const mod = await import("../packages/vinext/src/shims/slot.js");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        renderHtml(
          createContextProvider(
            mod.ElementsContext,
            { "slot:modal:/": {} },
            React.createElement(mod.Slot, { id: "slot:modal:/" }),
          ),
        ),
      ).rejects.toThrow(/Objects are not valid|object/i);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("warns in development when transport metadata appears under a render entry", async () => {
    const mod = await import("../packages/vinext/src/shims/slot.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const html = await renderHtml(
        createContextProvider(
          mod.ElementsContext,
          { "slot:metadata-warning:/": { "layout:/": "s" } },
          React.createElement(mod.Slot, { id: "slot:metadata-warning:/" }),
        ),
      );

      expect(html).toBe("");
      expect(warn).toHaveBeenCalledWith(
        "[vinext] Transport metadata value found under App Router render entry: slot:metadata-warning:/",
      );
    } finally {
      warn.mockRestore();
    }
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

  it("mergeElements preserves approved non-slot elements", async () => {
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
      { preserveElementIds: ["layout:/"] },
    );

    expect(Object.keys(merged).sort()).toEqual(["layout:/", "page:/blog/hello", "slot:modal:/"]);
    expect(merged["layout:/"]).toBeDefined();
    expect(merged["page:/blog/hello"]).toBeDefined();
    expect(merged["slot:modal:/"]).not.toBeNull();
  });

  it("mergeElements keeps the previous approved layout when the next payload rerenders it", async () => {
    const { mergeElements } = await import("../packages/vinext/src/shims/slot.js");
    const previousLayout = React.createElement("div", null, "previous layout");
    const nextLayout = React.createElement("div", null, "next layout");

    const merged = mergeElements(
      { "layout:/dashboard": previousLayout },
      {
        "layout:/dashboard": nextLayout,
        "page:/dashboard/settings": React.createElement("div", null, "settings"),
      },
      { preserveElementIds: ["layout:/dashboard"] },
    );

    expect(merged["layout:/dashboard"]).toBe(previousLayout);
  });

  it("mergeElements drops absent non-slot elements without approved persistence", async () => {
    const { mergeElements } = await import("../packages/vinext/src/shims/slot.js");

    const merged = mergeElements(
      {
        "layout:/": React.createElement("div", null, "layout"),
        "page:/dashboard": React.createElement("div", null, "dashboard"),
      },
      {
        "page:/settings": React.createElement("div", null, "settings"),
      },
    );

    expect(Object.hasOwn(merged, "layout:/")).toBe(false);
    expect(Object.hasOwn(merged, "page:/dashboard")).toBe(false);
    expect(Object.hasOwn(merged, "page:/settings")).toBe(true);
  });

  it("mergeElements does not infer unmatched slot preservation from the wire marker", async () => {
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
      { preserveElementIds: ["layout:/"] },
    );

    expect(merged["slot:modal:/"]).toBe(UNMATCHED_SLOT);
    expect(merged["page:/blog"]).toBeDefined();
    expect(merged["layout:/"]).toBeDefined();
  });

  it("mergeElements preserves previous slot content for planner-approved default/unmatched slots", async () => {
    const { mergeElements } = await import("../packages/vinext/src/shims/slot.js");

    const previousSlotContent = React.createElement("div", null, "previous modal");
    const defaultSlotContent = React.createElement("div", null, "default modal");
    const mergedFromUnmatched = mergeElements(
      {
        "layout:/": React.createElement("div", null, "layout"),
        "slot:modal:/": previousSlotContent,
      },
      {
        "page:/blog": React.createElement("div", null, "blog page"),
        "slot:modal:/": UNMATCHED_SLOT,
      },
      { preserveElementIds: ["layout:/"], preservePreviousSlotIds: ["slot:modal:/"] },
    );
    const mergedFromDefault = mergeElements(
      {
        "layout:/": React.createElement("div", null, "layout"),
        "slot:modal:/": previousSlotContent,
      },
      {
        "page:/blog": React.createElement("div", null, "blog page"),
        "slot:modal:/": defaultSlotContent,
      },
      { preserveElementIds: ["layout:/"], preservePreviousSlotIds: ["slot:modal:/"] },
    );

    expect(mergedFromUnmatched["slot:modal:/"]).toBe(previousSlotContent);
    expect(mergedFromDefault["slot:modal:/"]).toBe(previousSlotContent);
  });

  it("mergeElements preserves identity with planner-approved previous slot content", async () => {
    const { mergeElements } = await import("../packages/vinext/src/shims/slot.js");
    const { createNestedBfcacheSlotSegmentId } =
      await import("../packages/vinext/src/server/bfcache-identity.js");
    const slotId = "slot:modal:/";
    const nestedId = createNestedBfcacheSlotSegmentId(slotId, 1);
    const destinationOnlyNestedId = createNestedBfcacheSlotSegmentId(slotId, 2);
    const previousSlotContent = React.createElement("div", null, "previous modal");
    const merged = mergeElements(
      {
        [slotId]: previousSlotContent,
        [APP_BFCACHE_SEGMENT_IDENTITIES_KEY]: {
          [slotId]: "previous-modal-identity",
          [nestedId]: "previous-nested-identity",
        },
      },
      {
        "page:/blog": React.createElement("div", null, "blog page"),
        [slotId]: UNMATCHED_SLOT,
        [APP_BFCACHE_SEGMENT_IDENTITIES_KEY]: {
          "page:/blog": "blog-page-identity",
          [slotId]: "destination-default-identity",
          [nestedId]: "destination-nested-identity",
          [destinationOnlyNestedId]: "destination-only-nested-identity",
        },
      },
      { preservePreviousSlotIds: [slotId] },
    );

    expect(merged[slotId]).toBe(previousSlotContent);
    expect(merged[APP_BFCACHE_SEGMENT_IDENTITIES_KEY]).toEqual({
      "page:/blog": "blog-page-identity",
      [slotId]: "previous-modal-identity",
      [nestedId]: "previous-nested-identity",
    });
  });

  it("preserves proof-independent nested membership and remints its id", async () => {
    const { mergeElements } = await import("../packages/vinext/src/shims/slot.js");
    const { preserveBfcacheIdsForMergedElements } =
      await import("../packages/vinext/src/server/app-bfcache-identity.js");
    const { createNestedBfcacheSlotSegmentId } =
      await import("../packages/vinext/src/server/bfcache-identity.js");
    const slotId = "slot:modal:/";
    const nestedId = createNestedBfcacheSlotSegmentId(slotId, 1);
    const previousSlotContent = React.createElement("div", null, "previous modal");
    const merged = mergeElements(
      {
        [slotId]: previousSlotContent,
        [nestedId]: null,
      },
      {
        "page:/blog": React.createElement("div", null, "blog page"),
        [slotId]: UNMATCHED_SLOT,
      },
      { preservePreviousSlotIds: [slotId] },
    );

    expect(merged[slotId]).toBe(previousSlotContent);
    expect(merged).toHaveProperty(nestedId, null);

    const ids = preserveBfcacheIdsForMergedElements({
      elements: merged,
      next: {},
      previous: { [slotId]: "_b_4_", [nestedId]: "_b_5_" },
      preservedElementIds: [slotId],
    });
    expect(ids[slotId]).toMatch(/^_b_\d+_$/);
    expect(ids[slotId]).not.toBe("_b_4_");
    expect(ids[nestedId]).toMatch(/^_b_\d+_$/);
    expect(ids[nestedId]).not.toBe("_b_5_");
  });

  it("mergeElements preserves a present null default slot when the planner approves it", async () => {
    const { mergeElements } = await import("../packages/vinext/src/shims/slot.js");

    const merged = mergeElements(
      {
        "layout:/": React.createElement("div", null, "layout"),
        "slot:modal:/": null,
      },
      {
        "page:/blog": React.createElement("div", null, "blog page"),
        "slot:modal:/": UNMATCHED_SLOT,
      },
      { preserveElementIds: ["layout:/"], preservePreviousSlotIds: ["slot:modal:/"] },
    );

    expect(Object.hasOwn(merged, "slot:modal:/")).toBe(true);
    expect(merged["slot:modal:/"]).toBeNull();
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
      { preserveElementIds: ["layout:/"] },
    );

    // No previous value to preserve — the sentinel passes through.
    expect(merged["slot:modal:/"]).toBe(UNMATCHED_SLOT);
  });

  it("mergeElements clears stale slots absent from next when clearAbsentSlots is set", async () => {
    const { mergeElements } = await import("../packages/vinext/src/shims/slot.js");

    const merged = mergeElements(
      {
        "layout:/": React.createElement("div", null, "layout"),
        "page:/feed": React.createElement("div", null, "feed"),
        "slot:modal:/feed": React.createElement("div", null, "intercepted modal"),
      },
      {
        "layout:/": React.createElement("div", null, "layout"),
        "page:/feed": React.createElement("div", null, "feed"),
      },
      true,
    );

    expect(Object.hasOwn(merged, "slot:modal:/feed")).toBe(false);
  });

  it("mergeElements keeps unmatched slot markers on traversal without planner approval", async () => {
    const { mergeElements, UNMATCHED_SLOT } = await import("../packages/vinext/src/shims/slot.js");

    const realContent = React.createElement("div", null, "modal content");
    const merged = mergeElements(
      {
        "layout:/": React.createElement("div", null, "layout"),
        "page:/feed": React.createElement("div", null, "feed"),
        "slot:modal:/feed": realContent,
      },
      {
        "layout:/": React.createElement("div", null, "layout"),
        "page:/feed": React.createElement("div", null, "feed"),
        // @ts-expect-error - typescript is not correctly inferring the type of the symbol
        "slot:modal:/feed": UNMATCHED_SLOT,
      },
      { clearAbsentSlots: true, preserveElementIds: ["layout:/"] },
    );

    expect(Object.hasOwn(merged, "slot:modal:/feed")).toBe(true);
    expect(merged["slot:modal:/feed"]).toBe(UNMATCHED_SLOT);
  });

  it("mergeElements preserves absent slots when clearAbsentSlots is not set", async () => {
    const { mergeElements } = await import("../packages/vinext/src/shims/slot.js");

    const merged = mergeElements(
      {
        "layout:/": React.createElement("div", null, "layout"),
        "page:/dashboard": React.createElement("div", null, "dashboard"),
        "slot:team:/dashboard": React.createElement("div", null, "team panel"),
      },
      {
        "page:/dashboard/settings": React.createElement("div", null, "settings"),
      },
    );

    // Without clearAbsentSlots, absent slots survive (soft nav to child route)
    expect(Object.hasOwn(merged, "slot:team:/dashboard")).toBe(true);
  });

  it("mergeElements drops absent slots when legacy absent-slot preservation is fenced", async () => {
    const { mergeElements } = await import("../packages/vinext/src/shims/slot.js");

    const merged = mergeElements(
      {
        "layout:/": React.createElement("div", null, "layout"),
        "page:/dashboard": React.createElement("div", null, "dashboard"),
        "slot:team:/dashboard": React.createElement("div", null, "team panel"),
      },
      {
        "page:/dashboard/settings": React.createElement("div", null, "settings"),
      },
      { preserveAbsentSlots: false },
    );

    expect(Object.hasOwn(merged, "slot:team:/dashboard")).toBe(false);
  });

  it("mergeElements preserves explicitly approved mounted slots without wire absence semantics", async () => {
    const { mergeElements } = await import("../packages/vinext/src/shims/slot.js");

    const mountedSlot = React.createElement("div", null, "team panel");
    const merged = mergeElements(
      {
        "layout:/": React.createElement("div", null, "layout"),
        "layout:/dashboard": React.createElement("div", null, "dashboard layout"),
        "page:/dashboard": React.createElement("div", null, "dashboard"),
        "slot:team:/dashboard": mountedSlot,
      },
      {
        "page:/dashboard/settings": React.createElement("div", null, "settings"),
      },
      {
        preserveAbsentSlots: false,
        preserveElementIds: ["layout:/", "layout:/dashboard", "slot:team:/dashboard"],
      },
    );

    expect(merged["slot:team:/dashboard"]).toBe(mountedSlot);
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
