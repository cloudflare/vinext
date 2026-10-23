import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildAppPageLinkHeader,
  createAppPageFontData,
  createAppPageRscErrorTracker,
  createAppPageSsrErrorHandler,
  renderAppPageHtmlResponse,
  renderAppPageHtmlStream,
  renderAppPageHtmlStreamWithRecovery,
} from "../packages/vinext/src/server/app-page-stream.js";
import {
  deferUntilStreamConsumed,
  observeStreamConsumption,
} from "../packages/vinext/src/server/defer-until-stream-consumed.js";
import { hasFrameworkLinkHeaders } from "../packages/vinext/src/server/app-response-header-provenance.js";
import { finalizeAppRscResponse } from "../packages/vinext/src/server/app-rsc-response-finalizer.js";

function createStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

describe("app page stream helpers", () => {
  it("collects app page font data from RSC environment getters", () => {
    expect(
      createAppPageFontData({
        getLinks() {
          return ["/font.css"];
        },
        getPreloads() {
          return [{ href: "/font.woff2", type: "font/woff2" }];
        },
        getStyles() {
          return [".font { font-family: Test; }"];
        },
      }),
    ).toEqual({
      links: ["/font.css"],
      preloads: [{ href: "/font.woff2", type: "font/woff2" }],
      styles: [".font { font-family: Test; }"],
    });
  });

  it("renders the HTML stream through the SSR handler", async () => {
    const fontData = createAppPageFontData({
      getLinks: () => ["/font.css"],
      getPreloads: () => [{ href: "/font.woff2", type: "font/woff2" }],
      getStyles: () => [],
    });

    const { htmlStream } = await renderAppPageHtmlStream({
      fontData,
      navigationContext: { pathname: "/test", searchParams: new URLSearchParams(), params: {} },
      rscStream: createStream(["flight"]),
      ssrHandler: {
        async handleSsr(_rscStream, navigationContext, receivedFontData) {
          expect(navigationContext).toEqual({
            pathname: "/test",
            searchParams: new URLSearchParams(),
            params: {},
          });
          expect(receivedFontData).toEqual(fontData);
          return createStream(["<html>ok</html>"]);
        },
      },
    });

    await expect(new Response(htmlStream).text()).resolves.toBe("<html>ok</html>");
  });

  it("forwards static-generation state to the SSR handler", async () => {
    const ssrHandler = vi.fn(async () => createStream(["<html>all-ready</html>"]));

    const { htmlStream } = await renderAppPageHtmlStream({
      fontData: createAppPageFontData({
        getLinks: () => [],
        getPreloads: () => [],
        getStyles: () => [],
      }),
      navigationContext: null,
      rscStream: createStream(["flight"]),
      waitForAllReady: true,
      isStaticGeneration: true,
      isForceStatic: false,
      ssrHandler: { handleSsr: ssrHandler },
    });

    await expect(new Response(htmlStream).text()).resolves.toBe("<html>all-ready</html>");
    expect(ssrHandler).toHaveBeenCalledTimes(1);
    expect(ssrHandler).toHaveBeenCalledWith(
      expect.anything(),
      null,
      expect.anything(),
      expect.objectContaining({
        waitForAllReady: true,
        isStaticGeneration: true,
        isForceStatic: false,
      }),
    );
  });

  it("forwards the PPR fallback-shell abort signal to the SSR handler", async () => {
    const abortController = new AbortController();
    const ssrHandler = vi.fn(async () => createStream(["<html>fallback-shell</html>"]));

    const { htmlStream } = await renderAppPageHtmlStream({
      fontData: createAppPageFontData({
        getLinks: () => [],
        getPreloads: () => [],
        getStyles: () => [],
      }),
      navigationContext: null,
      pprFallbackShellSignal: abortController.signal,
      rscStream: createStream(["flight"]),
      ssrHandler: { handleSsr: ssrHandler },
    });

    await expect(new Response(htmlStream).text()).resolves.toBe("<html>fallback-shell</html>");
    expect(ssrHandler).toHaveBeenCalledWith(
      expect.anything(),
      null,
      expect.anything(),
      expect.objectContaining({ pprFallbackShellSignal: abortController.signal }),
    );
  });

  it("forwards form state to the SSR handler", async () => {
    const formState = ["action-result", "key-path", "reference-id", 1] as never;
    const ssrHandler = vi.fn(async () => createStream(["<html>form-state</html>"]));

    const { htmlStream } = await renderAppPageHtmlStream({
      fontData: createAppPageFontData({
        getLinks: () => [],
        getPreloads: () => [],
        getStyles: () => [],
      }),
      formState,
      navigationContext: null,
      rscStream: createStream(["flight"]),
      ssrHandler: { handleSsr: ssrHandler },
    });

    await expect(new Response(htmlStream).text()).resolves.toBe("<html>form-state</html>");
    expect(ssrHandler).toHaveBeenCalledWith(
      expect.anything(),
      null,
      expect.anything(),
      expect.objectContaining({ formState }),
    );
  });

  it("forwards basePath to the SSR handler", async () => {
    const ssrHandler = vi.fn(async () => createStream(["<html>base-path</html>"]));

    const { htmlStream } = await renderAppPageHtmlStream({
      basePath: "/docs",
      fontData: createAppPageFontData({
        getLinks: () => [],
        getPreloads: () => [],
        getStyles: () => [],
      }),
      navigationContext: null,
      rscStream: createStream(["flight"]),
      ssrHandler: { handleSsr: ssrHandler },
    });

    await expect(new Response(htmlStream).text()).resolves.toBe("<html>base-path</html>");
    expect(ssrHandler).toHaveBeenCalledWith(
      expect.anything(),
      null,
      expect.anything(),
      expect.objectContaining({ basePath: "/docs" }),
    );
  });

  it("defers clearRequestContext until the HTML stream body is fully consumed", async () => {
    // Regression test for issue #660: clearRequestContext() must not race the
    // lazy RSC/SSR stream pipeline. It should be called only after the HTTP
    // response body has been fully consumed by the downstream consumer.
    const contextCleared: string[] = [];
    const clearRequestContext = vi.fn(() => {
      contextCleared.push("cleared");
    });

    const response = await renderAppPageHtmlResponse({
      clearRequestContext,
      fontData: {
        links: [],
        preloads: [],
        styles: [],
      },
      navigationContext: null,
      rscStream: createStream(["flight"]),
      ssrHandler: {
        async handleSsr() {
          return createStream(["<html>page</html>"]);
        },
      },
      status: 200,
    });

    // The context must NOT be cleared yet — the response stream hasn't been
    // consumed by the downstream caller (i.e. the HTTP layer) yet.
    expect(contextCleared).toHaveLength(0);

    // Consuming the stream simulates the HTTP layer reading the response body.
    await response.text();

    // Now that the stream is fully consumed, context must have been cleared.
    expect(contextCleared).toHaveLength(1);
  });

  it("calls onFlush when the upstream stream errors mid-consumption", async () => {
    const onFlush = vi.fn();
    const streamError = new Error("component threw during streaming");

    // Emit one chunk, then error on the next pull — simulates a component
    // throwing partway through RSC/SSR streaming.
    let pullCount = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          controller.enqueue(new TextEncoder().encode("partial"));
        } else {
          controller.error(streamError);
        }
      },
    });

    const wrapped = deferUntilStreamConsumed(source, onFlush);
    const reader = wrapped.getReader();

    // First read succeeds with the enqueued chunk.
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("partial");

    // Second read should surface the upstream error.
    await expect(reader.read()).rejects.toThrow("component threw during streaming");

    // onFlush must have been called despite the error — this is the bug fix.
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("calls onFlush only once when the stream errors then is cancelled", async () => {
    const onFlush = vi.fn();
    const streamError = new Error("stream error");

    // Error on the very first pull — simulates immediate failure.
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(streamError);
      },
    });

    const wrapped = deferUntilStreamConsumed(source, onFlush);
    const reader = wrapped.getReader();

    // Reading the errored stream triggers the error handler.
    await expect(reader.read()).rejects.toThrow("stream error");

    // The wrapper settles once, so onFlush fires exactly once even if some
    // code path tried to clean up again.
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("runs flush callbacks only after the consumer reads the end of the stream", async () => {
    const onFlush = vi.fn();
    const reader = deferUntilStreamConsumed(createStream(["a", "b"]), onFlush).getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toBe("a");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("b");
    expect(onFlush).not.toHaveBeenCalled();

    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("reuses an unread wrapper and runs its callbacks in layered order", async () => {
    const calls: string[] = [];
    const inner = deferUntilStreamConsumed(createStream(["page"]), () => calls.push("inner"));
    const outer = deferUntilStreamConsumed(new Response(inner).body ?? inner, () =>
      calls.push("outer"),
    );

    await expect(new Response(outer).text()).resolves.toBe("page");
    expect(calls).toEqual(["inner", "outer"]);
  });

  it("runs coalesced error callbacks innermost first", async () => {
    const calls: string[] = [];
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("boom"));
      },
    });
    const inner = deferUntilStreamConsumed(
      source,
      () => calls.push("inner flush"),
      () => calls.push("inner error"),
    );
    const outer = deferUntilStreamConsumed(
      inner,
      () => calls.push("outer flush"),
      () => calls.push("outer error"),
    );

    expect(outer).toBe(inner);
    await expect(outer.getReader().read()).rejects.toThrow("boom");
    expect(calls).toEqual(["inner error", "inner flush", "outer error", "outer flush"]);
  });

  it("runs coalesced cancel callbacks outermost first before cancelling the source", async () => {
    const calls: string[] = [];
    const source = new ReadableStream<Uint8Array>({
      cancel(reason) {
        calls.push(`source ${String(reason)}`);
      },
    });
    const inner = deferUntilStreamConsumed(
      source,
      () => calls.push("inner flush"),
      undefined,
      (reason) => calls.push(`inner cancel ${String(reason)}`),
    );
    const outer = deferUntilStreamConsumed(
      inner,
      () => calls.push("outer flush"),
      undefined,
      (reason) => calls.push(`outer cancel ${String(reason)}`),
    );

    await outer.cancel("gone");
    expect(calls).toEqual([
      "outer cancel gone",
      "outer flush",
      "inner cancel gone",
      "inner flush",
      "source gone",
    ]);
  });

  it("adds a separate layer when the wrapper is already being read", async () => {
    const calls: string[] = [];
    const inner = deferUntilStreamConsumed(createStream(["page"]), () => calls.push("inner"));
    const innerReader = inner.getReader();
    const passthrough = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await innerReader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
    });
    const outer = deferUntilStreamConsumed(passthrough, () => calls.push("outer"));

    expect(outer).not.toBe(inner);
    await expect(new Response(outer).text()).resolves.toBe("page");
    expect(calls).toEqual(["inner", "outer"]);
  });

  it("runs each layer's callbacks in the async context that added it", async () => {
    const als = new AsyncLocalStorage<string>();
    const seen: string[] = [];
    const inner = als.run("render", () =>
      deferUntilStreamConsumed(createStream(["page"]), () => seen.push(`inner ${als.getStore()}`)),
    );
    const outer = als.run("tracing", () =>
      deferUntilStreamConsumed(inner, () => seen.push(`outer ${als.getStore()}`)),
    );

    await expect(new Response(outer).text()).resolves.toBe("page");
    expect(seen).toEqual(["inner render", "outer tracing"]);
  });

  it("cancels the source in the async context that created the wrapper", async () => {
    const als = new AsyncLocalStorage<string>();
    const seen: string[] = [];
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        seen.push(`source ${als.getStore()}`);
      },
    });
    const inner = als.run("render", () =>
      deferUntilStreamConsumed(
        source,
        () => {},
        undefined,
        () => seen.push(`inner ${als.getStore()}`),
      ),
    );
    const outer = als.run("tracing", () =>
      deferUntilStreamConsumed(
        inner,
        () => {},
        undefined,
        () => seen.push(`outer ${als.getStore()}`),
      ),
    );

    await outer.cancel("gone");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(["outer tracing", "inner render", "source render"]);
  });

  it("reads the source in the async context that created the wrapper", async () => {
    const als = new AsyncLocalStorage<string>();
    const seen: string[] = [];
    const createSource = () => {
      const body = new Response("page").body!.getReader();
      return new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            const { done, value } = await body.read();
            seen.push(`source ${als.getStore()}`);
            if (done) controller.close();
            else controller.enqueue(value);
          },
        },
        { highWaterMark: 0 },
      );
    };
    // As in a request handler, the source is created before an await and wrapped after it.
    const wrapped = await als.run("render", async () => {
      const source = createSource();
      await Promise.resolve();
      return deferUntilStreamConsumed(source, () => {});
    });

    // The runtime reads the response body from outside the request's context.
    await expect(new Response(wrapped).text()).resolves.toBe("page");
    expect(seen).toEqual(["source render", "source render"]);
  });

  it("runs start callbacks when the consumer reads the first chunk, without reading ahead", async () => {
    const calls: string[] = [];
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          if (pulls === 1) controller.enqueue(new TextEncoder().encode("page"));
          else controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const inner = deferUntilStreamConsumed(source, () => calls.push("inner flush"));
    const outer = observeStreamConsumption(inner, {
      onStart: () => calls.push("outer start"),
      onFlush: () => calls.push("outer flush"),
    });

    expect(outer).toBe(inner);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pulls).toBe(0);

    const reader = outer.getReader();
    await reader.read();
    expect(calls).toEqual(["outer start"]);
    await reader.read();
    expect(calls).toEqual(["outer start", "inner flush", "outer flush"]);
  });

  it("does not run start callbacks once the consumer has cancelled", async () => {
    const calls: string[] = [];
    const stream = observeStreamConsumption(createStream(["page"]), {
      onStart: () => calls.push("start"),
      onCancel: () => calls.push("cancel"),
      onFlush: () => calls.push("flush"),
    });
    const reader = stream.getReader();
    // Once the stream has started, a read pulls at once. The source read
    // settles straight away, but its callback runs after the cancel.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const read = reader.read();
    await reader.cancel("gone");
    await read;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["cancel", "flush"]);
  });

  it("does not run outer start callbacks after an inner one throws", async () => {
    const calls: string[] = [];
    const inner = observeStreamConsumption(createStream(["page"]), {
      onStart() {
        calls.push("inner start");
        throw new Error("start failed");
      },
      onError: (error) => calls.push(`inner error ${(error as Error).message}`),
      onFlush: () => calls.push("inner flush"),
    });
    const outer = observeStreamConsumption(inner, {
      onStart: () => calls.push("outer start"),
      onError: (error) => calls.push(`outer error ${(error as Error).message}`),
      onFlush: () => calls.push("outer flush"),
    });

    expect(outer).toBe(inner);
    await expect(outer.getReader().read()).rejects.toThrow("start failed");
    expect(calls).toEqual([
      "inner start",
      "inner error start failed",
      "inner flush",
      "outer error start failed",
      "outer flush",
    ]);
  });

  it("errors the stream and still runs the flush callbacks when a start callback throws", async () => {
    const calls: string[] = [];
    const stream = observeStreamConsumption(createStream(["page"]), {
      onStart() {
        throw new Error("start failed");
      },
      onError: (error) => calls.push(`error ${(error as Error).message}`),
      onFlush: () => calls.push("flush"),
    });

    await expect(stream.getReader().read()).rejects.toThrow("start failed");
    expect(calls).toEqual(["error start failed", "flush"]);
  });

  it("passes a cleanup failure to the outer layers like separate wrappers would", async () => {
    const calls: string[] = [];
    const inner = deferUntilStreamConsumed(createStream([]), () => {
      throw new Error("cleanup failed");
    });
    const outer = deferUntilStreamConsumed(
      inner,
      () => calls.push("outer flush"),
      (error) => calls.push(`outer error ${(error as Error).message}`),
    );

    await expect(outer.getReader().read()).rejects.toThrow("cleanup failed");
    expect(calls).toEqual(["outer error cleanup failed", "outer flush"]);
  });

  it("passes a layer's own cleanup failure to its error callback", async () => {
    const calls: string[] = [];
    const inner = deferUntilStreamConsumed(
      createStream([]),
      () => {
        calls.push("inner flush");
        throw new Error("cleanup failed");
      },
      (error) => calls.push(`inner error ${(error as Error).message}`),
    );
    const outer = deferUntilStreamConsumed(
      inner,
      () => calls.push("outer flush"),
      (error) => calls.push(`outer error ${(error as Error).message}`),
    );

    await expect(outer.getReader().read()).rejects.toThrow("cleanup failed");
    expect(calls).toEqual([
      "inner flush",
      "inner error cleanup failed",
      "outer error cleanup failed",
      "outer flush",
    ]);
  });

  it("passes an error thrown while reporting a cleanup failure to the outer layers", async () => {
    const calls: string[] = [];
    const inner = deferUntilStreamConsumed(
      createStream([]),
      () => {
        throw new Error("cleanup failed");
      },
      () => {
        throw new Error("report failed");
      },
    );
    const outer = deferUntilStreamConsumed(
      inner,
      () => calls.push("outer flush"),
      (error) => calls.push(`outer error ${(error as Error).message}`),
    );

    await expect(outer.getReader().read()).rejects.toThrow("report failed");
    expect(calls).toEqual(["outer error report failed", "outer flush"]);
  });

  it("does not report a cleanup failure to a layer that already saw the stream's error", async () => {
    const calls: string[] = [];
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("boom"));
      },
    });
    const wrapped = deferUntilStreamConsumed(
      source,
      () => {
        calls.push("flush");
        throw new Error("cleanup failed");
      },
      (error) => calls.push(`error ${(error as Error).message}`),
    );

    await expect(wrapped.getReader().read()).rejects.toThrow("cleanup failed");
    expect(calls).toEqual(["error boom", "flush"]);
  });

  it("passes an error replaced by an inner error callback to the outer layers", async () => {
    const calls: string[] = [];
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("source failed"));
      },
    });
    const inner = deferUntilStreamConsumed(
      source,
      () => calls.push("inner flush"),
      () => {
        throw new Error("error handler failed");
      },
    );
    const outer = deferUntilStreamConsumed(
      inner,
      () => calls.push("outer flush"),
      (error) => calls.push(`outer error ${(error as Error).message}`),
    );

    await expect(outer.getReader().read()).rejects.toThrow("error handler failed");
    expect(calls).toEqual(["outer error error handler failed", "outer flush"]);
  });

  it("passes on the error callback's failure when the flush callback would also throw", async () => {
    const calls: string[] = [];
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("source failed"));
      },
    });
    const inner = deferUntilStreamConsumed(
      source,
      () => {
        calls.push("inner flush");
        throw new Error("cleanup failed");
      },
      () => {
        throw new Error("error handler failed");
      },
    );
    const outer = deferUntilStreamConsumed(
      inner,
      () => calls.push("outer flush"),
      (error) => calls.push(`outer error ${(error as Error).message}`),
    );

    await expect(outer.getReader().read()).rejects.toThrow("error handler failed");
    expect(calls).toEqual(["outer error error handler failed", "outer flush"]);
  });

  it("skips a layer's flush callback when its cancel callback throws", async () => {
    const calls: string[] = [];
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        calls.push("source cancel");
      },
    });
    const inner = deferUntilStreamConsumed(
      source,
      () => calls.push("inner flush"),
      undefined,
      () => calls.push("inner cancel"),
    );
    const outer = deferUntilStreamConsumed(
      inner,
      () => calls.push("outer flush"),
      undefined,
      () => {
        calls.push("outer cancel");
        throw new Error("cancel handler failed");
      },
    );

    await expect(outer.cancel("gone")).rejects.toThrow("cancel handler failed");
    expect(calls).toEqual(["outer cancel", "inner cancel", "inner flush", "source cancel"]);
  });

  it("keeps a callback's failure when cancelling the source also fails", async () => {
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error("source cancel failed");
      },
    });
    const wrapped = deferUntilStreamConsumed(
      source,
      () => {},
      undefined,
      () => {
        throw new Error("cancel handler failed");
      },
    );

    await expect(wrapped.cancel("gone")).rejects.toThrow("cancel handler failed");
    expect(source.locked).toBe(false);
  });

  it("unlocks the source once it is done", async () => {
    const source = createStream(["page"]);
    const wrapped = deferUntilStreamConsumed(source, () => {});

    await expect(new Response(wrapped).text()).resolves.toBe("page");
    expect(source.locked).toBe(false);
  });

  it("unlocks the source once it errors", async () => {
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("boom"));
      },
    });
    const wrapped = deferUntilStreamConsumed(source, () => {});

    await expect(wrapped.getReader().read()).rejects.toThrow("boom");
    expect(source.locked).toBe(false);
  });

  it("unlocks the source once it is cancelled", async () => {
    let resolveCancel!: () => void;
    const source = new ReadableStream<Uint8Array>({
      cancel: () =>
        new Promise<void>((resolve) => {
          resolveCancel = resolve;
        }),
    });
    const wrapped = deferUntilStreamConsumed(source, () => {});

    const cancelled = wrapped.cancel("gone");
    expect(source.locked).toBe(true);
    resolveCancel();
    await cancelled;
    expect(source.locked).toBe(false);
  });

  it("reuses an unread wrapper from another copy of the module", async () => {
    // The RSC and SSR environments load separate copies of the module.
    vi.resetModules();
    const copy = await import("../packages/vinext/src/server/defer-until-stream-consumed.js");
    expect(copy.deferUntilStreamConsumed).not.toBe(deferUntilStreamConsumed);

    const calls: string[] = [];
    const inner = copy.deferUntilStreamConsumed(createStream(["page"]), () => calls.push("ssr"));
    const outer = deferUntilStreamConsumed(inner, () => calls.push("rsc"));

    expect(outer).toBe(inner);
    await expect(new Response(outer).text()).resolves.toBe("page");
    expect(calls).toEqual(["ssr", "rsc"]);
  });

  it("adds a separate layer to a wrapper that was read and released", async () => {
    const calls: string[] = [];
    const inner = deferUntilStreamConsumed(createStream(["a", "b"]), () => calls.push("inner"));
    const reader = inner.getReader();
    await reader.read();
    reader.releaseLock();

    const outer = deferUntilStreamConsumed(inner, () => calls.push("outer"));
    expect(outer).not.toBe(inner);
    await expect(new Response(outer).text()).resolves.toBe("b");
    expect(calls).toEqual(["inner", "outer"]);
  });

  it("throws on a locked wrapper that has not been read yet", async () => {
    const calls: string[] = [];
    const inner = deferUntilStreamConsumed(createStream(["page"]), () => calls.push("inner"));
    const reader = inner.getReader();

    expect(() => deferUntilStreamConsumed(inner, () => calls.push("outer"))).toThrow(TypeError);
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(calls).toEqual(["inner"]);
  });

  it("reuses a wrapper that was locked and released without being read", async () => {
    const calls: string[] = [];
    const inner = deferUntilStreamConsumed(createStream(["page"]), () => calls.push("inner"));
    inner.getReader().releaseLock();

    const outer = deferUntilStreamConsumed(inner, () => calls.push("outer"));
    expect(outer).toBe(inner);
    await expect(new Response(outer).text()).resolves.toBe("page");
    expect(calls).toEqual(["inner", "outer"]);
  });

  it("does not read an empty source before the consumer does", async () => {
    const calls: string[] = [];
    const inner = deferUntilStreamConsumed(createStream([]), () => calls.push("inner"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);

    const outer = deferUntilStreamConsumed(inner, () => calls.push("outer"));
    expect(outer).toBe(inner);
    await expect(new Response(outer).text()).resolves.toBe("");
    expect(calls).toEqual(["inner", "outer"]);
  });

  it("builds an HTML response, including link headers, and defers clearing request context until after body is consumed", async () => {
    const clearRequestContext = vi.fn();

    const response = await renderAppPageHtmlResponse({
      clearRequestContext,
      fontData: {
        links: [],
        preloads: [],
        styles: [],
      },
      fontLinkHeader: "</font.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
      navigationContext: null,
      rscStream: createStream(["flight"]),
      ssrHandler: {
        async handleSsr() {
          return createStream(["<html>page</html>"]);
        },
      },
      status: 203,
    });

    // Context must NOT be cleared before body is consumed (see issue #660).
    expect(clearRequestContext).toHaveBeenCalledTimes(0);
    expect(response.status).toBe(203);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("link")).toBe(
      "</font.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
    );
    await expect(response.text()).resolves.toBe("<html>page</html>");

    // After body is consumed, context must be cleared exactly once.
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
  });

  it("appends fallback React and font preloads after middleware Link values", async () => {
    const middlewareHeaders = new Headers({
      Link: "</middleware.css>; rel=preload; as=style",
    });
    const response = await renderAppPageHtmlResponse({
      clearRequestContext: vi.fn(),
      fontData: { links: [], preloads: [], styles: [] },
      fontLinkHeader: "</font.woff2>; rel=preload; as=font",
      middlewareHeaders,
      navigationContext: null,
      rscStream: createStream(["flight"]),
      ssrHandler: {
        async handleSsr() {
          return {
            htmlStream: createStream(["<html>fallback</html>"]),
            metadataReady: Promise.resolve(),
            capturedRscData: null,
            linkHeader: "</react.js>; rel=preload; as=script",
          };
        },
      },
      status: 404,
    });

    expect(response.headers.get("link")).toBe(
      "</middleware.css>; rel=preload; as=style, " +
        "</react.js>; rel=preload; as=script, </font.woff2>; rel=preload; as=font",
    );
    expect(hasFrameworkLinkHeaders(response.headers)).toBe(true);
  });

  it("preserves config Link values alongside fallback React and font preloads", async () => {
    const response = await renderAppPageHtmlResponse({
      clearRequestContext: vi.fn(),
      fontData: { links: [], preloads: [], styles: [] },
      fontLinkHeader: "</font.woff2>; rel=preload; as=font",
      navigationContext: null,
      rscStream: createStream(["flight"]),
      ssrHandler: {
        async handleSsr() {
          return {
            htmlStream: createStream(["<html>fallback</html>"]),
            metadataReady: Promise.resolve(),
            capturedRscData: null,
            linkHeader: "</react.js>; rel=preload; as=script",
          };
        },
      },
      status: 404,
    });

    await finalizeAppRscResponse(response, new Request("https://example.com/missing"), {
      basePath: "",
      configHeaders: [
        {
          source: "/missing",
          headers: [{ key: "Link", value: '</config>; rel="describedby"' }],
        },
      ],
      i18nConfig: null,
      requestContext: {
        cookies: {},
        headers: new Headers(),
        host: "example.com",
        query: new URLSearchParams(),
      },
    });

    expect(response.headers.get("link")).toBe(
      '</config>; rel="describedby", </react.js>; rel=preload; as=script, ' +
        "</font.woff2>; rel=preload; as=font",
    );
  });

  it("returns the HTML stream and marks shell render completion when SSR succeeds", async () => {
    const onShellRendered = vi.fn();

    const result = await renderAppPageHtmlStreamWithRecovery({
      onShellRendered,
      async renderErrorBoundaryResponse() {
        throw new Error("should not render an error boundary");
      },
      async renderHtmlStream() {
        return createStream(["<html>ok</html>"]);
      },
      async renderSpecialErrorResponse() {
        throw new Error("should not render a special response");
      },
      resolveSpecialError() {
        return null;
      },
    });

    expect(onShellRendered).toHaveBeenCalledTimes(1);
    expect(result.response).toBeNull();
    expect(result.shellErrorRecovered).toBe(false);
    await expect(new Response(result.htmlStream).text()).resolves.toBe("<html>ok</html>");
  });

  it("preserves the SSR shell recovery outcome", async () => {
    const result = await renderAppPageHtmlStreamWithRecovery({
      async renderErrorBoundaryResponse() {
        throw new Error("should not render an error boundary");
      },
      async renderHtmlStream() {
        return {
          htmlStream: createStream(['<html id="__next_error__"></html>']),
          metadataReady: Promise.resolve(),
          capturedRscData: null,
          shellErrorRecovered: true,
        };
      },
      async renderSpecialErrorResponse() {
        throw new Error("should not render a special response");
      },
      resolveSpecialError() {
        return null;
      },
    });

    expect(result.response).toBeNull();
    expect(result.shellErrorRecovered).toBe(true);
  });

  it("turns special SSR failures into the provided response", async () => {
    const ssrError = new Error("redirect");
    const renderSpecialErrorResponse = vi.fn(async () => new Response("special", { status: 307 }));

    const result = await renderAppPageHtmlStreamWithRecovery({
      async renderErrorBoundaryResponse() {
        throw new Error("should not render an error boundary");
      },
      async renderHtmlStream() {
        throw ssrError;
      },
      renderSpecialErrorResponse,
      resolveSpecialError(error) {
        return error === ssrError
          ? {
              kind: "redirect",
              location: "/target",
              statusCode: 307,
            }
          : null;
      },
    });

    expect(renderSpecialErrorResponse).toHaveBeenCalledWith({
      kind: "redirect",
      location: "/target",
      statusCode: 307,
    });
    expect(result.htmlStream).toBeNull();
    expect(result.response?.status).toBe(307);
    await expect(result.response?.text()).resolves.toBe("special");
  });

  it("sends a shell's special error with the document slot boundaries caught it in", async () => {
    const notFoundError = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };
    const renderSpecialErrorResponse = vi.fn(
      async (_specialError: unknown, caughtDocument?: { htmlStream: ReadableStream<Uint8Array> }) =>
        new Response(caughtDocument?.htmlStream, { status: 404 }),
    );

    const result = await renderAppPageHtmlStreamWithRecovery({
      async renderErrorBoundaryResponse() {
        throw new Error("should not render an error boundary");
      },
      async renderHtmlStream() {
        return {
          htmlStream: createStream(["<html>caught</html>"]),
          metadataReady: Promise.resolve(),
          capturedRscData: null,
          caughtShellError: notFoundError,
          linkHeader: "</a.css>; rel=preload; as=style",
        };
      },
      renderSpecialErrorResponse,
      resolveSpecialError(error) {
        return error === notFoundError ? { kind: "http-access-fallback", statusCode: 404 } : null;
      },
    });

    expect(renderSpecialErrorResponse).toHaveBeenCalledWith(
      { kind: "http-access-fallback", statusCode: 404 },
      expect.objectContaining({ linkHeader: "</a.css>; rel=preload; as=style" }),
    );
    expect(result.htmlStream).toBeNull();
    expect(result.response?.status).toBe(404);
    await expect(result.response?.text()).resolves.toBe("<html>caught</html>");
  });

  it("falls back to the error boundary response for non-special SSR failures", async () => {
    const ssrError = new Error("boom");
    const renderErrorBoundaryResponse = vi.fn(
      async () => new Response("boundary", { status: 200 }),
    );

    const result = await renderAppPageHtmlStreamWithRecovery({
      renderErrorBoundaryResponse,
      async renderHtmlStream() {
        throw ssrError;
      },
      async renderSpecialErrorResponse() {
        throw new Error("should not render a special response");
      },
      resolveSpecialError() {
        return null;
      },
    });

    expect(renderErrorBoundaryResponse).toHaveBeenCalledWith(ssrError);
    expect(result.htmlStream).toBeNull();
    expect(result.response?.status).toBe(200);
    await expect(result.response?.text()).resolves.toBe("boundary");
  });

  it("tracks non-navigation RSC errors while preserving the base onError callback", () => {
    const baseOnError = vi.fn(() => "base-result");
    const tracker = createAppPageRscErrorTracker(baseOnError);

    expect(tracker.onRenderError(new Error("boom"), { path: "/test" }, { chunk: 1 })).toBe(
      "base-result",
    );
    expect(tracker.getCapturedError()).toBeInstanceOf(Error);

    tracker.onRenderError({ digest: "NEXT_NOT_FOUND" }, { path: "/test" }, { chunk: 2 });
    expect((tracker.getCapturedError() as Error).message).toBe("boom");
    expect(baseOnError).toHaveBeenCalledTimes(2);
  });

  it("routes a non-signal digest error to the captured error, not the special slot", () => {
    const baseOnError = vi.fn(() => "base-result");
    const tracker = createAppPageRscErrorTracker(baseOnError);

    // A genuine error that merely carries a (e.g. hashed) digest is not a
    // navigation signal: it must reach the error boundary, not take the slot
    // reserved for real redirect/notFound signals.
    const realError = Object.assign(new Error("kaboom"), { digest: "1234567890" });
    tracker.onRenderError(realError, { path: "/test" }, { chunk: 1 });

    expect(tracker.getCapturedError()).toBe(realError);
    expect(tracker.getCapturedSpecialError()).toBeNull();

    // A subsequent real navigation signal still wins the special slot.
    const redirect = { digest: "NEXT_REDIRECT;push;%2Flogin;307" };
    tracker.onRenderError(redirect, { path: "/test" }, { chunk: 2 });

    expect(tracker.getCapturedSpecialError()).toBe(redirect);
    expect(tracker.getCapturedError()).toBe(realError);
  });

  it("finds the special errors the RSC render threw with a decoded error's digest", () => {
    const tracker = createAppPageRscErrorTracker((error) => (error as { digest: string }).digest);
    const metadataNotFound = { digest: "NEXT_HTTP_ERROR_FALLBACK;404", fromMetadata: true };
    const pageNotFound = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };
    const redirect = { digest: "NEXT_REDIRECT;replace;/target;307;" };
    tracker.onRenderError(metadataNotFound, null, null);
    tracker.onRenderError(redirect, null, null);
    tracker.onRenderError(pageNotFound, null, null);

    const decoded = Object.assign(new Error("decoded"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(tracker.getCapturedSpecialErrors(decoded)).toEqual([metadataNotFound, pageNotFound]);
    expect(tracker.getCapturedSpecialErrors(new Error("no digest"))).toEqual([]);
  });

  it("correlates re-created RSC errors by digest and keeps custom-digest SSR errors reportable", () => {
    const baseRscOnError = vi.fn(() => "rsc-digest");
    const tracker = createAppPageRscErrorTracker(baseRscOnError);
    const originalRscError = new Error("RSC failed");
    tracker.onRenderError(originalRscError, null, null);

    const baseSsrOnError = vi.fn(() => "ssr-digest");
    const onSsrError = createAppPageSsrErrorHandler(baseSsrOnError, tracker.isCapturedError);
    const decodedRscError = Object.assign(new Error("decoded RSC failure"), {
      digest: "rsc-digest",
    });
    const customDigestSsrError = Object.assign(new Error("client SSR failure"), {
      digest: "custom-ssr-digest",
    });

    expect(onSsrError(decodedRscError)).toBe("rsc-digest");
    expect(onSsrError(customDigestSsrError)).toBe("ssr-digest");
    expect(baseSsrOnError).toHaveBeenCalledOnce();
    expect(baseSsrOnError).toHaveBeenCalledWith(customDigestSsrError, undefined, undefined);
  });

  it.each(["AbortError", "ResponseAborted"])("does not report %s SSR cancellations", (name) => {
    const baseSsrOnError = vi.fn();
    const onSsrError = createAppPageSsrErrorHandler(baseSsrOnError, () => false);
    const abortError = Object.assign(new Error("response closed"), { name });

    expect(onSsrError(abortError)).toBeUndefined();
    expect(baseSsrOnError).not.toHaveBeenCalled();
  });

  it("emits the `x-edge-runtime: 1` marker on HTML stream responses for edge-runtime routes", async () => {
    const response = await renderAppPageHtmlResponse({
      clearRequestContext: vi.fn(),
      fontData: { links: [], preloads: [], styles: [] },
      isEdgeRuntime: true,
      navigationContext: null,
      rscStream: createStream(["flight"]),
      ssrHandler: {
        async handleSsr() {
          return createStream(["<html>page</html>"]);
        },
      },
      status: 200,
    });

    expect(response.headers.get("x-edge-runtime")).toBe("1");
  });

  it("omits the `x-edge-runtime` marker on HTML stream responses for nodejs-runtime routes", async () => {
    const response = await renderAppPageHtmlResponse({
      clearRequestContext: vi.fn(),
      fontData: { links: [], preloads: [], styles: [] },
      navigationContext: null,
      rscStream: createStream(["flight"]),
      ssrHandler: {
        async handleSsr() {
          return createStream(["<html>page</html>"]);
        },
      },
      status: 200,
    });

    expect(response.headers.get("x-edge-runtime")).toBeNull();
  });
});

