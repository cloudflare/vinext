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
function startCandidateSsr(options?: { isPprFallbackShell?: boolean }) {
  const searchParams = new URLSearchParams("q=secret");
  const gate = startCandidateSearchParamsGate();
  setNavigationContext({
    pathname: "/client",
    searchParams,
    params: {},
    searchParamsGate: gate.gate,
    clientPageSearchParams: makeClientPageSsrSearchParamsThenable(searchParams, {
      isPprFallbackShell: options?.isPprFallbackShell,
    }),
  });
  return gate;
}

async function renderPage(
  Component: React.ComponentType<SearchParamsProps>,
  extra?: React.ReactNode,
  rootProps?: { emptySearchParams?: boolean },
): Promise<string> {
  const stream = await renderToReadableStream(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(ClientPageRoot, {
        Component: Component as React.ComponentType<Record<string, unknown>>,
        pageProps: { params: Promise.resolve({}) },
        ...rootProps,
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
      const gate = startCandidateSsr();
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
      startCandidateSsr();
      const html = await renderPage(SyncReadingPage);

      expect(html).toContain("page:secret");
      expect(isRenderDynamicLatched()).toBe(true);
    });
  });

  it("leaves a candidate render static when the page never reads searchParams", async () => {
    await inRequest(async () => {
      const gate = startCandidateSsr();
      const html = await renderPage(IgnoringPage);

      expect(html).toContain("page:static");
      expect(html).not.toContain("secret");
      expect(gate.gate.decision).toBeNull();
      expect(isRenderDynamicLatched()).toBe(false);
      expect(consumeDynamicUsage()).toBe(false);
      expect(consumeRenderRequestApiUsage()).not.toContain("searchParams");
    });
  });

  it("hands a force-static page an empty, untracked query", async () => {
    await inRequest(async () => {
      startCandidateSsr();
      const html = await renderPage(ReadingPage, null, { emptySearchParams: true });

      expect(html).toContain("page:undefined");
      expect(html).not.toContain("secret");
      expect(isRenderDynamicLatched()).toBe(false);
      expect(consumeRenderRequestApiUsage()).not.toContain("searchParams");
    });
  });

  it("hands a PPR fallback shell its query untracked", async () => {
    await inRequest(async () => {
      startCandidateSsr({ isPprFallbackShell: true });
      const html = await renderPage(ReadingPage);

      expect(html).toContain("page:secret");
      expect(isRenderDynamicLatched()).toBe(false);
      expect(consumeRenderRequestApiUsage()).not.toContain("searchParams");
    });
  });

  it("observes a force-static navigation context's query untracked", async () => {
    // handleSsr's own force-static guard, behind the page's emptySearchParams.
    await inRequest(async () => {
      const searchParams = makeClientPageSsrSearchParamsThenable(new URLSearchParams(), {
        isForceStatic: true,
      });

      expect({ ...(await searchParams) }).toEqual({});
      expect(isRenderDynamicLatched()).toBe(false);
      expect(consumeRenderRequestApiUsage()).not.toContain("searchParams");
    });
  });

  it("keeps handing the page the same promise across renders", async () => {
    await inRequest(async () => {
      startCandidateSsr();
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

  it("enumerates like the SSR thenable, so hydration sees the same keys", async () => {
    const query = "q=one&status=y&value=z&then=x&constructor=c&tag=a&tag=b";
    const browser = createClientPageSearchParams(new URLSearchParams(query));
    const ssr = makeClientPageSsrSearchParamsThenable(new URLSearchParams(query), {
      isPprFallbackShell: true,
    });

    // React's bookkeeping and the reserved names aren't query keys.
    expect(Object.keys(browser)).toEqual(["q", "tag"]);
    expect(Object.keys(browser)).toEqual(Object.keys(ssr));
    // What `{ ...searchParams }` copies.
    expect(Object.entries(browser)).toEqual(Object.entries(ssr));
    expect({ ...(await browser) }).toEqual({ ...(await ssr) });
  });

  it("resolves to a plain object, like the SSR thenable", async () => {
    const record = await createClientPageSearchParams(new URLSearchParams("q=one&__proto__=x"));
    const ssrRecord = await makeClientPageSsrSearchParamsThenable(
      new URLSearchParams("q=one&__proto__=x"),
      { isPprFallbackShell: true },
    );

    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(record)).toBe(Object.getPrototypeOf(ssrRecord));
    expect(record.hasOwnProperty("q")).toBe(true);
    // A `__proto__` key stays an ordinary entry.
    expect(Object.keys(record)).toEqual(["q", "__proto__"]);
    expect(Object.getOwnPropertyDescriptor(record, "__proto__")?.value).toBe("x");
  });

  it("stays awaitable with a query key named constructor", async () => {
    const searchParams = createClientPageSearchParams(new URLSearchParams("constructor=c&q=one"));

    expect(searchParams.constructor).toBe(Promise);
    const record = await searchParams;
    expect(Reflect.get(record, "constructor")).toBe("c");
    expect(Reflect.get(record, "q")).toBe("one");
  });
});
