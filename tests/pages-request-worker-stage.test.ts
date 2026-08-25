import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { handleRequestStage } from "../packages/vinext/src/server/pages-request-stage-entry.js";
import worker from "../packages/vinext/src/server/pages-router-entry.js";
import { PAGES_RESPONSE_STAGE_PROTOCOL_VERSION } from "../packages/vinext/src/server/worker-stages.js";
import type { DispatchWorkerResponseStage } from "../packages/vinext/src/server/worker-stages.js";
import type { MiddlewareResult } from "../packages/vinext/src/server/pages-request-pipeline.js";

const mocks = vi.hoisted(() => ({
  authorizeOnDemandRevalidate: vi.fn<(value: string | null) => boolean>(() => false),
  matchApiRoute: vi.fn((url: string) =>
    url === "/api/hello"
      ? { route: { dataKind: "dynamic", isDynamic: false, pattern: "/api/hello" } }
      : null,
  ),
  registerCacheAdapters: vi.fn(),
  registerImageOptimizer: vi.fn(),
  renderResponse: vi.fn(),
  normalizeDataRequest: vi.fn((request: Request) => ({
    isDataReq: false,
    normalizedPathname: null as string | null,
    notFoundResponse: null,
    request,
  })),
  runMiddleware: vi.fn<() => Promise<MiddlewareResult>>(async () => ({ continue: true })),
}));

vi.mock("virtual:vinext-cache-adapters", () => ({
  registerConfiguredCacheAdapters: mocks.registerCacheAdapters,
}));

vi.mock("virtual:vinext-image-adapters", () => ({
  registerConfiguredImageOptimizer: mocks.registerImageOptimizer,
}));

vi.mock("virtual:vinext-pages-request-entry", () => ({
  authorizeOnDemandRevalidate: mocks.authorizeOnDemandRevalidate,
  buildId: "request-build",
  hasMiddleware: false,
  matchApiRoute: mocks.matchApiRoute,
  matchPageRoute: vi.fn(() => ({
    route: { dataKind: "static", isDynamic: false, pattern: "/page" },
  })),
  normalizeDataRequest: mocks.normalizeDataRequest,
  publicFiles: new Set(),
  runMiddleware: mocks.runMiddleware,
  vinextConfig: {},
}));

vi.mock("../packages/vinext/src/server/pages-response-stage-entry.js", () => ({
  renderPagesResponse: mocks.renderResponse,
}));

