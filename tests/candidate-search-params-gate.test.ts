import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { startCandidateSearchParamsGate } from "../packages/vinext/src/server/app-ssr-search-params-gate.js";
import {
  consumeDynamicUsage,
  headersContextFromRequest,
  markDynamicUsage,
  runWithHeadersContext,
  runWithIsolatedDynamicUsage,
} from "../packages/vinext/src/shims/headers.js";
import {
  isBailoutToCSRError,
  setNavigationContext,
  useSearchParams,
} from "../packages/vinext/src/shims/navigation.js";

const QUERY = "q=secret";

function SearchValue(props: { id: string }): React.ReactNode {
  const searchParams = useSearchParams();
  return React.createElement("p", { id: props.id }, `value:${searchParams.get("q") ?? ""}`);
}

function wrapped(id = "search"): React.ReactNode {
  return React.createElement(
    React.Suspense,
    { fallback: React.createElement("p", null, `fallback:${id}`) },
    React.createElement(SearchValue, { id }),
  );
}

type GatedRender = {
  gate: ReturnType<typeof startCandidateSearchParamsGate>["gate"];
  /** Read the Flight stream to its end, which settles the render. */
  settle(): Promise<void>;
};

/** Start a candidate render's gate, as handleSsr does, with a stub Flight stream. */
function startGatedRender(): GatedRender {
  const { gate, settleWhenConsumed } = startCandidateSearchParamsGate();
  let closeFlight!: () => void;
  const flight = settleWhenConsumed(
    new ReadableStream<Uint8Array>({
      start(controller) {
        closeFlight = () => controller.close();
      },
    }),
  );
  setNavigationContext({
    pathname: "/search",
    searchParams: new URLSearchParams(QUERY),
    params: {},
    searchParamsGate: gate,
  });
  return {
    gate,
    async settle() {
      closeFlight();
      const reader = flight.getReader();
      while (!(await reader.read()).done) {
        // drain
      }
    },
  };
}

async function readHtml(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  return runWithHeadersContext(
    headersContextFromRequest(new Request(`https://example.test/search?${QUERY}`)),
    fn,
  );
}

afterEach(() => {
  setNavigationContext(null);
});

describe("candidate render useSearchParams() gate", () => {
  it("bails out to the Suspense fallback when the render settles static", async () => {
    await inRequest(async () => {
      const render = startGatedRender();
      const stream = await renderToReadableStream(wrapped(), { onError: () => {} });
      await render.settle();
      await stream.allReady;
      const html = await readHtml(stream);

      expect(render.gate.decision).toBe("bailout");
      expect(html).toContain("fallback:search");
      expect(html).not.toContain("secret");
      expect(consumeDynamicUsage()).toBe(false);
    });
  });

  it("fails the shell when an unwrapped call bails out", async () => {
    await inRequest(async () => {
      const render = startGatedRender();
      const shell = renderToReadableStream(React.createElement(SearchValue, { id: "search" }), {
        onError: () => {},
      });
      await render.settle();

      const error = await shell.then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(isBailoutToCSRError(error)).toBe(true);
    });
  });

  it("reads the real query when the render is already dynamic", async () => {
    await inRequest(async () => {
      markDynamicUsage();
      const render = startGatedRender();
      expect(render.gate.decision).toBe("real");

      const stream = await renderToReadableStream(wrapped(), { onError: () => {} });
      await stream.allReady;
      expect(await readHtml(stream)).toContain("value:secret");
      await render.settle();
    });
  });

  it("reads the real query once the render turns dynamic while waiting", async () => {
    await inRequest(async () => {
      const render = startGatedRender();
      const stream = await renderToReadableStream(wrapped(), { onError: () => {} });
      // A server component below the shell reads cookies().
      markDynamicUsage();
      await render.settle();
      await stream.allReady;

      expect(render.gate.decision).toBe("real");
      expect(await readHtml(stream)).toContain("value:secret");
    });
  });

  it("sees dynamic usage consumed at the shell before the gate starts", async () => {
    await inRequest(async () => {
      markDynamicUsage();
      expect(consumeDynamicUsage()).toBe(true);
      const render = startGatedRender();
      expect(render.gate.decision).toBe("real");
      await render.settle();
    });
  });

  it("sees dynamic usage inside an isolated scope", async () => {
    await inRequest(async () => {
      const render = startGatedRender();
      await runWithIsolatedDynamicUsage(async () => {
        markDynamicUsage();
      });
      expect(render.gate.decision).toBe("real");
      await render.settle();
    });
  });

  it("marks the render dynamic when it opens the gate", async () => {
    await inRequest(async () => {
      markDynamicUsage();
      consumeDynamicUsage();
      const render = startGatedRender();
      // The consumed flag is set again, so the render is never stored.
      expect(consumeDynamicUsage()).toBe(true);
      await render.settle();
    });
  });

  it("keeps the fallback when the render turns dynamic after it settles", async () => {
    await inRequest(async () => {
      const render = startGatedRender();
      const stream = await renderToReadableStream(wrapped(), { onError: () => {} });
      await render.settle();
      markDynamicUsage();
      await stream.allReady;

      expect(render.gate.decision).toBe("bailout");
      expect(await readHtml(stream)).toContain("fallback:search");
      expect(consumeDynamicUsage()).toBe(true);
    });
  });

  it("follows a decision made before the call", async () => {
    await inRequest(async () => {
      const render = startGatedRender();
      await render.settle();
      const stream = await renderToReadableStream(wrapped(), { onError: () => {} });
      await stream.allReady;
      expect(await readHtml(stream)).toContain("fallback:search");
    });
  });

  it("bails out every call, including nested boundaries", async () => {
    await inRequest(async () => {
      const render = startGatedRender();
      const tree = React.createElement(
        React.Suspense,
        { fallback: React.createElement("p", null, "fallback:outer") },
        React.createElement(SearchValue, { id: "outer" }),
        wrapped("inner"),
      );
      const stream = await renderToReadableStream(tree, { onError: () => {} });
      await render.settle();
      await stream.allReady;
      const html = await readHtml(stream);

      expect(html).toContain("fallback:outer");
      expect(html).not.toContain("secret");
    });
  });

  it("opens, rather than bails out, when SSR cancels the Flight stream", async () => {
    await inRequest(async () => {
      const { gate, settleWhenConsumed } = startCandidateSearchParamsGate();
      const flight = settleWhenConsumed(new ReadableStream<Uint8Array>());
      await flight.cancel();
      expect(gate.decision).toBe("real");
      expect(consumeDynamicUsage()).toBe(true);
    });
  });

  it("keeps a Flight failure instead of turning it into a bailout", async () => {
    await inRequest(async () => {
      const { gate, settleWhenConsumed } = startCandidateSearchParamsGate();
      const failure = new Error("flight failed");
      const flight = settleWhenConsumed(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(failure);
          },
        }),
      );
      await expect(flight.getReader().read()).rejects.toBe(failure);
      expect(gate.decision).toBe("real");
      expect(consumeDynamicUsage()).toBe(true);
    });
  });
});
