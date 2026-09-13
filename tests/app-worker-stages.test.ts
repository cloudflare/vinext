import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { handleResponseStage } from "../packages/vinext/src/server/app-response-stage-entry.js";
import {
  APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION,
  isAppWorkerResponseStageProps,
  type AppWorkerResponseStageProps,
} from "../packages/vinext/src/server/app-worker-stages.js";
import {
  DefaultCdnCacheAdapter,
  setCdnCacheAdapter,
  type CdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";
import {
  VINEXT_EXPECTED_WORKER_VERSION_HEADER,
  VINEXT_PRERENDER_READINESS_HEADER,
} from "../packages/vinext/src/server/headers.js";
import { markFrameworkLinkHeaders } from "../packages/vinext/src/server/app-response-header-provenance.js";

const stages = vi.hoisted(() => ({
  renderFullRequest: vi.fn(),
  registerCacheAdapters: vi.fn(),
  registerImageOptimizer: vi.fn(),
  renderResponse: vi.fn(),
}));

vi.mock("virtual:vinext-cache-adapters", () => ({
  registerConfiguredCacheAdapters: stages.registerCacheAdapters,
}));

vi.mock("virtual:vinext-image-adapters", () => ({
  registerConfiguredImageOptimizer: stages.registerImageOptimizer,
}));

vi.mock("virtual:vinext-app-response-entry", () => ({
  __cacheabilityManifest: null,
  default: { handleResponseStage: stages.renderResponse },
}));

vi.mock("virtual:vinext-rsc-entry", () => ({
  default: stages.renderFullRequest,
}));

const notFoundStage = {
  buildId: null,
  cacheability: { policyHeaders: null, probeMode: null, resolvedRoutePathname: "/missing" },
  canonicalPathname: "/missing",
  cleanPathname: "/missing",
  draftModeCookie: null,
  isRscRequest: false,
  kind: "app-not-found" as const,
  middlewareCookieOverlay: null,
  mountedSlotsHeader: null,
  protocolVersion: APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION,
  requestOrigin: "https://example.com",
  renderMode: "navigation" as const,
  resolvedUrl: "/missing",
  scriptNonce: null,
} satisfies AppWorkerResponseStageProps;

describe("App Worker response stage", () => {
  beforeEach(() => {
    setCdnCacheAdapter(new DefaultCdnCacheAdapter());
    stages.registerCacheAdapters.mockReset();
    stages.registerImageOptimizer.mockReset();
    stages.renderFullRequest.mockReset();
    stages.renderResponse.mockReset();
  });

  it("validates readiness from inside the App response stage", async () => {
    const validateRequest = vi.fn(() => null);
    const adapter: CdnCacheAdapter = {
      ownsBackgroundRevalidation: false,
      async get() {
        return null;
      },
      async set() {},
      buildResponseHeaders() {
        return {};
      },
      validateRequest,
      async revalidateTag() {},
    };
    stages.registerCacheAdapters.mockImplementation(() => setCdnCacheAdapter(adapter));
    const request = new Request(
      "https://example.com/__vinext/prerender/readiness?attempt=response-stage",
      { headers: { [VINEXT_EXPECTED_WORKER_VERSION_HEADER]: "version-a" } },
    );
    const props = {
      buildId: null,
      cacheability: {
        policyHeaders: null,
        probeMode: null,
        resolvedRoutePathname: "/__vinext/prerender/readiness",
      },
      draftModeCookie: null,
      kind: "app-full-request" as const,
      middlewareCookieOverlay: null,
      prerenderDiscovery: true,
      protocolVersion: APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION,
      requestOrigin: "https://example.com",
      scriptNonce: null,
      staticFileSignalToken: "00000000-0000-4000-8000-000000000000",
      trustedPrerenderState: null,
    } satisfies AppWorkerResponseStageProps;

    const response = await handleResponseStage(
      request,
      { binding: "value" },
      undefined,
      props,
      async () => new Response("request-stage"),
      { cache: "bypass" },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get(VINEXT_PRERENDER_READINESS_HEADER)).toBe("1");
    expect(stages.registerCacheAdapters).toHaveBeenCalledWith({ binding: "value" });
    expect(validateRequest).toHaveBeenCalledWith(request);
    expect(stages.renderResponse).not.toHaveBeenCalled();
  });

  it("re-enters the request stage through the adapter-owned reverse transport", async () => {
    const dispatchRequestStage = vi.fn(async () => new Response("revalidated"));
    stages.renderResponse.mockImplementationOnce(async (_request, ctx) =>
      ctx.dispatchPagesRevalidate(new Request("https://example.com/missing")),
    );

    const response = await handleResponseStage(
      new Request("https://example.com/missing"),
      { binding: "value" },
      undefined,
      notFoundStage,
      dispatchRequestStage,
      { cache: "shared" },
    );

    await expect(response.text()).resolves.toBe("revalidated");
    expect(dispatchRequestStage).toHaveBeenCalledOnce();
    expect(stages.renderResponse).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      notFoundStage,
      { cache: "shared" },
    );
  });

  it("serializes renderer Link provenance across the response-stage boundary", async () => {
    stages.renderResponse.mockImplementationOnce(async () => {
      const response = new Response("rendered", {
        headers: { Link: '</framework.woff2>; rel="preload"; as="font"' },
      });
      markFrameworkLinkHeaders(response.headers, response.headers.get("link"));
      return response;
    });

    const response = await handleResponseStage(
      new Request("https://example.com/missing"),
      undefined,
      undefined,
      notFoundStage,
      async () => new Response("request-stage"),
      { cache: "shared" },
    );

    expect(response.headers.get("x-vinext-app-stage-post-config-link")).toBe("1");
  });

  it("rejects matched-stage payloads missing interception cache-safety fields", () => {
    const matchedStage = {
      ...notFoundStage,
      bypassInterceptionContextCache: false,
      interceptionContext: null,
      interceptionId: null,
      kind: "app-page" as const,
      matchKind: "request" as const,
      params: {},
      routePattern: "/missing",
      routePathname: "/missing",
    } satisfies AppWorkerResponseStageProps;
    const { bypassInterceptionContextCache: _bypass, ...withoutBypassProof } = matchedStage;
    const { interceptionId: _interceptionId, ...withoutInterceptionId } = matchedStage;

    expect(isAppWorkerResponseStageProps(matchedStage)).toBe(true);
    expect(isAppWorkerResponseStageProps(withoutBypassProof)).toBe(false);
    expect(isAppWorkerResponseStageProps(withoutInterceptionId)).toBe(false);
  });

  it.each([
    { name: "missing", requestOrigin: undefined },
    { name: "relative", requestOrigin: "example.com" },
    { name: "non-HTTP", requestOrigin: "ftp://example.com" },
    { name: "non-canonical", requestOrigin: "https://example.com/" },
  ])("rejects a $name request origin", ({ requestOrigin }) => {
    expect(isAppWorkerResponseStageProps({ ...notFoundStage, requestOrigin })).toBe(false);
  });

  it.each([
    "https://second.example/missing",
    "http://example.com/missing",
    "https://example.com:8443/missing",
  ])("rejects a response-stage origin mismatch before rendering: %s", async (requestUrl) => {
    const response = await handleResponseStage(
      new Request(requestUrl),
      { binding: "value" },
      undefined,
      notFoundStage,
      async () => new Response("request-stage"),
      { cache: "shared" },
    );

    expect(response.status).toBe(400);
    expect(stages.registerImageOptimizer).not.toHaveBeenCalled();
    expect(stages.registerCacheAdapters).not.toHaveBeenCalled();
    expect(stages.renderResponse).not.toHaveBeenCalled();
  });

  it("requires a transport proof on full-request stage payloads", () => {
    const fullStage = {
      buildId: null,
      cacheability: { policyHeaders: null, probeMode: null, resolvedRoutePathname: "/" },
      draftModeCookie: null,
      kind: "app-full-request" as const,
      middlewareCookieOverlay: null,
      prerenderDiscovery: false,
      protocolVersion: APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION,
      requestOrigin: "https://example.com",
      scriptNonce: null,
      staticFileSignalToken: "00000000-0000-4000-8000-000000000000",
      trustedPrerenderState: null,
    } satisfies AppWorkerResponseStageProps;
    const { staticFileSignalToken: _token, ...withoutToken } = fullStage;

    expect(isAppWorkerResponseStageProps(fullStage)).toBe(true);
    expect(isAppWorkerResponseStageProps(withoutToken)).toBe(false);
  });

  it("passes only authenticated prerender state into the full response graph", async () => {
    stages.renderFullRequest.mockResolvedValue(new Response("rendered"));
    const trustedPrerenderState = {
      routeParams: { params: { slug: "hello" }, routePattern: "/post/:slug" },
      speculative: true,
    } as const;
    const props = {
      buildId: null,
      cacheability: { policyHeaders: null, probeMode: null, resolvedRoutePathname: "/post/hello" },
      draftModeCookie: null,
      kind: "app-full-request" as const,
      middlewareCookieOverlay: null,
      prerenderDiscovery: false,
      protocolVersion: APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION,
      requestOrigin: "https://example.com",
      scriptNonce: null,
      staticFileSignalToken: "00000000-0000-4000-8000-000000000000",
      trustedPrerenderState,
    } satisfies AppWorkerResponseStageProps;
    const request = new Request("https://example.com/post/hello");

    const response = await handleResponseStage(
      request,
      undefined,
      undefined,
      props,
      async () => new Response("request-stage"),
      { cache: "bypass" },
    );

    await expect(response.text()).resolves.toBe("rendered");
    expect(stages.renderFullRequest).toHaveBeenCalledWith(
      request,
      expect.anything(),
      false,
      undefined,
      null,
      trustedPrerenderState,
    );
  });
});
