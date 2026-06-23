import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chunksToReadableStream,
  createProgressiveRscStream,
  getVinextBrowserGlobal,
} from "../packages/vinext/src/server/app-browser-stream.js";
import {
  NAVIGATION_RUNTIME_KEY,
  getNavigationRuntime,
  registerNavigationRuntimeBootstrap,
} from "../packages/vinext/src/client/navigation-runtime.js";

const originalDocument = globalThis.document;
const vinext = getVinextBrowserGlobal();

function resetBrowserGlobals(): void {
  delete vinext.__VINEXT_RSC_CHUNKS__;
  delete vinext.__VINEXT_RSC_DONE__;
  delete vinext.__VINEXT_RSC_PARAMS__;
  delete vinext.__VINEXT_RSC_NAV__;
  Reflect.deleteProperty(globalThis, "window");
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

async function readBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ done: boolean; bytes?: number[] }> {
  const result = await reader.read();
  return {
    done: result.done,
    bytes: result.value ? Array.from(result.value) : undefined,
  };
}

describe("App browser stream helpers", () => {
  beforeEach(() => {
    resetBrowserGlobals();
  });

  afterEach(() => {
    resetBrowserGlobals();
    setGlobalDocument(originalDocument);
    vi.useRealTimers();
  });

  it("turns embedded chunks into a readable byte stream", async () => {
    const reader = chunksToReadableStream(["alpha", "beta"]).getReader();

    expect(await readText(reader)).toEqual({ done: false, text: "alpha" });
    expect(await readText(reader)).toEqual({ done: false, text: "beta" });
    expect(await readText(reader)).toEqual({ done: true, text: undefined });
  });

  it("turns embedded binary chunks into exact readable bytes", async () => {
    // Ported from Next.js: test/e2e/app-dir/binary/rsc-binary.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/binary/rsc-binary.test.ts
    const reader = chunksToReadableStream(["text", [3, "/wABAgM="]]).getReader();

    expect(await readText(reader)).toEqual({ done: false, text: "text" });
    expect(await readBytes(reader)).toEqual({ done: false, bytes: [255, 0, 1, 2, 3] });
    expect(await readBytes(reader)).toEqual({ done: true, bytes: undefined });
  });

  it("replays existing chunks and streams future pushes immediately", async () => {
    const listeners = new Map<string, () => void>();
    setGlobalDocument({
      readyState: "loading",
      addEventListener: vi.fn((event: string, callback: EventListenerOrEventListenerObject) => {
        listeners.set(event, callback as () => void);
      }),
      removeEventListener: vi.fn(),
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

  it("closes the legacy progressive stream when the done marker arrives without another chunk", async () => {
    setGlobalDocument({
      readyState: "loading",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Document);

    vinext.__VINEXT_RSC_CHUNKS__ = [];
    vinext.__VINEXT_RSC_DONE__ = false;

    const reader = createProgressiveRscStream().getReader();

    vinext.__VINEXT_RSC_CHUNKS__!.push("final");
    expect(await readText(reader)).toEqual({ done: false, text: "final" });

    vinext.__VINEXT_RSC_DONE__ = true;
    expect(await readText(reader)).toEqual({ done: true, text: undefined });
  });

  it("streams progressive chunks from the typed navigation runtime", async () => {
    const runtimeWindow = {};
    Reflect.set(globalThis, "window", runtimeWindow);
    setGlobalDocument({
      readyState: "loading",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Document);

    registerNavigationRuntimeBootstrap({ rsc: { rsc: ["shell"], done: false } });

    const reader = createProgressiveRscStream().getReader();

    expect(await readText(reader)).toEqual({ done: false, text: "shell" });

    const runtimeRsc = getNavigationRuntime()?.bootstrap.rsc;
    if (runtimeRsc === undefined) {
      throw new Error("Expected navigation runtime RSC bootstrap");
    }

    runtimeRsc.rsc.push("delta");
    expect(await readText(reader)).toEqual({ done: false, text: "delta" });

    runtimeRsc.done = true;
    runtimeRsc.rsc.push("final");
    expect(await readText(reader)).toEqual({ done: false, text: "final" });
    expect(await readText(reader)).toEqual({ done: true, text: undefined });

    expect(Reflect.has(runtimeWindow, NAVIGATION_RUNTIME_KEY)).toBe(true);
  });

  it("closes the typed navigation runtime stream when the done marker arrives without another chunk", async () => {
    const runtimeWindow = {};
    Reflect.set(globalThis, "window", runtimeWindow);
    setGlobalDocument({
      readyState: "loading",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Document);

    registerNavigationRuntimeBootstrap({ rsc: { rsc: [], done: false } });

    const reader = createProgressiveRscStream().getReader();
    const runtimeRsc = getNavigationRuntime()?.bootstrap.rsc;
    if (runtimeRsc === undefined) {
      throw new Error("Expected navigation runtime RSC bootstrap");
    }

    runtimeRsc.rsc.push("final");
    expect(await readText(reader)).toEqual({ done: false, text: "final" });

    runtimeRsc.done = true;
    expect(await readText(reader)).toEqual({ done: true, text: undefined });

    expect(Reflect.has(runtimeWindow, NAVIGATION_RUNTIME_KEY)).toBe(true);
  });

  it("ignores done markers and chunks after the stream is cancelled", async () => {
    const removeEventListener = vi.fn();
    setGlobalDocument({
      readyState: "loading",
      addEventListener: vi.fn(),
      removeEventListener,
    } as unknown as Document);

    vinext.__VINEXT_RSC_CHUNKS__ = [];
    vinext.__VINEXT_RSC_DONE__ = false;

    const reader = createProgressiveRscStream().getReader();
    await reader.cancel();

    expect(() => {
      vinext.__VINEXT_RSC_DONE__ = true;
      vinext.__VINEXT_RSC_CHUNKS__!.push("late");
    }).not.toThrow();
    await Promise.resolve();

    expect(removeEventListener).toHaveBeenCalledWith("DOMContentLoaded", expect.any(Function));
  });

  it("streams every chunk when push receives multiple arguments", async () => {
    setGlobalDocument({
      readyState: "loading",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
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

  it("streams progressive binary chunks without UTF-8 replacement", async () => {
    // Ported from Next.js: test/e2e/app-dir/binary/rsc-binary.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/binary/rsc-binary.test.ts
    setGlobalDocument({
      readyState: "loading",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Document);

    vinext.__VINEXT_RSC_CHUNKS__ = [];
    vinext.__VINEXT_RSC_DONE__ = false;

    const reader = createProgressiveRscStream().getReader();

    vinext.__VINEXT_RSC_CHUNKS__!.push([3, "/wABAgM="]);
    expect(await readBytes(reader)).toEqual({ done: false, bytes: [255, 0, 1, 2, 3] });

    vinext.__VINEXT_RSC_DONE__ = true;
    vinext.__VINEXT_RSC_CHUNKS__!.push("final");
    expect(await readText(reader)).toEqual({ done: false, text: "final" });
    expect(await readBytes(reader)).toEqual({ done: true, bytes: undefined });
  });

  it("errors truncated streams on DOMContentLoaded before the done marker", async () => {
    let onDomContentLoaded: (() => void) | undefined;
    setGlobalDocument({
      readyState: "loading",
      addEventListener: vi.fn((event: string, callback: EventListenerOrEventListenerObject) => {
        if (event === "DOMContentLoaded") {
          onDomContentLoaded = callback as () => void;
        }
      }),
      removeEventListener: vi.fn(),
    } as unknown as Document);

    vinext.__VINEXT_RSC_CHUNKS__ = [];
    vinext.__VINEXT_RSC_DONE__ = false;

    const reader = createProgressiveRscStream().getReader();
    const pendingRead = readText(reader);

    expect(onDomContentLoaded).toBeTypeOf("function");
    onDomContentLoaded!();

    await expect(pendingRead).rejects.toThrow("The connection to the page was unexpectedly closed");
  });

  it("defers already-loaded document errors so the done marker can close cleanly", async () => {
    vi.useFakeTimers();
    setGlobalDocument({
      readyState: "complete",
    } as unknown as Document);

    vinext.__VINEXT_RSC_CHUNKS__ = [];
    vinext.__VINEXT_RSC_DONE__ = false;

    const reader = createProgressiveRscStream().getReader();
    const pendingRead = readText(reader);

    vinext.__VINEXT_RSC_DONE__ = true;
    vinext.__VINEXT_RSC_CHUNKS__!.push("final");

    expect(await pendingRead).toEqual({ done: false, text: "final" });
    expect(await readText(reader)).toEqual({ done: true, text: undefined });

    vi.runAllTimers();
    expect(await readText(reader)).toEqual({ done: true, text: undefined });
  });
});