describe("Pages Worker request stage", () => {
  beforeEach(() => {
    mocks.authorizeOnDemandRevalidate.mockReset();
    mocks.authorizeOnDemandRevalidate.mockReturnValue(false);
    mocks.matchApiRoute.mockReset();
    mocks.matchApiRoute.mockImplementation((url: string) =>
      url === "/api/hello"
        ? { route: { dataKind: "dynamic", isDynamic: false, pattern: "/api/hello" } }
        : null,
    );
    mocks.registerCacheAdapters.mockReset();
    mocks.registerImageOptimizer.mockReset();
    mocks.renderResponse.mockReset();
    mocks.renderResponse.mockResolvedValue(new Response("local"));
    mocks.normalizeDataRequest.mockReset();
    mocks.normalizeDataRequest.mockImplementation((request: Request) => ({
      isDataReq: false,
      normalizedPathname: null,
      notFoundResponse: null,
      request,
    }));
    mocks.runMiddleware.mockReset();
    mocks.runMiddleware.mockResolvedValue({ continue: true });
  });

  it("dispatches an ordinary page with a versioned build envelope", async () => {
    const dispatch = vi.fn<DispatchWorkerResponseStage>(async () => new Response("remote"));
    const response = await handleRequestStage(
      new Request("https://example.com/page"),
      undefined,
      undefined,
      dispatch,
    );

    await expect(response.text()).resolves.toBe("remote");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.any(Request),
      {
        buildId: "request-build",
        kind: "pages-page",
        protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
        requestHost: "example.com",
        renderOptions: null,
        resolvedUrl: "/page",
        stagedHeaders: null,
      },
      { cache: "shared" },
    );
    expect(mocks.renderResponse).not.toHaveBeenCalled();
  });

  it("dispatches a preview request through the non-shared response stage", async () => {
    const request = new Request("https://example.com/page", {
      headers: { Cookie: "__prerender_bypass=preview" },
    });
    const dispatch = vi.fn<DispatchWorkerResponseStage>(async () => new Response("remote"));

    const response = await handleRequestStage(request, undefined, undefined, dispatch);

    await expect(response.text()).resolves.toBe("remote");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.any(Request),
      {
        buildId: "request-build",
        kind: "pages-page",
        protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
        requestHost: "example.com",
        renderOptions: null,
        resolvedUrl: "/page",
        stagedHeaders: [],
      },
      { cache: "bypass" },
    );
    expect(mocks.renderResponse).not.toHaveBeenCalled();
  });

  it("dispatches authenticated revalidation through the uncached response stage", async () => {
    mocks.authorizeOnDemandRevalidate.mockImplementation((value) => value === "build-secret");
    const dispatch = vi.fn<DispatchWorkerResponseStage>(async () => new Response(null));

    await handleRequestStage(
      new Request("https://example.com/page", {
        headers: {
          "x-prerender-revalidate": "build-secret",
          "x-prerender-revalidate-if-generated": "1",
        },
        method: "HEAD",
      }),
      undefined,
      undefined,
      dispatch,
    );

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0].method).toBe("HEAD");
    expect(dispatch.mock.calls[0]?.[0].headers.get("x-prerender-revalidate-if-generated")).toBe(
      "1",
    );
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
      kind: "pages-page",
      stagedHeaders: [],
    });
    expect(dispatch.mock.calls[0]?.[2]).toEqual({ cache: "bypass" });
  });

  it("normalizes shared HEAD requests to the HTML GET generation and strips the body", async () => {
    const dispatch = vi.fn<DispatchWorkerResponseStage>(
      async () => new Response("cached-html", { headers: { "x-generation": "one" } }),
    );

    const response = await handleRequestStage(
      new Request("https://example.com/page", { method: "HEAD" }),
      undefined,
      undefined,
      dispatch,
    );

    expect(dispatch.mock.calls[0]?.[0].method).toBe("GET");
    expect(dispatch.mock.calls[0]?.[2]).toEqual({ cache: "shared" });
    expect(response.headers.get("x-generation")).toBe("one");
    expect(response.body).toBeNull();
  });

  it("preserves request-stage URL normalization for data requests", async () => {
    mocks.normalizeDataRequest.mockImplementation((request: Request) => {
      const url = new URL(request.url);
      url.pathname = "/page";
      return {
        isDataReq: true,
        normalizedPathname: "/page",
        notFoundResponse: null,
        request: new Request(url, request),
      };
    });
    const dispatch = vi.fn<DispatchWorkerResponseStage>(async () => new Response("data"));

    await handleRequestStage(
      new Request("https://example.com/_next/data/request-build/page.json?from=data"),
      undefined,
      undefined,
      dispatch,
    );

    expect(new URL(dispatch.mock.calls[0]![0].url).pathname).toBe("/page");
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
      renderOptions: { isDataReq: true },
      resolvedUrl: "/page?from=data",
    });
    expect(dispatch.mock.calls[0]?.[2]).toEqual({ cache: "shared" });
  });

  it("dispatches a GET API with the same deployment envelope", async () => {
    const dispatch = vi.fn<DispatchWorkerResponseStage>(async () => new Response("api"));

    await handleRequestStage(
      new Request("https://example.com/api/hello"),
      undefined,
      undefined,
      dispatch,
    );

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.any(Request),
      {
        apiUrl: "/api/hello",
        buildId: "request-build",
        kind: "pages-api",
        protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
        requestHost: "example.com",
        stagedHeaders: null,
      },
      { cache: "shared" },
    );
  });

  it("dispatches non-idempotent APIs with cache bypass", async () => {
    const dispatch = vi.fn<DispatchWorkerResponseStage>(async () => new Response("api"));

    await handleRequestStage(
      new Request("https://example.com/api/hello", { method: "POST", body: "payload" }),
      undefined,
      undefined,
      dispatch,
    );

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.any(Request),
      {
        apiUrl: "/api/hello",
        buildId: "request-build",
        kind: "pages-api",
        protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
        requestHost: "example.com",
        stagedHeaders: [],
      },
      { cache: "bypass" },
    );
    expect(mocks.renderResponse).not.toHaveBeenCalled();
  });

  it("carries nonce-sensitive staged headers through bypass dispatch", async () => {
    const responseHeaders = new Headers({
      "Content-Security-Policy": "script-src 'nonce-request-stage'",
      "Set-Cookie": "middleware=one; Path=/",
    });
    responseHeaders.append("Set-Cookie", "second=two; Path=/");
    mocks.runMiddleware.mockResolvedValue({ continue: true, responseHeaders });
    const dispatch = vi.fn<DispatchWorkerResponseStage>(async () => new Response("remote"));

    const response = await handleRequestStage(
      new Request("https://example.com/page"),
      undefined,
      undefined,
      dispatch,
    );

    expect(dispatch).toHaveBeenCalledOnce();
    const props = dispatch.mock.calls[0]?.[1];
    expect(props).toMatchObject({ kind: "pages-page" });
    expect(new Headers(props?.stagedHeaders ?? [])).toEqual(responseHeaders);
    expect(dispatch.mock.calls[0]?.[2]).toEqual({ cache: "bypass" });
    expect(response.headers.get("content-security-policy")).toBe(
      "script-src 'nonce-request-stage'",
    );
    expect(response.headers.getSetCookie()).toEqual([
      "middleware=one; Path=/",
      "second=two; Path=/",
    ]);
    expect(mocks.renderResponse).not.toHaveBeenCalled();
  });

  it("keeps the default Pages worker behavior via lazy local rendering", async () => {
    const response = await worker.fetch(new Request("https://example.com/page"));

    await expect(response.text()).resolves.toBe("local");
    expect(mocks.renderResponse).toHaveBeenCalledOnce();
  });
});
