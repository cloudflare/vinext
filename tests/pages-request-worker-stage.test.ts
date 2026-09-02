import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { handleRequestStage } from "../packages/vinext/src/server/pages-request-stage-entry.js";
import worker from "../packages/vinext/src/server/pages-router-entry.js";
import { PAGES_RESPONSE_STAGE_PROTOCOL_VERSION } from "../packages/vinext/src/server/worker-stages.js";
import type { DispatchWorkerResponseStage } from "../packages/vinext/src/server/worker-stages.js";
import type { MiddlewareResult } from "../packages/vinext/src/server/pages-request-pipeline.js";
import {
  runWithExecutionContext,
  type ExecutionContextLike,
} from "../packages/vinext/src/shims/request-context.js";
import {
  CACHEABILITY_REQUEST_STATE,
  type RouteCacheabilityState,
} from "../packages/vinext/src/shims/cacheability-classification.js";
import {
  DefaultCdnCacheAdapter,
  setCdnCacheAdapter,
  type CdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";

const mocks = vi.hoisted(() => ({
  authorizeOnDemandRevalidate: vi.fn<(value: string | null) => boolean>(() => false),
  configHeaders: [] as Array<Record<string, unknown>>,
  matchApiRoute: vi.fn((url: string) =>
    url === "/api/hello"
      ? { route: { dataKind: "dynamic", isDynamic: false, pattern: "/api/hello" } }
      : null,
  ),
  matchPageRoute: vi.fn((url: string) => ({
    route: {
      dataKind: url.startsWith("/gssp") ? "server" : "static",
      isDynamic: false,
      pattern: url.startsWith("/gssp") ? "/gssp" : "/page",
    },
  })),
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

function cacheabilityContext(state: RouteCacheabilityState): ExecutionContextLike {
  const context: ExecutionContextLike = { waitUntil() {} };
  Reflect.set(context, CACHEABILITY_REQUEST_STATE, state);
  return context;
}

vi.mock("virtual:vinext-cache-adapters", () => ({
  registerConfiguredCacheAdapters: mocks.registerCacheAdapters,
}));

vi.mock("virtual:vinext-image-adapters", () => ({
  registerConfiguredImageOptimizer: mocks.registerImageOptimizer,
}));

vi.mock("virtual:vinext-cacheability-manifest", () => ({ default: null }));

vi.mock("virtual:vinext-pages-request-entry", () => ({
  authorizeOnDemandRevalidate: mocks.authorizeOnDemandRevalidate,
  buildId: "request-build",
  hasMiddleware: false,
  matchApiRoute: mocks.matchApiRoute,
  matchPageRoute: mocks.matchPageRoute,
  normalizeDataRequest: mocks.normalizeDataRequest,
  prerenderSecret: "prerender-secret",
  publicFiles: new Set(),
  runMiddleware: mocks.runMiddleware,
  vinextConfig: {
    headers: mocks.configHeaders,
    i18n: { defaultLocale: "en", locales: ["en", "fr"] },
  },
}));

vi.mock("../packages/vinext/src/server/pages-response-stage-entry.js", () => ({
  renderPagesResponse: mocks.renderResponse,
}));

describe("Pages Worker request stage", () => {
  beforeEach(() => {
    setCdnCacheAdapter(new DefaultCdnCacheAdapter());
    mocks.authorizeOnDemandRevalidate.mockReset();
    mocks.authorizeOnDemandRevalidate.mockReturnValue(false);
    mocks.matchApiRoute.mockReset();
    mocks.matchPageRoute.mockClear();
    mocks.configHeaders.length = 0;
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
        cacheability: { policyHeaders: null, probeMode: null, resolvedRoutePathname: "/page" },
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

  it("keeps pathname-eligible middleware outside shared-stage classification", async () => {
    mocks.runMiddleware.mockResolvedValue({ continue: true, pathnameEligible: true });
    const dispatch = vi.fn<DispatchWorkerResponseStage>(async () => new Response("remote"));
    const state: RouteCacheabilityState = {
      captureDeadlineAt: Date.now() + 1_000,
      mode: "admit",
    };

    await runWithExecutionContext(cacheabilityContext(state), () =>
      handleRequestStage(new Request("https://example.com/page"), undefined, undefined, dispatch),
    );

    expect(dispatch.mock.calls[0]?.[2]).toEqual({ cache: "shared" });
    expect(state.forcedDynamicReason).toBeUndefined();
  });

  it.each(["/page", "/api/hello"])(
    "bypasses shared %s rendering when middleware changes downstream request headers",
    async (pathname) => {
      // Ported from Next.js:
      // test/e2e/middleware-request-header-overrides/test/index.test.ts
      // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-request-header-overrides/test/index.test.ts
      mocks.runMiddleware.mockResolvedValue({
        continue: true,
        responseHeaders: new Headers({
          "x-middleware-override-headers": "x-visitor",
          "x-middleware-request-x-visitor": "visitor-a",
        }),
      });
      const dispatch = vi.fn<DispatchWorkerResponseStage>(async (request) =>
        Response.json({ visitor: request.headers.get("x-visitor") }),
      );

      const response = await handleRequestStage(
        new Request(`https://example.com${pathname}`),
        undefined,
        undefined,
        dispatch,
      );

      expect(dispatch.mock.calls[0]?.[2]).toEqual({ cache: "bypass" });
      await expect(response.json()).resolves.toEqual({ visitor: "visitor-a" });
    },
  );

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
        cacheability: { policyHeaders: null, probeMode: null, resolvedRoutePathname: "/page" },
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

  it("authenticates probes before filtering and bypasses the shared transport", async () => {
    const dispatch = vi.fn<DispatchWorkerResponseStage>(async () => new Response("probe"));
    const response = await handleRequestStage(
      new Request("https://example.com/page?__vinext_cacheability_probe=retry", {
        headers: {
          "X-Vinext-Cacheability-Probe": "1",
          "X-Vinext-Prerender-Secret": "prerender-secret",
        },
      }),
      undefined,
      undefined,
      dispatch,
    );

    await expect(response.text()).resolves.toBe("probe");
    expect(dispatch).toHaveBeenCalledOnce();
    const [request, props, options] = dispatch.mock.calls[0]!;
    expect(new URL(request.url).searchParams.has("__vinext_cacheability_probe")).toBe(false);
    expect(request.headers.has("X-Vinext-Cacheability-Probe")).toBe(false);
    expect(request.headers.has("X-Vinext-Prerender-Secret")).toBe(false);
    expect(props.cacheability).toMatchObject({
      policyHeaders: null,
      probeMode: "probe",
      resolvedRoutePathname: "/page",
    });
    expect(options).toEqual({ cache: "bypass" });
  });

  it("transports matched positive config cache policy using the i18n match path", async () => {
    setCdnCacheAdapter({
      buildResponseHeaders: ({ cacheControl }) => ({ "Cache-Control": cacheControl }),
      ownsBackgroundRevalidation: false,
      responsePolicyHeaderNames: ["CDN-Cache-Control"],
      async get() {
        return null;
      },
      async revalidateTag() {},
      async set() {},
    });
    mocks.configHeaders.push(
      {
        source: "/en/gssp",
        headers: [
          { key: "Cache-Control", value: "public, s-maxage=60" },
          { key: "Vary", value: "x-visitor" },
        ],
      },
      {
        source: "/en/gssp",
        has: [{ type: "cookie", key: "preview", value: "1" }],
        headers: [
          { key: "CDN-Cache-Control", value: "public, s-maxage=120" },
          { key: "x-config-variant", value: "preview" },
        ],
      },
    );
    const dispatch = vi.fn<DispatchWorkerResponseStage>(async () => new Response("page"));

    const state: RouteCacheabilityState = {
      captureDeadlineAt: Date.now() + 1_000,
      mode: "admit",
    };
    await runWithExecutionContext(cacheabilityContext(state), () =>
      handleRequestStage(
        new Request("https://example.com/gssp", { headers: { Cookie: "preview=1" } }),
        undefined,
        undefined,
        dispatch,
      ),
    );

    expect(dispatch.mock.calls[0]?.[1].cacheability.policyHeaders).toEqual([
      ["Cache-Control", "public, s-maxage=60"],
      ["CDN-Cache-Control", "public, s-maxage=120"],
      ["Vary", "x-visitor"],
    ]);
    expect(new Headers(dispatch.mock.calls[0]?.[1].stagedHeaders ?? [])).toEqual(
      new Headers({
        "Cache-Control": "public, s-maxage=60",
        "CDN-Cache-Control": "public, s-maxage=120",
        Vary: "x-visitor",
        "x-config-variant": "preview",
      }),
    );
    expect(state.forcedDynamicReason).toBeUndefined();
  });

  it("transports middleware Vary into the shared stage cache identity", async () => {
    mocks.runMiddleware.mockResolvedValue({
      continue: true,
      responseHeaders: new Headers({ Vary: "x-visitor" }),
    });
    const dispatch = vi.fn<DispatchWorkerResponseStage>(async () => new Response("page"));

    await handleRequestStage(
      new Request("https://example.com/page", { headers: { "x-visitor": "one" } }),
      undefined,
      undefined,
      dispatch,
    );

    expect(dispatch.mock.calls[0]?.[1].cacheability.policyHeaders).toEqual([["Vary", "x-visitor"]]);
    expect(dispatch.mock.calls[0]?.[2]).toEqual({ cache: "shared" });
  });

  it("lets an outer private config policy override a shared Pages artifact", async () => {
    const adapter: CdnCacheAdapter = {
      ownsBackgroundRevalidation: false,
      responsePolicyHeaderNames: ["CDN-Cache-Control"],
      buildResponseHeaders({ cacheControl }) {
        return {
          "Cache-Control": cacheControl,
          "CDN-Cache-Control": null,
        };
      },
      async get() {
        return null;
      },
      async revalidateTag() {},
      async set() {},
    };
    setCdnCacheAdapter(adapter);
    mocks.configHeaders.push({
      source: "/en/page",
      headers: [{ key: "Cache-Control", value: "private, no-store" }],
    });
    const dispatch = vi.fn<DispatchWorkerResponseStage>(async () =>
      Promise.resolve(
        new Response("cached page", {
          headers: {
            "Cache-Control": "public, max-age=0, must-revalidate",
            "CDN-Cache-Control": "public, max-age=60",
          },
        }),
      ),
    );

    const response = await handleRequestStage(
      new Request("https://example.com/page"),
      undefined,
      undefined,
      dispatch,
    );

    expect(dispatch.mock.calls[0]?.[2]).toEqual({ cache: "shared" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cdn-cache-control")).toBeNull();
    await expect(response.text()).resolves.toBe("cached page");
  });

  // Next.js installs custom-route headers before invoking Pages handlers, so
  // getServerSideProps remains authoritative when it writes the same header.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/router-server.ts
  it("lets getServerSideProps override an earlier private config policy", async () => {
    mocks.configHeaders.push({
      source: "/en/gssp",
      headers: [{ key: "Cache-Control", value: "private, no-store" }],
    });
    const dispatch = vi.fn<DispatchWorkerResponseStage>(async () =>
      Promise.resolve(
        new Response("gssp", {
          headers: { "Cache-Control": "public, s-maxage=30" },
        }),
      ),
    );

    const response = await handleRequestStage(
      new Request("https://example.com/gssp"),
      undefined,
      undefined,
      dispatch,
    );

    expect(dispatch.mock.calls[0]?.[2]).toEqual({ cache: "shared" });
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=30");
  });

  it.each([
    ["private, no-store", "public, s-maxage=30"],
    ["public, s-maxage=60", "private, no-store"],
  ])(
    "lets getInitialProps replace config policy %s with %s",
    async (configPolicy, renderedPolicy) => {
      // Next.js applies custom-route headers before Pages rendering, so page
      // and _app getInitialProps response writes remain authoritative.
      // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/router-server.ts
      mocks.matchPageRoute.mockReturnValue({
        route: { dataKind: "initial", isDynamic: false, pattern: "/gip" },
      });
      mocks.configHeaders.push({
        source: "/en/gip",
        headers: [{ key: "Cache-Control", value: configPolicy }],
      });
      const dispatch = vi.fn<DispatchWorkerResponseStage>(async () =>
        Promise.resolve(
          new Response("gip", {
            headers: { "Cache-Control": renderedPolicy },
          }),
        ),
      );

      const response = await handleRequestStage(
        new Request("https://example.com/gip"),
        undefined,
        undefined,
        dispatch,
      );

      expect(dispatch.mock.calls[0]?.[2]).toEqual({ cache: "shared" });
      expect(response.headers.get("Cache-Control")).toBe(renderedPolicy);
    },
  );

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

  it("preserves shared Pages HEAD request semantics and strips the body", async () => {
    const dispatch = vi.fn<DispatchWorkerResponseStage>(
      async () => new Response("cached-html", { headers: { "x-generation": "one" } }),
    );

    const response = await handleRequestStage(
      new Request("https://example.com/page", { method: "HEAD" }),
      undefined,
      undefined,
      dispatch,
    );

    expect(dispatch.mock.calls[0]?.[0].method).toBe("HEAD");
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
      cacheability: { representation: "pages-data" },
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
        cacheability: {
          policyHeaders: null,
          probeMode: null,
          resolvedRoutePathname: "/api/hello",
        },
        kind: "pages-api",
        protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
        requestHost: "example.com",
        stagedHeaders: [],
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
        cacheability: {
          policyHeaders: null,
          probeMode: null,
          resolvedRoutePathname: "/api/hello",
        },
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
