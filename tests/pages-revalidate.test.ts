import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { performOnDemandRevalidate } from "../packages/vinext/src/server/pages-revalidate.js";
import {
  PRERENDER_REVALIDATE_HEADER,
  PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER,
} from "../packages/vinext/src/server/isr-cache.js";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";
import { VINEXT_REVALIDATE_HOST_HEADER } from "../packages/vinext/src/server/headers.js";

function stubFetch() {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function firstFetchUrl(fetchMock: ReturnType<typeof stubFetch>): URL {
  return fetchUrlAt(fetchMock, 0);
}

function fetchUrlAt(fetchMock: ReturnType<typeof stubFetch>, index: number): URL {
  const call = fetchMock.mock.calls[index];
  expect(call).toBeDefined();
  const [target] = call!;
  if (typeof target === "string") return new URL(target);
  if (target instanceof URL) return target;
  return new URL(target.url);
}

function fetchRequestAt(fetchMock: ReturnType<typeof stubFetch>, index: number): Request {
  const call = fetchMock.mock.calls[index];
  expect(call).toBeDefined();
  const [target] = call!;
  expect(target).toBeInstanceOf(Request);
  return target as Request;
}

function firstFetchHeaders(fetchMock: ReturnType<typeof stubFetch>): Record<string, string> {
  return fetchHeadersAt(fetchMock, 0);
}

function fetchHeadersAt(
  fetchMock: ReturnType<typeof stubFetch>,
  index: number,
): Record<string, string> {
  const request = fetchMock.mock.calls[index]?.[0];
  if (request instanceof Request) {
    return Object.fromEntries(request.headers.entries());
  }
  const init = fetchMock.mock.calls[index]?.[1];
  expect(init).toBeDefined();
  expect(init!.headers).toBeDefined();
  return init!.headers as Record<string, string>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("performOnDemandRevalidate", () => {
  // Next.js source reference: packages/next/src/server/api-utils/node/api-resolver.ts
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/api-utils/node/api-resolver.ts
  it("keeps protocol-relative revalidation paths on the application origin", async () => {
    const fetchMock = stubFetch();
    const headers = new Headers({ host: "app.local:3000" });

    await performOnDemandRevalidate(headers, "//127.0.0.1:9999/leak");

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = firstFetchUrl(fetchMock);
    expect(url.origin).toBe("http://app.local:3000");
    expect(url.pathname).toBe("//127.0.0.1:9999/leak");
    const request = fetchRequestAt(fetchMock, 0);
    expect(request.method).toBe("HEAD");
    expect(request.redirect).toBe("manual");
    expect(firstFetchHeaders(fetchMock)[PRERENDER_REVALIDATE_HEADER]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps backslash-normalized revalidation paths on the application origin", async () => {
    const fetchMock = stubFetch();
    const headers = new Headers({ host: "app.local:3000" });

    await performOnDemandRevalidate(headers, "/\\127.0.0.1:9999/leak");

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = firstFetchUrl(fetchMock);
    expect(url.origin).toBe("http://app.local:3000");
    expect(url.pathname).toBe("//127.0.0.1:9999/leak");
  });

  it("pins the loopback request to an explicit trusted origin instead of Host", async () => {
    const fetchMock = stubFetch();
    const headers = new Headers({ host: "127.0.0.1:9999" });

    await performOnDemandRevalidate(headers, "/fixed-page", {}, "http://app.local:3000");

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = firstFetchUrl(fetchMock);
    expect(url.href).toBe("http://app.local:3000/fixed-page");
  });

  it("preserves unstable_onlyGenerated on the pinned request", async () => {
    const fetchMock = stubFetch();
    const headers = new Headers({ host: "127.0.0.1:9999" });

    await performOnDemandRevalidate(
      headers,
      "/fixed-page",
      { unstable_onlyGenerated: true },
      "http://app.local:3000",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(firstFetchHeaders(fetchMock)[PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER]).toBe("1");
  });

  it("forwards configured headers without forwarding production credentials by default", async () => {
    const fetchMock = stubFetch();
    const headers = new Headers({
      host: "app.local:3000",
      cookie: "session=private",
      "x-revalidate-token": "allowed",
    });

    await performOnDemandRevalidate(headers, "/fixed-page", {}, undefined, ["x-revalidate-token"]);

    expect(firstFetchHeaders(fetchMock)["x-revalidate-token"]).toBe("allowed");
    expect(firstFetchHeaders(fetchMock).cookie).toBeUndefined();
  });

  it("forwards cookies automatically in development", async () => {
    const fetchMock = stubFetch();
    const headers = new Headers({ host: "app.local:3000", cookie: "session=local" });

    await performOnDemandRevalidate(headers, "/fixed-page", {}, undefined, [], true);

    expect(firstFetchHeaders(fetchMock).cookie).toBe("session=local");
  });

  it("uses the Worker in-process dispatcher instead of global fetch", async () => {
    const fetchMock = stubFetch();
    const dispatchPagesRevalidate = vi.fn(
      async (_request: Request) =>
        new Response(null, {
          status: 200,
          headers: { "x-nextjs-cache": "REVALIDATED" },
        }),
    );

    await runWithExecutionContext(
      {
        waitUntil() {},
        dispatchPagesRevalidate,
      },
      () =>
        performOnDemandRevalidate(new Headers({ host: "public-origin.example" }), "/fixed-page", {
          unstable_onlyGenerated: true,
        }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dispatchPagesRevalidate).toHaveBeenCalledOnce();
    const request = dispatchPagesRevalidate.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect(request?.url).toBe("http://public-origin.example/fixed-page");
    expect(request?.headers.get(PRERENDER_REVALIDATE_HEADER)).toMatch(/^[a-f0-9]{64}$/);
    expect(request?.headers.get(PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER)).toBe("1");
    expect(request?.headers.get(VINEXT_REVALIDATE_HOST_HEADER)).toBeNull();
  });

  it("rejects nested internal revalidation dispatch", async () => {
    const dispatchPagesRevalidate = vi.fn(
      async (_request: Request) => new Response(null, { status: 200 }),
    );

    await expect(
      runWithExecutionContext(
        {
          waitUntil() {},
          dispatchPagesRevalidate,
          isInternalPagesRevalidation: true,
        },
        () => performOnDemandRevalidate(new Headers({ host: "app.local" }), "/fixed-page"),
      ),
    ).rejects.toThrow("from an internal revalidation request");
    expect(dispatchPagesRevalidate).not.toHaveBeenCalled();
  });

  it("does not follow config redirects and rejects their non-revalidated status", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 307,
        headers: { location: "/redirected-page" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const headers = new Headers({ host: "app.local:3000" });

    await expect(performOnDemandRevalidate(headers, "/fixed-page")).rejects.toThrow(
      "Failed to revalidate /fixed-page: 307",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchUrlAt(fetchMock, 0).href).toBe("http://app.local:3000/fixed-page");
  });

  it("accepts a terminal external GSP redirect marked REVALIDATED without following it", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: {
            location: "https://outside.example/destination",
            "x-nextjs-cache": "REVALIDATED",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const headers = new Headers({ host: "app.local:3000" });

    await performOnDemandRevalidate(headers, "/fixed-page");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchUrlAt(fetchMock, 0).href).toBe("http://app.local:3000/fixed-page");
  });
});