describe("buildAppPageLinkHeader", () => {
  // Each entry is ~40 chars including the `, ` join.
  const reactEntry = (i: number) => `</r${i}.js>; rel=preload; as=script`;
  const fontEntry = (i: number) => `</f${i}.woff2>; rel=preload; as=font`;

  it("combines React preloads first, then font preloads", () => {
    const header = buildAppPageLinkHeader(reactEntry(1), fontEntry(1), 6000);
    expect(header).toBe(`${reactEntry(1)}, ${fontEntry(1)}`);
  });

  it("returns an empty string when the cap is 0 (emission disabled)", () => {
    expect(buildAppPageLinkHeader(reactEntry(1), fontEntry(1), 0)).toBe("");
  });

  it("defaults to a 6000-char cap when no limit is supplied", () => {
    const react = [reactEntry(1), reactEntry(2)].join(", ");
    expect(buildAppPageLinkHeader(react, undefined, undefined)).toBe(react);
  });

  it("drops whole entries once the cap is exceeded (never a partial entry)", () => {
    const react = [reactEntry(1), reactEntry(2), reactEntry(3)].join(", ");
    // Cap fits only the first two entries.
    const limit = reactEntry(1).length + 2 + reactEntry(2).length + 1;
    const header = buildAppPageLinkHeader(react, undefined, limit);
    expect(header.length).toBeLessThanOrEqual(limit);
    expect(header).toBe(`${reactEntry(1)}, ${reactEntry(2)}`);
  });

  it("drops trailing font preloads first under a tight cap (React preloads survive)", () => {
    const limit = reactEntry(1).length + 2; // room for one entry only
    const header = buildAppPageLinkHeader(reactEntry(1), fontEntry(1), limit);
    expect(header).toBe(reactEntry(1));
  });

  it("ignores empty sources", () => {
    expect(buildAppPageLinkHeader("", fontEntry(1), 6000)).toBe(fontEntry(1));
    expect(buildAppPageLinkHeader(undefined, undefined, 6000)).toBe("");
  });
});
