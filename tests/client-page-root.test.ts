import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { makeClientPageSsrSearchParamsThenable } from "../packages/vinext/src/server/app-page-search-params-observation.js";
import { startCandidateSearchParamsGate } from "../packages/vinext/src/server/app-ssr-search-params-gate.js";
import {
  ClientPageRoot,
  createClientPageSearchParams,
} from "../packages/vinext/src/shims/client-page-root.js";
import {
  consumeDynamicUsage,
  consumeRenderRequestApiUsage,
  headersContextFromRequest,
  isRenderDynamicLatched,
  runWithHeadersContext,
} from "../packages/vinext/src/shims/headers.js";
import { setNavigationContext, useSearchParams } from "../packages/vinext/src/shims/navigation.js";

type SearchParamsProps = { searchParams: Promise<Record<string, string | string[]>> };

function ReadingPage({ searchParams }: SearchParamsProps): React.ReactNode {
  const { q } = React.use(searchParams);
  return React.createElement("p", null, `page:${String(q)}`);
}

function IgnoringPage(): React.ReactNode {
  return React.createElement("p", null, "page:static");
}

function SyncReadingPage({ searchParams }: SearchParamsProps): React.ReactNode {
  return React.createElement("p", null, `page:${String(Reflect.get(searchParams, "q"))}`);
}

function SearchValue(): React.ReactNode {
  return React.createElement("p", null, `hook:${useSearchParams().get("q") ?? ""}`);
}

function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  return runWithHeadersContext(
    headersContextFromRequest(new Request("https://example.test/client?q=secret")),
    fn,
  );
}

/** Set up SSR navigation state as handleSsr does for a candidate render. */
function startCandidateSsr(options: { observe: boolean; query?: string }) {
  const searchParams = new URLSearchParams(options.query ?? "q=secret");
  const gate = startCandidateSearchParamsGate();
  setNavigationContext({
    pathname: "/client",
    searchParams,
    params: {},
    searchParamsGate: gate.gate,
    clientPageSearchParams: makeClientPageSsrSearchParamsThenable(searchParams, {
      observe: options.observe,
    }),
  });
  return gate;
}

async function renderPage(
  Component: React.ComponentType<SearchParamsProps>,
  extra?: React.ReactNode,
): Promise<string> {
  const stream = await renderToReadableStream(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(ClientPageRoot, {
        Component: Component as React.ComponentType<Record<string, unknown>>,
        pageProps: { params: Promise.resolve({}) },
      }),
      extra,
    ),
    { onError: () => {} },
  );
  await stream.allReady;
  return new Response(stream).text();
}

afterEach(() => {
  setNavigationContext(null);
});

describe("ClientPageRoot in SSR", () => {
  it("marks a candidate render dynamic when the page reads searchParams", async () => {
    await inRequest(async () => {
      const gate = startCandidateSsr({ observe: true });
      const html = await renderPage(
        ReadingPage,
        React.createElement(
          React.Suspense,
          { fallback: React.createElement("p", null, "fallback") },
          React.createElement(SearchValue),
        ),
      );

      // The read is a dynamic API, so the render won't be stored and the
      // page and useSearchParams() both render the real query.
      expect(html).toContain("page:secret");
      expect(html).toContain("hook:secret");
      expect(gate.gate.decision).toBe("real");
      expect(isRenderDynamicLatched()).toBe(true);
      expect(consumeDynamicUsage()).toBe(true);
      expect(consumeRenderRequestApiUsage()).toContain("searchParams");
    });
  });

  it("marks a synchronous property read dynamic and returns the real value", async () => {
    await inRequest(async () => {
      startCandidateSsr({ observe: true });
      const html = await renderPage(SyncReadingPage);

      expect(html).toContain("page:secret");
      expect(isRenderDynamicLatched()).toBe(true);
    });
  });

  it("leaves a candidate render static when the page never reads searchParams", async () => {
    await inRequest(async () => {
      const gate = startCandidateSsr({ observe: true });
      const html = await renderPage(IgnoringPage);

      expect(html).toContain("page:static");
      expect(html).not.toContain("secret");
      expect(gate.gate.decision).toBeNull();
      expect(isRenderDynamicLatched()).toBe(false);
      expect(consumeDynamicUsage()).toBe(false);
      expect(consumeRenderRequestApiUsage()).not.toContain("searchParams");
    });
  });

  it("hands over the query untracked when observation is off", async () => {
    // force-static: the navigation context already carries an empty query.
    await inRequest(async () => {
      startCandidateSsr({ observe: false, query: "" });
      const html = await renderPage(ReadingPage);

      expect(html).toContain("page:undefined");
      expect(isRenderDynamicLatched()).toBe(false);
      expect(consumeRenderRequestApiUsage()).not.toContain("searchParams");
    });
  });

  it("keeps handing the page the same promise across renders", async () => {
    await inRequest(async () => {
      startCandidateSsr({ observe: true });
      const received: unknown[] = [];
      function RecordingPage({ searchParams }: SearchParamsProps): React.ReactNode {
        received.push(searchParams);
        return null;
      }
      await renderPage(RecordingPage);
      await renderPage(RecordingPage);

      expect(received).toHaveLength(2);
      expect(received[0]).toBe(received[1]);
    });
  });
});

describe("createClientPageSearchParams", () => {
  it("builds a settled promise with the query readable synchronously", async () => {
    const searchParams = createClientPageSearchParams(
      new URLSearchParams("q=one&tag=a&tag=b&status=y&value=z&then=x"),
    );
    const record = await searchParams;

    // use() reads a settled promise without suspending.
    expect(Reflect.get(searchParams, "status")).toBe("fulfilled");
    expect(Reflect.get(searchParams, "value")).toBe(record);
    expect(Reflect.get(searchParams, "q")).toBe("one");
    expect(Reflect.get(searchParams, "tag")).toEqual(["a", "b"]);
    // Names Promise and React rely on keep their meaning, and stay readable
    // once awaited.
    expect(typeof searchParams.then).toBe("function");
    expect(Reflect.get(record, "then")).toBe("x");
    expect(Reflect.get(record, "status")).toBe("y");
    expect(Reflect.get(record, "value")).toBe("z");
    expect(Object.keys(record)).toEqual(["q", "tag", "status", "value", "then"]);
  });

  it("builds an empty record without a query", async () => {
    expect({ ...(await createClientPageSearchParams(null)) }).toEqual({});
  });
});
