import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { handleResponseStage } from "../packages/vinext/src/server/pages-response-stage-entry.js";
import { PAGES_RESPONSE_STAGE_PROTOCOL_VERSION } from "../packages/vinext/src/server/worker-stages.js";
import {
  DefaultCdnCacheAdapter,
  setCdnCacheAdapter,
  type CdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";
import {
  CACHEABILITY_REQUEST_STATE,
  type RouteCacheabilityState,
} from "../packages/vinext/src/shims/cacheability-classification.js";

const stages = vi.hoisted(() => ({
  api: vi.fn(),
  registerCacheAdapters: vi.fn(),
  registerImageOptimizer: vi.fn(),
  renderPage: vi.fn(),
}));

const dispatchRequestStage = async () => new Response("request-stage");

vi.mock("virtual:vinext-cache-adapters", () => ({
  registerConfiguredCacheAdapters: stages.registerCacheAdapters,
}));

vi.mock("virtual:vinext-image-adapters", () => ({
  registerConfiguredImageOptimizer: stages.registerImageOptimizer,
}));

vi.mock("virtual:vinext-pages-response-entry", () => ({
  authorizeOnDemandRevalidate: vi.fn(() => false),
  buildId: "test-build",
  handleApiRoute: stages.api,
  hasMiddleware: false,
  matchPageRoute: null,
  normalizeDataRequest: vi.fn(),
  publicFiles: new Set(),
  renderPage: stages.renderPage,
  runMiddleware: null,
  vinextConfig: {},
}));

vi.mock("virtual:vinext-cacheability-manifest", () => ({ default: null }));

describe("Pages Worker response stage", () => {
  beforeEach(() => {
    setCdnCacheAdapter(new DefaultCdnCacheAdapter());
    stages.api.mockReset();
    stages.registerCacheAdapters.mockReset();
    stages.registerImageOptimizer.mockReset();
    stages.renderPage.mockReset();
  });

  it("rejects malformed stage descriptions before dispatch", async () => {
    const response = await handleResponseStage(
      new Request("https://example.com/page"),
      undefined,
      undefined,
      { kind: "pages-api" } as never,
      dispatchRequestStage,
      { cache: "shared" },
    );

    expect(response.status).toBe(400);
    expect(stages.api).not.toHaveBeenCalled();
    expect(stages.renderPage).not.toHaveBeenCalled();
  });

  it("renders a page with no outer middleware response headers", async () => {
    const request = new Request("https://example.com/original", {
      headers: { "x-post-middleware": "kept" },
    });
    const response = new Response("page");
    stages.renderPage.mockResolvedValue(response);

    await expect(
      handleResponseStage(
        request,
        { binding: "value" },
        undefined,
        {
          buildId: "test-build",
          cacheability: {
            policyHeaders: null,
            probeMode: null,
            resolvedRoutePathname: "/rewritten",
          },
          kind: "pages-page",
          protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
          requestHost: "example.com",
          renderOptions: { isDataReq: true },
          resolvedUrl: "/rewritten?slug=one",
          stagedHeaders: null,
        },
        dispatchRequestStage,
        { cache: "shared" },
      ),
    ).resolves.toBe(response);

    expect(stages.registerCacheAdapters).toHaveBeenCalledWith({ binding: "value" });
    expect(stages.registerImageOptimizer).toHaveBeenCalledWith({ binding: "value" });
    expect(stages.renderPage).toHaveBeenCalledExactlyOnceWith(
      request,
      "/rewritten?slug=one",
      null,
      expect.any(Object),
      expect.any(Headers),
      { isDataReq: true },
      expect.any(Headers),
    );
    const stagedHeaders = stages.renderPage.mock.calls[0]?.[4] as Headers;
    expect([...stagedHeaders]).toEqual([]);
  });

  it("preserves the dynamic Pages data short-circuit without an HTML render", async () => {
    const response = new Response('{"pageProps":{"dynamic":true}}', {
      headers: { "Content-Type": "application/json" },
    });
    stages.renderPage.mockResolvedValue(response);

    await expect(
      handleResponseStage(
        new Request("https://example.com/page"),
        undefined,
        undefined,
        {
          buildId: "test-build",
          cacheability: { policyHeaders: null, probeMode: null, resolvedRoutePathname: "/page" },
          kind: "pages-page",
          protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
          requestHost: "example.com",
          renderOptions: { isDataReq: true },
          resolvedUrl: "/page",
          stagedHeaders: null,
        },
        dispatchRequestStage,
        { cache: "shared" },
      ).then((result) => result.text()),
    ).resolves.toBe('{"pageProps":{"dynamic":true}}');
    expect(stages.renderPage).toHaveBeenCalledExactlyOnceWith(
      expect.any(Request),
      "/page",
      null,
      expect.any(Object),
      expect.any(Headers),
      { isDataReq: true },
      expect.any(Headers),
    );
  });

  it("admits normalized Pages data using its trusted representation", async () => {
    const adapter: CdnCacheAdapter = {
      buildResponseHeaders: ({ cacheControl }) => ({ "Cache-Control": cacheControl }),
      ownsBackgroundRevalidation: false,
      requiresCompletedResponseAdmission: true,
      async get() {
        return null;
      },
      async revalidateTag() {},
      async set() {},
    };
    stages.registerCacheAdapters.mockImplementation(() => setCdnCacheAdapter(adapter));
    stages.renderPage.mockImplementation(async (...args: unknown[]) => {
      const context = args[3] as Record<PropertyKey, unknown>;
      const state = context[CACHEABILITY_REQUEST_STATE] as RouteCacheabilityState;
      expect(state.admission?.representation).toBe("pages-data");
      state.route = { kind: "pages-page", pattern: "/page" };
      state.outcome = { cacheable: true, cacheControl: "s-maxage=60" };
      return new Response('{"pageProps":{"cached":true}}');
    });

    const response = await handleResponseStage(
      new Request("https://example.com/page"),
      undefined,
      undefined,
      {
        buildId: "test-build",
        cacheability: {
          policyHeaders: null,
          probeMode: null,
          representation: "pages-data",
          resolvedRoutePathname: "/page",
        },
        kind: "pages-page",
        protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
        requestHost: "example.com",
        renderOptions: { isDataReq: true },
        resolvedUrl: "/page",
        stagedHeaders: null,
      },
      dispatchRequestStage,
      { cache: "shared" },
    );

    expect(response.headers.get("Cache-Control")).toBe("s-maxage=60");
    await expect(response.json()).resolves.toEqual({ pageProps: { cached: true } });
  });

  it("dispatches a Pages API with its resolved URL and no outer composition", async () => {
    const request = new Request("https://example.com/original");
    const response = new Response("api");
    stages.api.mockResolvedValue(response);

    await expect(
      handleResponseStage(
        request,
        undefined,
        undefined,
        {
          apiUrl: "/api/rewritten?slug=one",
          buildId: "test-build",
          cacheability: {
            policyHeaders: null,
            probeMode: null,
            resolvedRoutePathname: "/api/rewritten",
          },
          kind: "pages-api",
          protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
          requestHost: "example.com",
          stagedHeaders: null,
        },
        dispatchRequestStage,
        { cache: "shared" },
      ),
    ).resolves.toBe(response);

    expect(stages.api).toHaveBeenCalledExactlyOnceWith(
      request,
      "/api/rewritten?slug=one",
      expect.any(Object),
      "https://example.com",
      "node",
      expect.any(Headers),
    );
    expect(stages.renderPage).not.toHaveBeenCalled();
  });

  it("installs complete request-stage headers before Pages API user code", async () => {
    stages.api.mockImplementation(async (...args: unknown[]) => {
      const initialHeaders = args[5] as Headers;
      expect(initialHeaders.get("x-config-variant")).toBe("preview");
      expect(initialHeaders.get("x-from-middleware")).toBe("present");
      return new Response("api");
    });

    await handleResponseStage(
      new Request("https://example.com/api/headers"),
      undefined,
      undefined,
      {
        apiUrl: "/api/headers",
        buildId: "test-build",
        cacheability: {
          policyHeaders: [["Cache-Control", "public, s-maxage=60"]],
          probeMode: null,
          resolvedRoutePathname: "/api/headers",
        },
        kind: "pages-api",
        protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
        requestHost: "example.com",
        stagedHeaders: [
          ["cache-control", "public, s-maxage=60"],
          ["x-config-variant", "preview"],
          ["x-from-middleware", "present"],
        ],
      },
      dispatchRequestStage,
      { cache: "shared" },
    );
  });

  it("installs middleware and config headers before a staged GSSP render", async () => {
    // Ported from Next.js:
    // test/e2e/middleware-custom-matchers/app/pages/index.js
    // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-custom-matchers/app/pages/index.js
    stages.renderPage.mockImplementation(async (...args: unknown[]) => {
      const initialHeaders = args[6] as Headers;
      expect(initialHeaders.get("x-config-variant")).toBe("preview");
      expect(initialHeaders.get("x-from-middleware")).toBe("present");
      return new Response("page");
    });

    await handleResponseStage(
      new Request("https://example.com/gssp"),
      undefined,
      undefined,
      {
        buildId: "test-build",
        cacheability: {
          policyHeaders: [["Cache-Control", "public, s-maxage=60"]],
          probeMode: null,
          resolvedRoutePathname: "/gssp",
        },
        kind: "pages-page",
        protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
        requestHost: "example.com",
        renderOptions: null,
        resolvedUrl: "/gssp",
        stagedHeaders: [
          ["cache-control", "public, s-maxage=60"],
          ["x-config-variant", "preview"],
          ["x-from-middleware", "present"],
        ],
      },
      dispatchRequestStage,
      { cache: "shared" },
    );
  });

  it("admits an explicitly public Pages API response", async () => {
    const adapter: CdnCacheAdapter = {
      buildResponseHeaders: ({ cacheControl }) => ({ "Cache-Control": cacheControl }),
      ownsBackgroundRevalidation: false,
      requiresCompletedResponseAdmission: true,
      responseVary: "verbatim",
      async get() {
        return null;
      },
      async revalidateTag() {},
      async set() {},
    };
    stages.registerCacheAdapters.mockImplementation(() => setCdnCacheAdapter(adapter));
    stages.api.mockResolvedValue(
      new Response("public api", { headers: { "Cache-Control": "public, s-maxage=60" } }),
    );

    const response = await handleResponseStage(
      new Request("https://example.com/api/public"),
      undefined,
      undefined,
      {
        apiUrl: "/api/public",
        buildId: "test-build",
        cacheability: {
          policyHeaders: null,
          probeMode: null,
          resolvedRoutePathname: "/api/public",
        },
        kind: "pages-api",
        protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
        requestHost: "example.com",
        stagedHeaders: null,
      },
      dispatchRequestStage,
      { cache: "shared" },
    );

    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
    await expect(response.text()).resolves.toBe("public api");
  });

  it("does not let config public policy overwrite a Pages API private response", async () => {
    const adapter: CdnCacheAdapter = {
      buildResponseHeaders: ({ cacheControl }) => ({ "Cache-Control": cacheControl }),
      ownsBackgroundRevalidation: false,
      requiresCompletedResponseAdmission: true,
      responseVary: "verbatim",
      async get() {
        return null;
      },
      async revalidateTag() {},
      async set() {},
    };
    stages.registerCacheAdapters.mockImplementation(() => setCdnCacheAdapter(adapter));
    stages.api.mockImplementation(async (...args: unknown[]) => {
      const initialHeaders = args[5] as Headers;
      expect(initialHeaders.get("Cache-Control")).toBe("public, s-maxage=60");
      return new Response("private api", {
        headers: { "Cache-Control": "private, no-store" },
      });
    });

    const response = await handleResponseStage(
      new Request("https://example.com/api/private"),
      undefined,
      undefined,
      {
        apiUrl: "/api/private",
        buildId: "test-build",
        cacheability: {
          policyHeaders: [["Cache-Control", "public, s-maxage=60"]],
          probeMode: null,
          resolvedRoutePathname: "/api/private",
        },
        kind: "pages-api",
        protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
        requestHost: "example.com",
        stagedHeaders: null,
      },
      dispatchRequestStage,
      { cache: "shared" },
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    await expect(response.text()).resolves.toBe("private api");
  });

  it("preserves an adapter-supplied Worker runtime for Pages API responses", async () => {
    const request = new Request("https://example.com/original");
    stages.api.mockResolvedValue(new Response("api"));

    await handleResponseStage(
      request,
      undefined,
      { hostRuntime: "worker", waitUntil() {} },
      {
        apiUrl: "/api/worker",
        buildId: "test-build",
        cacheability: {
          policyHeaders: null,
          probeMode: null,
          resolvedRoutePathname: "/api/worker",
        },
        kind: "pages-api",
        protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
        requestHost: "example.com",
        stagedHeaders: null,
      },
      dispatchRequestStage,
      { cache: "shared" },
    );

    expect(stages.api.mock.calls[0]?.[4]).toBe("worker");
  });

  it("rejects a response-stage deployment mismatch before rendering", async () => {
    const response = await handleResponseStage(
      new Request("https://example.com/page"),
      undefined,
      undefined,
      {
        buildId: "older-build",
        cacheability: { policyHeaders: null, probeMode: null, resolvedRoutePathname: "/page" },
        kind: "pages-page",
        protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
        requestHost: "example.com",
        renderOptions: null,
        resolvedUrl: "/page",
        stagedHeaders: null,
      },
      dispatchRequestStage,
      { cache: "shared" },
    );

    expect(response.status).toBe(409);
    expect(stages.api).not.toHaveBeenCalled();
    expect(stages.renderPage).not.toHaveBeenCalled();
  });

  it("rejects a response-stage host mismatch before rendering", async () => {
    const response = await handleResponseStage(
      new Request("https://second.example/page"),
      undefined,
      undefined,
      {
        buildId: "test-build",
        cacheability: { policyHeaders: null, probeMode: null, resolvedRoutePathname: "/page" },
        kind: "pages-page",
        protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
        renderOptions: null,
        requestHost: "first.example",
        resolvedUrl: "/page",
        stagedHeaders: null,
      },
      dispatchRequestStage,
      { cache: "shared" },
    );

    expect(response.status).toBe(400);
    expect(stages.renderPage).not.toHaveBeenCalled();
  });

  it("reconstructs bypass-stage headers for nonce and cookie-sensitive page renders", async () => {
    stages.renderPage.mockResolvedValue(new Response("page"));
    const stagedHeaders: Array<[string, string]> = [
      ["content-security-policy", "script-src 'nonce-stage'"],
      ["set-cookie", "first=one; Path=/"],
      ["set-cookie", "second=two; Path=/"],
    ];

    await handleResponseStage(
      new Request("https://example.com/page"),
      undefined,
      undefined,
      {
        buildId: "test-build",
        cacheability: { policyHeaders: null, probeMode: null, resolvedRoutePathname: "/page" },
        kind: "pages-page",
        protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
        requestHost: "example.com",
        renderOptions: null,
        resolvedUrl: "/page",
        stagedHeaders,
      },
      dispatchRequestStage,
      { cache: "bypass" },
    );

    const reconstructed = stages.renderPage.mock.calls[0]?.[4] as Headers;
    expect(reconstructed.get("content-security-policy")).toBe("script-src 'nonce-stage'");
    expect(reconstructed.getSetCookie()).toEqual(["first=one; Path=/", "second=two; Path=/"]);
  });
});
