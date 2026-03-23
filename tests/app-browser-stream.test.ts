import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chunksToReadableStream,
  createProgressiveRscStream,
  getVinextBrowserGlobal,
} from "../packages/vinext/src/server/app-browser-stream.js";

const originalDocument = globalThis.document;
const vinext = getVinextBrowserGlobal();

function resetBrowserGlobals(): void {
  delete vinext.__VINEXT_RSC__;
  delete vinext.__VINEXT_RSC_CHUNKS__;
  delete vinext.__VINEXT_RSC_DONE__;
  delete vinext.__VINEXT_RSC_PARAMS__;
  delete vinext.__VINEXT_RSC_NAV__;
}

function setGlobalDocument(value: Document | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, "document");
    return;
  }

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value,
  });
}

async function readText(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ done: boolean; text?: string }> {
  const result = await reader.read();
  return {
    done: result.done,
    text: result.value ? new TextDecoder().decode(result.value) : undefined,
  };
}

describe("App browser stream helpers", () => {
  beforeEach(() => {
    resetBrowserGlobals();
  });

  afterEach(() => {
    resetBrowserGlobals();
    setGlobalDocument(originalDocument);
  });

  it("turns embedded chunks into a readable byte stream", async () => {
    const reader = chunksToReadableStream(["alpha", "beta"]).getReader();

    expect(await readText(reader)).toEqual({ done: false, text: "alpha" });
    expect(await readText(reader)).toEqual({ done: false, text: "beta" });
    expect(await readText(reader)).toEqual({ done: true, text: undefined });
  });

  it("replays existing chunks and streams future pushes immediately", async () => {
    const listeners = new Map<string, () => void>();
    setGlobalDocument({
      readyState: "loading",
      addEventListener: vi.fn((event: string, callback: EventListenerOrEventListenerObject) => {
        listeners.set(event, callback as () => void);
      }),
    } as unknown as Document);

    vinext.__VINEXT_RSC_CHUNKS__ = ["shell"];
    vinext.__VINEXT_RSC_DONE__ = false;

    const reader = createProgressiveRscStream().getReader();

    expect(await readText(reader)).toEqual({ done: false, text: "shell" });

    vinext.__VINEXT_RSC_CHUNKS__!.push("delta");
    expect(await readText(reader)).toEqual({ done: false, text: "delta" });

    vinext.__VINEXT_RSC_DONE__ = true;
    vinext.__VINEXT_RSC_CHUNKS__!.push("final");
    expect(await readText(reader)).toEqual({ done: false, text: "final" });
    expect(await readText(reader)).toEqual({ done: true, text: undefined });

    expect(listeners.has("DOMContentLoaded")).toBe(true);
  });

  it("streams every chunk when push receives multiple arguments", async () => {
    setGlobalDocument({
      readyState: "loading",
      addEventListener: vi.fn(),
    } as unknown as Document);

    vinext.__VINEXT_RSC_CHUNKS__ = [];
    vinext.__VINEXT_RSC_DONE__ = false;

    const reader = createProgressiveRscStream().getReader();

    vinext.__VINEXT_RSC_CHUNKS__!.push("alpha", "beta");
    expect(await readText(reader)).toEqual({ done: false, text: "alpha" });
    expect(await readText(reader)).toEqual({ done: false, text: "beta" });

    vinext.__VINEXT_RSC_DONE__ = true;
    vinext.__VINEXT_RSC_CHUNKS__!.push("omega");
    expect(await readText(reader)).toEqual({ done: false, text: "omega" });
    expect(await readText(reader)).toEqual({ done: true, text: undefined });
  });

  it("closes truncated streams on DOMContentLoaded", async () => {
    let onDomContentLoaded: (() => void) | undefined;
    setGlobalDocument({
      readyState: "loading",
      addEventListener: vi.fn((event: string, callback: EventListenerOrEventListenerObject) => {
        if (event === "DOMContentLoaded") {
          onDomContentLoaded = callback as () => void;
        }
      }),
    } as unknown as Document);

    vinext.__VINEXT_RSC_CHUNKS__ = [];
    vinext.__VINEXT_RSC_DONE__ = false;

    const reader = createProgressiveRscStream().getReader();
    const pendingRead = readText(reader);

    expect(onDomContentLoaded).toBeTypeOf("function");
    onDomContentLoaded!();

    expect(await pendingRead).toEqual({ done: true, text: undefined });
  });
});
