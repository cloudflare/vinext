import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  appRequestUsesFullResponseGraph,
  dispatchAppRequestStage,
  type AppRequestStageDispatchOptions,
} from "../packages/vinext/src/server/app-request-stage-dispatch.js";
import type { AppRscRequestHandler } from "../packages/vinext/src/server/app-rsc-handler.js";
import { APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION } from "../packages/vinext/src/server/app-worker-stages.js";
import {
  createStaticFileSignal,
  isStaticFileSignal,
  readStaticFileSignal,
  serializeStaticFileSignalForTransport,
} from "../packages/vinext/src/server/static-file-signal.js";

function createOptions(
  overrides: Partial<AppRequestStageDispatchOptions> = {},
): AppRequestStageDispatchOptions {
  return {
    basePath: "/docs",
    buildId: "build-1",
    draftModeSecret: "draft-secret",
    handleRequest: async () => new Response("request stage"),
    prerenderDiscovery: false,
    probeMode: null,
    ...overrides,
  };
}

describe("App request-stage dispatch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    {
      name: "non-read method",
      request: new Request("https://example.test/docs/page", { method: "POST" }),
    },
    {
      name: "websocket upgrade",
      request: new Request("https://example.test/docs/page", {
        headers: { Upgrade: "h2c, WebSocket" },
      }),
    },
    {
      name: "valid draft mode cookie",
      request: new Request("https://example.test/docs/page", {
        headers: { Cookie: "__prerender_bypass=draft-secret" },
      }),
    },
    {
      name: "trusted prerender route params",
      request: new Request("https://example.test/docs/page", {
        headers: { "x-vinext-prerender-route-params": "payload" },
      }),
    },
    {
      name: "CSP nonce",
      request: new Request("https://example.test/docs/page", {
        headers: { "Content-Security-Policy": "script-src 'nonce-request-stage'" },
      }),
    },
    {
      name: "route-tree prefetch",
      request: new Request("https://example.test/docs/page", {
        headers: {
          RSC: "1",
          "Next-Router-Prefetch": "1",
          "Next-Router-Segment-Prefetch": "/_tree",
        },
      }),
    },
    {
      name: "internal path below the base path",
      request: new Request("https://example.test/docs/__vinext/revalidate"),
    },
  ])("uses the complete graph for a $name", ({ request }) => {
    expect(appRequestUsesFullResponseGraph(request, createOptions())).toBe(true);
  });

  it("uses the complete graph during prerender execution", () => {
    vi.stubEnv("VINEXT_PRERENDER", "1");

    expect(
      appRequestUsesFullResponseGraph(
        new Request("https://example.test/docs/page"),
        createOptions(),
      ),
    ).toBe(true);
  });

  it("uses the complete graph for authenticated transported prerender state", () => {
    expect(
      appRequestUsesFullResponseGraph(
        new Request("https://example.test/docs/page"),
        createOptions({
          trustedPrerenderState: { routeParams: null, speculative: true },
        }),
      ),
    ).toBe(true);
  });

  it("keeps ordinary GET/HEAD requests in the request-only graph", () => {
    expect(
      appRequestUsesFullResponseGraph(
        new Request("https://example.test/docs/page"),
        createOptions(),
      ),
    ).toBe(false);
    expect(
      appRequestUsesFullResponseGraph(
        new Request("https://example.test/docs/page", { method: "HEAD" }),
        createOptions(),
      ),
    ).toBe(false);
  });

  it.each(["no-cache", "NO-STORE", "max-age=0, no-cache"])(
    "keeps production request Cache-Control %s in the request-only graph",
    (cacheControl) => {
      expect(
        appRequestUsesFullResponseGraph(
          new Request("https://example.test/docs/page", {
            headers: { "Cache-Control": cacheControl },
          }),
          createOptions(),
        ),
      ).toBe(false);
    },
  );

  it("allows an authenticated cacheability probe to classify a no-cache request", () => {
    const request = new Request("https://example.test/docs/page", {
      headers: { "Cache-Control": "no-cache" },
    });

    expect(appRequestUsesFullResponseGraph(request, createOptions({ probeMode: "probe" }))).toBe(
      false,
    );
    expect(appRequestUsesFullResponseGraph(request, createOptions({ probeMode: "identity" }))).toBe(
      false,
    );
  });

  it("delegates ordinary requests to the request-only handler", async () => {
    const request = new Request("https://example.test/docs/page");
    const ctx = { waitUntil() {} };
    const dispatchResponseStage = vi.fn(async () => new Response("response stage"));
    const handleRequest = vi.fn<AppRscRequestHandler>(async () => new Response("request stage"));

    const response = await dispatchAppRequestStage(request, ctx, dispatchResponseStage, {
      ...createOptions(),
      handleRequest,
      probeMode: "identity",
    });

    await expect(response.text()).resolves.toBe("request stage");
    expect(handleRequest).toHaveBeenCalledWith(
      request,
      ctx,
      false,
      dispatchResponseStage,
      "identity",
    );
    expect(dispatchResponseStage).not.toHaveBeenCalled();
  });

  it("builds a bypass envelope for full requests and restores static-file signals", async () => {
    const request = new Request("https://example.test/docs/upload?view=1", { method: "POST" });
    const handleRequest = vi.fn<AppRscRequestHandler>();
    const dispatchResponseStage = vi.fn(async (_request, props) => {
      if (props.kind !== "app-full-request") throw new Error("unexpected stage kind");
      return serializeStaticFileSignalForTransport(
        createStaticFileSignal("/public/logo.svg", { headers: null, status: 200 }),
        props.staticFileSignalToken,
      );
    });

    const response = await dispatchAppRequestStage(request, null, dispatchResponseStage, {
      ...createOptions(),
      handleRequest,
      prerenderDiscovery: true,
      probeMode: "probe",
      trustedPrerenderState: {
        routeParams: { params: { slug: "hello" }, routePattern: "/docs/:slug" },
        speculative: true,
      },
    });

    expect(dispatchResponseStage).toHaveBeenCalledOnce();
    expect(dispatchResponseStage).toHaveBeenCalledWith(
      request,
      {
        buildId: "build-1",
        cacheability: {
          policyHeaders: null,
          probeMode: "probe",
          resolvedRoutePathname: "/docs/upload",
        },
        draftModeCookie: null,
        kind: "app-full-request",
        middlewareCookieOverlay: null,
        prerenderDiscovery: true,
        protocolVersion: APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION,
        requestOrigin: "https://example.test",
        scriptNonce: null,
        staticFileSignalToken: expect.any(String),
        trustedPrerenderState: {
          routeParams: { params: { slug: "hello" }, routePattern: "/docs/:slug" },
          speculative: true,
        },
      },
      { cache: "bypass" },
    );
    expect(handleRequest).not.toHaveBeenCalled();
    expect(isStaticFileSignal(response)).toBe(true);
    expect(readStaticFileSignal(response)).toBe(encodeURIComponent("/public/logo.svg"));
    expect(response.headers.has("x-vinext-stage-static-file")).toBe(false);
  });

  it("requires the adapter-owned response-stage dispatcher", async () => {
    await expect(
      dispatchAppRequestStage(
        new Request("https://example.test/docs/page"),
        null,
        undefined,
        createOptions(),
      ),
    ).rejects.toThrow("App request stage requires a response-stage dispatcher");
  });
});
