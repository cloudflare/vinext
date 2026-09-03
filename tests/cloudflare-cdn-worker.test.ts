import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { configureWorkersCacheEntrypoints } from "../packages/cloudflare/src/cache/cdn-adapter-config.js";
import worker, {
  VinextCachedResponse,
  VinextUncachedResponse,
} from "../packages/cloudflare/src/cache/cdn-adapter.worker.js";
import { VINEXT_CDN_BUILD_ID_HEADER } from "../packages/cloudflare/src/cache/cdn-build-id.js";
import {
  PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
  type WorkerResponseStageProps,
} from "../packages/vinext/src/server/worker-stages.js";
import { VINEXT_RSC_VARY_HEADER } from "../packages/vinext/src/server/headers.js";
import { cloneRequestWithUrl } from "../packages/vinext/src/server/request-pipeline.js";
import { NextRequest } from "../packages/vinext/src/shims/server.js";

type PagesPageResponseStageProps = Extract<WorkerResponseStageProps, { kind: "pages-page" }>;

const stages = vi.hoisted(() => ({
  request: vi.fn(),
  response: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class<Env, Props> {
    protected ctx: { props: Props };
    protected env: Env;

    constructor(ctx: { props: Props }, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("virtual:vinext-request-stage", () => ({
  handleRequestStage: stages.request,
}));

vi.mock("virtual:vinext-response-stage", () => ({
  handleResponseStage: stages.response,
}));

function createEntrypoint(props: unknown, env: unknown = { binding: "value" }) {
  return Object.assign(Object.create(VinextCachedResponse.prototype), {
    ctx: { props },
    env,
  }) as VinextCachedResponse;
}

function createUncachedEntrypoint(props: unknown, env: unknown = { binding: "value" }) {
  return Object.assign(Object.create(VinextUncachedResponse.prototype), {
    ctx: { props },
    env,
  }) as VinextUncachedResponse;
}

function responseStageInvocation(
  props: unknown,
  requestUrl = "https://example.com/page",
  requestMethod = "GET",
) {
  return { options: { cache: "shared" }, props, requestMethod, requestUrl };
}

function pagesPageProps(
  resolvedUrl: string,
  renderOptions: PagesPageResponseStageProps["renderOptions"],
): PagesPageResponseStageProps {
  return {
    buildId: "test-build",
    cacheability: {
      policyHeaders: null,
      probeMode: null,
      resolvedRoutePathname: new URL(resolvedUrl, "https://example.com").pathname,
    },
    kind: "pages-page",
    protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
    requestHost: "example.com",
    renderOptions,
    resolvedUrl,
    stagedHeaders: null,
  };
}

type PreFixResponseStageInvocation = {
  options: { cache: "shared" | "bypass" };
  props: unknown;
  requestMethod: string;
  requestUrl: string;
};

/** Snapshot of the response-stage parser immediately before the wire-version fix. */
function getPreFixResponseStageInvocation(value: unknown): PreFixResponseStageInvocation | null {
  if (!value || typeof value !== "object") return null;
  const options = Reflect.get(value, "options");
  if (!options || typeof options !== "object") return null;
  const cache = Reflect.get(options, "cache");
  if (cache !== "shared" && cache !== "bypass") return null;
  const requestUrl = Reflect.get(value, "requestUrl");
  if (typeof requestUrl !== "string") return null;
  const requestMethod = Reflect.get(value, "requestMethod");
  if (typeof requestMethod !== "string" || requestMethod.length === 0) return null;
  try {
    new URL(requestUrl);
  } catch {
    return null;
  }
  return {
    options: options as PreFixResponseStageInvocation["options"],
    props: Reflect.get(value, "props"),
    requestMethod,
    requestUrl,
  };
}

/** Local pre-fix entrypoint used to exercise a real rolling-deploy boundary. */
class PreFixVinextCachedResponse {
  constructor(
    private readonly props: unknown,
    private readonly buildIdentity: string,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const invocation = getPreFixResponseStageInvocation(this.props);
    if (!invocation) {
      return this.stamp(new Response("Invalid vinext response-stage invocation", { status: 400 }));
    }
    const restored = new Request(new Request(invocation.requestUrl, request), {
      method: invocation.requestMethod,
    });
    const response = await stages.response(
      restored,
      {},
      { hostRuntime: "worker" },
      invocation.props,
      async () => new Response(null, { status: 501 }),
      invocation.options,
    );
    return this.stamp(response);
  }

  private stamp(response: Response): Response {
    const headers = new Headers(response.headers);
    headers.set(VINEXT_CDN_BUILD_ID_HEADER, this.buildIdentity);
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
}

function isWorkersCacheAdmissible(response: Response): boolean {
  // This deliberately models only the RFC admission decision needed by this
  // regression, not every feature of Workers Cache.
  return (
    response.status === 200 &&
    response.headers.get("Cloudflare-CDN-Cache-Control")?.includes("public") === true
  );
}

describe("Cloudflare CDN multi-stage Worker facade", () => {
  beforeEach(() => {
    stages.request.mockReset();
    stages.response.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("exports the cached stage as a named WorkerEntrypoint class", () => {
    expect(typeof VinextCachedResponse).toBe("function");
    expect(typeof VinextCachedResponse.prototype.fetch).toBe("function");
  });

  it("exports bypass rendering as a separate named WorkerEntrypoint class", () => {
    expect(typeof VinextUncachedResponse).toBe("function");
    expect(typeof VinextUncachedResponse.prototype.fetch).toBe("function");
  });

  it("lazily invokes the response stage from named-entrypoint props", async () => {
    const request = new Request("https://example.com/page");
    const props = { kind: "pages-page", resolvedUrl: "/page" };
    const response = new Response("rendered");
    stages.response.mockResolvedValue(response);

    const result = await createEntrypoint(responseStageInvocation(props)).fetch(request);

    expect(result).toBe(response);
    const [
      renderedRequest,
      renderedEnv,
      renderedContext,
      renderedProps,
      reverseTransport,
      options,
    ] = stages.response.mock.calls[0]!;
    expect((renderedRequest as Request).url).toBe(request.url);
    expect(renderedEnv).toEqual({ binding: "value" });
    expect(renderedContext).toEqual(expect.objectContaining({ hostRuntime: "worker" }));
    expect(renderedProps).toEqual(props);
    expect(reverseTransport).toEqual(expect.any(Function));
    expect(options).toEqual({ cache: "shared" });
  });

  it.each([200, 204, 404, 503])(
    "stamps named-stage identity on every %s response before cache admission",
    async (status) => {
      vi.stubEnv("__VINEXT_RSC_BUILD_IDENTITY", "current-stage");
      stages.response.mockResolvedValue(
        new Response(status === 204 ? null : "rendered", {
          status,
          headers: { [VINEXT_CDN_BUILD_ID_HEADER]: "forged-stage" },
        }),
      );

      const response = await createEntrypoint({
        ...responseStageInvocation({ kind: "app-page" }),
        expectedResponseStageBuildIdentity: "current-stage",
        options: { cache: "vinext-cloudflare-v1:shared" },
      }).fetch(new Request("https://example.com/page"));

      expect(response.status).toBe(status);
      expect(response.headers.get(VINEXT_CDN_BUILD_ID_HEADER)).toBe("current-stage");
    },
  );

  it("preserves immutable WebSocket upgrades while stamping bypass identity", async () => {
    // No Next.js test port applies: preserving a Workers 101 response across
    // configurable entrypoints is specific to the Cloudflare adapter.
    const OriginalResponse = Response;
    const webSocket = {} as WebSocket;
    class WorkersResponse extends OriginalResponse {
      readonly webSocket: WebSocket | null;
      readonly #workersStatus: number;

      constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: WebSocket | null }) {
        const status = init?.status ?? 200;
        super(body, { ...init, status: status === 101 ? 200 : status });
        this.#workersStatus = status;
        this.webSocket = init?.webSocket ?? null;
      }

      override get status(): number {
        return this.#workersStatus;
      }
    }
    vi.stubGlobal("Response", WorkersResponse);
    vi.stubEnv("__VINEXT_RSC_BUILD_IDENTITY", "current-stage");
    const upgrade = new WorkersResponse(null, { status: 101, webSocket });
    vi.spyOn(upgrade.headers, "set").mockImplementation(() => {
      throw new TypeError("Cannot modify immutable headers");
    });
    stages.response.mockResolvedValue(upgrade);

    const response = (await createUncachedEntrypoint({
      ...responseStageInvocation({ kind: "app-route" }),
      expectedResponseStageBuildIdentity: "current-stage",
      options: { cache: "vinext-cloudflare-v1:bypass" },
    }).fetch(
      new Request("https://example.com/socket", {
        headers: { Upgrade: "websocket" },
      }),
    )) as WorkersResponse;

    expect(response).not.toBe(upgrade);
    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(webSocket);
    expect(response.headers.get(VINEXT_CDN_BUILD_ID_HEADER)).toBe("current-stage");
  });

  it("fails closed when an immutable non-HTTP response cannot be stamped", async () => {
    vi.stubEnv("__VINEXT_RSC_BUILD_IDENTITY", "current-stage");
    stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
      dispatch(request, { kind: "app-route" }, { cache: "bypass" }),
    );
    stages.response.mockResolvedValue(Response.error());
    const stageResponses: Response[] = [];
    const binding = vi.fn(({ props }: { props: unknown }) => ({
      async fetch(request: Request) {
        const response = await createUncachedEntrypoint(props).fetch(request);
        stageResponses.push(response);
        return response;
      },
    }));

    const response = await worker.fetch(
      new Request("https://example.com/error"),
      {},
      { exports: { VinextUncachedResponse: binding } },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(stageResponses).toHaveLength(1);
    expect(stageResponses[0]!.status).toBe(503);
    expect(stageResponses[0]!.headers.get(VINEXT_CDN_BUILD_ID_HEADER)).toBe("current-stage");
    expect(stages.response).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", null, 503],
    ["different", "previous-stage", 503],
    ["matching", "current-stage", 200],
  ] as const)(
    "%s named-stage identity is validated before the request stage stamps its own identity",
    async (_label, responseStageIdentity, expectedStatus) => {
      vi.stubEnv("__VINEXT_RSC_BUILD_IDENTITY", "current-stage");
      const binding = vi.fn(() => ({
        fetch() {
          return new Response("response-stage body", {
            headers:
              responseStageIdentity === null
                ? undefined
                : { [VINEXT_CDN_BUILD_ID_HEADER]: responseStageIdentity },
          });
        },
      }));
      stages.request.mockImplementation(async (request, _env, _ctx, dispatch) => {
        const response = await dispatch(request, { kind: "app-page" }, { cache: "shared" });
        const headers = new Headers(response.headers);
        // App and Pages request stages apply this public identity after the
        // response transport returns. It must not hide an inner mismatch.
        headers.set(VINEXT_CDN_BUILD_ID_HEADER, "current-stage");
        return new Response(response.body, { headers, status: response.status });
      });

      const response = await worker.fetch(
        new Request("https://example.com/page", { headers: { Accept: "text/html" } }),
        {},
        { exports: { VinextCachedResponse: binding } },
      );

      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get(VINEXT_CDN_BUILD_ID_HEADER)).toBe("current-stage");
      expect(response.headers.get("Cache-Control")).toBe(
        expectedStatus === 503 ? "no-store" : "private, max-age=0, must-revalidate",
      );
      await expect(response.text()).resolves.toBe(
        expectedStatus === 503 ? "" : "response-stage body",
      );
    },
  );

  it("cancels a response from a mismatched named stage", async () => {
    vi.stubEnv("__VINEXT_RSC_BUILD_IDENTITY", "current-stage");
    const cancel = vi.fn();
    const binding = vi.fn(() => ({
      fetch() {
        return new Response(new ReadableStream({ cancel }), {
          headers: { [VINEXT_CDN_BUILD_ID_HEADER]: "previous-stage" },
        });
      },
    }));
    stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
      dispatch(request, { kind: "app-page" }, { cache: "shared" }),
    );

    const response = await worker.fetch(
      new Request("https://example.com/page"),
      {},
      { exports: { VinextCachedResponse: binding } },
    );

    expect(response.status).toBe(503);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("makes a pre-fix named stage fail before render or Workers Cache admission", async () => {
    // No Next.js test port applies: propagation between named Worker
    // entrypoints and Workers Cache admission is Cloudflare-specific.
    vi.stubEnv("__VINEXT_RSC_BUILD_IDENTITY", "current-stage");
    const cachedResponses = new Map<string, Response>();
    const coldResponseMetadata: {
      edgeCacheControl: string | null;
      identity: string | null;
      status: number;
    }[] = [];
    const renderedBy: string[] = [];
    let coldDispatch = 0;
    const binding = vi.fn(({ props }: { props: unknown }) => ({
      async fetch(request: Request) {
        // The adapter's URL digest already covers the serialized configurable
        // entrypoint props, including the expected response-stage identity.
        const cached = cachedResponses.get(request.url);
        if (cached) return cached.clone();

        const response =
          coldDispatch++ === 0
            ? await new PreFixVinextCachedResponse(props, "previous-stage").fetch(request)
            : await createEntrypoint(props).fetch(request);
        coldResponseMetadata.push({
          edgeCacheControl: response.headers.get("Cloudflare-CDN-Cache-Control"),
          identity: response.headers.get(VINEXT_CDN_BUILD_ID_HEADER),
          status: response.status,
        });
        if (isWorkersCacheAdmissible(response)) {
          cachedResponses.set(request.url, response.clone());
        }
        return response;
      },
    }));
    stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
      dispatch(request, { kind: "app-page" }, { cache: "shared" }),
    );
    stages.response.mockImplementation(() => {
      renderedBy.push("current-stage");
      return new Response("rendered by current-stage", {
        headers: { "Cloudflare-CDN-Cache-Control": "public, max-age=300" },
      });
    });
    const context = { exports: { VinextCachedResponse: binding } };

    const first = await worker.fetch(new Request("https://example.com/page"), {}, context);
    expect(first.status).toBe(503);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(cachedResponses).toHaveProperty("size", 0);
    expect(coldResponseMetadata).toEqual([
      { edgeCacheControl: null, identity: "previous-stage", status: 400 },
    ]);
    expect(renderedBy).toEqual([]);

    const retry = await worker.fetch(new Request("https://example.com/page"), {}, context);
    expect(retry.status).toBe(200);
    await expect(retry.text()).resolves.toBe("rendered by current-stage");
    expect(renderedBy).toEqual(["current-stage"]);
    expect(cachedResponses).toHaveProperty("size", 1);
    expect(coldResponseMetadata).toEqual([
      { edgeCacheControl: null, identity: "previous-stage", status: 400 },
      {
        edgeCacheControl: "public, max-age=300",
        identity: "current-stage",
        status: 200,
      },
    ]);

    const hit = await worker.fetch(new Request("https://example.com/page"), {}, context);
    expect(hit.status).toBe(200);
    await expect(hit.text()).resolves.toBe("rendered by current-stage");
    expect(renderedBy).toEqual(["current-stage"]);
    expect(coldDispatch).toBe(2);
  });

  it("partitions cache-facing keys by the opaque response-stage build identity", async () => {
    const cacheFacingUrls: string[] = [];
    const binding = vi.fn(() => ({
      fetch(request: Request) {
        cacheFacingUrls.push(request.url);
        return new Response("cached", {
          headers: {
            [VINEXT_CDN_BUILD_ID_HEADER]: process.env.__VINEXT_RSC_BUILD_IDENTITY!,
          },
        });
      },
    }));
    stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
      dispatch(request, { kind: "app-page", buildId: "pinned-build" }, { cache: "shared" }),
    );

    const context = { exports: { VinextCachedResponse: binding } };
    vi.stubEnv("__VINEXT_RSC_BUILD_IDENTITY", "stage-a");
    await worker.fetch(new Request("https://example.com/page"), {}, context);
    vi.stubEnv("__VINEXT_RSC_BUILD_IDENTITY", "stage-b");
    await worker.fetch(new Request("https://example.com/page"), {}, context);

    expect(cacheFacingUrls).toHaveLength(2);
    expect(cacheFacingUrls[0]).not.toBe(cacheFacingUrls[1]);
  });

  it("retains Cloudflare's private policy on the cache-bearing entrypoint", async () => {
    stages.response.mockResolvedValue(
      new Response("rendered", {
        headers: { "Cloudflare-CDN-Cache-Control": "public, max-age=300" },
      }),
    );

    const response = await createEntrypoint(responseStageInvocation({ kind: "app-page" })).fetch(
      new Request("https://example.com/page"),
    );

    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe("public, max-age=300");
  });

  it("rejects an expected build identity when the named stage has no identity", async () => {
    const response = await createEntrypoint({
      ...responseStageInvocation({ kind: "app-page" }),
      expectedResponseStageBuildIdentity: "current-stage",
      options: { cache: "vinext-cloudflare-v1:shared" },
    }).fetch(new Request("https://example.com/page"));

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get(VINEXT_CDN_BUILD_ID_HEADER)).toBeNull();
    expect(stages.response).not.toHaveBeenCalled();
  });

  it.each([null, 42, {}])(
    "rejects malformed expected response-stage identity %j",
    async (expectedResponseStageBuildIdentity) => {
      const response = await createEntrypoint({
        ...responseStageInvocation({ kind: "app-page" }),
        expectedResponseStageBuildIdentity,
      }).fetch(new Request("https://example.com/page"));

      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(stages.response).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed configurable entrypoint props", async () => {
    const response = await createEntrypoint({
      options: { cache: "invalid" },
      props: {},
      requestUrl: "https://example.com/page",
    }).fetch(new Request("https://example.com/page"));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(stages.response).not.toHaveBeenCalled();
  });

  it("rejects cache intent sent to the wrong response entrypoint", async () => {
    const request = new Request("https://example.com/page");
    const [cachedResponse, uncachedResponse] = await Promise.all([
      createEntrypoint({
        ...responseStageInvocation({ kind: "app-page" }),
        options: { cache: "bypass" },
      }).fetch(request),
      createUncachedEntrypoint(responseStageInvocation({ kind: "app-page" })).fetch(request),
    ]);

    expect(cachedResponse.status).toBe(400);
    expect(uncachedResponse.status).toBe(400);
    expect(stages.response).not.toHaveBeenCalled();
  });

  it("routes invalidation from uncached renders through the cache-bearing entrypoint", async () => {
    const purge = vi.fn().mockResolvedValue({ success: true });
    const cachedBinding = vi.fn(() => ({ fetch: vi.fn(), purge }));
    stages.response.mockImplementation((_request, _env, context) => {
      const cache = Reflect.get(context, "cache") as {
        purge(options: { tags: string[] }): unknown;
      };
      return Promise.resolve(cache.purge({ tags: ["updated-tag"] })).then(
        () => new Response("rendered"),
      );
    });
    const entrypoint = Object.assign(Object.create(VinextUncachedResponse.prototype), {
      ctx: {
        exports: { VinextCachedResponse: cachedBinding },
        props: {
          ...responseStageInvocation({ kind: "app-route" }),
          options: { cache: "bypass" },
        },
      },
      env: {},
    }) as VinextUncachedResponse;

    const response = await entrypoint.fetch(new Request("https://example.com/action"));

    await expect(response.text()).resolves.toBe("rendered");
    expect(cachedBinding).toHaveBeenCalledWith({ props: {} });
    expect(purge).toHaveBeenCalledWith({ tags: ["updated-tag"] });
  });

  it("rejects unversioned cache intent when an expected identity is present", async () => {
    vi.stubEnv("__VINEXT_RSC_BUILD_IDENTITY", "current-stage");
    const response = await createEntrypoint({
      ...responseStageInvocation({ kind: "app-page" }),
      expectedResponseStageBuildIdentity: "current-stage",
    }).fetch(new Request("https://example.com/page"));

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(stages.response).not.toHaveBeenCalled();
  });

  it("rejects versioned wire cache intent without an expected identity", async () => {
    const response = await createEntrypoint({
      ...responseStageInvocation({ kind: "app-page" }),
      options: { cache: "vinext-cloudflare-v1:shared" },
    }).fetch(new Request("https://example.com/page"));

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(stages.response).not.toHaveBeenCalled();
  });

  it("makes a built stage reject pre-fix gateway props before render or cache admission", async () => {
    vi.stubEnv("__VINEXT_RSC_BUILD_IDENTITY", "current-stage");

    // This is the exact configurable-entrypoint shape serialized by the
    // immediately preceding gateway implementation.
    const response = await createEntrypoint(responseStageInvocation({ kind: "app-page" })).fetch(
      new Request("https://example.com/page"),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(isWorkersCacheAdmissible(response)).toBe(false);
    expect(stages.response).not.toHaveBeenCalled();
  });

  it("normalizes wire cache intent before nested response-stage dispatch", async () => {
    vi.stubEnv("__VINEXT_RSC_BUILD_IDENTITY", "current-stage");
    stages.response
      .mockImplementationOnce((_request, _env, _context, _props, dispatchRequestStage) =>
        dispatchRequestStage(new Request("https://example.com/nested")),
      )
      .mockResolvedValueOnce(new Response("nested response"));
    stages.request.mockImplementation((request, _env, _context, dispatchResponseStage) =>
      dispatchResponseStage(request, { kind: "app-page" }, { cache: "shared" }),
    );

    const response = await createEntrypoint({
      ...responseStageInvocation({ kind: "app-page" }),
      expectedResponseStageBuildIdentity: "current-stage",
      options: { cache: "vinext-cloudflare-v1:shared" },
    }).fetch(new Request("https://example.com/page"));

    await expect(response.text()).resolves.toBe("nested response");
    expect(stages.response.mock.calls.map((call) => call[5])).toEqual([
      { cache: "shared" },
      { cache: "shared" },
    ]);
  });

  it("dispatches shared work through ctx.exports", async () => {
    const cachedResponse = new Response("cached");
    const fetch = vi.fn().mockResolvedValue(cachedResponse);
    const binding = vi.fn(() => ({ fetch }));
    const params = Object.assign(Object.create(null) as Record<string, string>, { slug: "page" });
    stages.request.mockImplementation((_request, _env, _ctx, dispatch) =>
      dispatch(
        new Request("https://example.com/render"),
        { params, route: "/page" },
        { cache: "shared" },
      ),
    );

    const result = await worker.fetch(
      new Request("https://example.com/page"),
      {},
      {
        exports: { VinextCachedResponse: binding },
      },
    );

    await expect(result.text()).resolves.toBe("cached");
    expect(result.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
    expect(binding).toHaveBeenCalledWith({
      props: {
        options: { cache: "shared" },
        props: { params: { slug: "page" }, route: "/page" },
        requestMethod: "GET",
        requestUrl: "https://example.com/render",
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
    const cacheRequest = fetch.mock.calls[0]![0] as Request;
    expect(cacheRequest.url).toMatch(
      /^https:\/\/example\.com\/render\?__vinext_cache_key=[0-9a-f]{64}$/,
    );
    expect(stages.response).not.toHaveBeenCalled();
  });

  it.each(["HIT", "MISS", "UPDATING"])(
    "exposes the response-entrypoint %s status through vinext cache headers",
    async (cacheStatus) => {
      const binding = vi.fn(() => ({
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Response("cached", { headers: { "CF-Cache-Status": cacheStatus } }),
          ),
      }));
      stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
        dispatch(request, { kind: "app-page" }, { cache: "shared" }),
      );

      const response = await worker.fetch(
        new Request("https://example.com/page"),
        {},
        { exports: { VinextCachedResponse: binding } },
      );

      expect(response.headers.get("CF-Cache-Status")).toBe(cacheStatus);
      expect(response.headers.get("X-Vinext-Cache")).toBe(cacheStatus);
      expect(response.headers.get("X-Nextjs-Cache")).toBe(cacheStatus);
    },
  );

  it("restamps the entrypoint cache status after outer response composition", async () => {
    const binding = vi.fn(() => ({
      fetch: vi
        .fn()
        .mockResolvedValue(new Response("cached", { headers: { "CF-Cache-Status": "HIT" } })),
    }));
    stages.request.mockImplementation(async (request, _env, _ctx, dispatch) => {
      const response = await dispatch(request, { kind: "app-page" }, { cache: "shared" });
      const headers = new Headers(response.headers);
      headers.set("X-Vinext-Cache", "middleware");
      headers.set("X-Nextjs-Cache", "middleware");
      return new Response(response.body, { headers, status: response.status });
    });

    const response = await worker.fetch(
      new Request("https://example.com/page"),
      {},
      { exports: { VinextCachedResponse: binding } },
    );

    expect(response.headers.get("X-Vinext-Cache")).toBe("HIT");
    expect(response.headers.get("X-Nextjs-Cache")).toBe("HIT");
  });

  it("fails closed when outer response composition collides with shared provenance", async () => {
    const binding = vi.fn(() => ({
      fetch: vi.fn().mockResolvedValue(
        new Response("cached", {
          headers: {
            "Cache-Control": "public, max-age=300",
            "Cache-Tag": "shared-page",
            "CDN-Cache-Control": "public, s-maxage=300",
            "CF-Cache-Status": "HIT",
          },
        }),
      ),
    }));
    stages.request.mockImplementation(async (request, _env, _ctx, dispatch) => {
      const response = await dispatch(request, { kind: "app-page" }, { cache: "shared" });
      const headers = new Headers(response.headers);
      headers.set("x-vinext-cloudflare-shared-response-stage", "middleware");
      headers.set("X-Vinext-Cache", "middleware");
      headers.set("X-Nextjs-Cache", "middleware");
      return new Response(response.body, { headers, status: response.status });
    });

    const response = await worker.fetch(
      new Request("https://example.com/page"),
      {},
      { exports: { VinextCachedResponse: binding } },
    );

    expect(response.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
    expect(response.headers.get("Cache-Tag")).toBeNull();
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("X-Vinext-Cache")).toBeNull();
    expect(response.headers.get("X-Nextjs-Cache")).toBeNull();
    expect(response.headers.has("x-vinext-cloudflare-shared-response-stage")).toBe(false);
  });

  it("partitions shared dispatches by public request authority", async () => {
    const cacheFacingRequests: Request[] = [];
    const binding = vi.fn(({ props }: { props: unknown }) => ({
      fetch(request: Request) {
        cacheFacingRequests.push(request);
        return createEntrypoint(props).fetch(request);
      },
    }));
    stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
      dispatch(request, { kind: "app-page" }, { cache: "shared" }),
    );
    stages.response.mockImplementation((request) => Response.json({ url: request.url }));

    const responses = [];
    for (const url of ["https://tenant-a.example/page", "https://tenant-b.example/page"]) {
      responses.push(
        await worker.fetch(new Request(url), {}, { exports: { VinextCachedResponse: binding } }),
      );
    }

    expect(cacheFacingRequests).toHaveLength(2);
    expect(cacheFacingRequests[0]?.url).toMatch(
      /^https:\/\/tenant-a\.example\/page\?__vinext_cache_key=[0-9a-f]{64}$/,
    );
    expect(cacheFacingRequests[1]?.url).toMatch(
      /^https:\/\/tenant-b\.example\/page\?__vinext_cache_key=[0-9a-f]{64}$/,
    );
    expect(cacheFacingRequests[0]?.url).not.toBe(cacheFacingRequests[1]?.url);
    await expect(responses[0]?.json()).resolves.toEqual({
      url: "https://tenant-a.example/page",
    });
    await expect(responses[1]?.json()).resolves.toEqual({
      url: "https://tenant-b.example/page",
    });
  });

  it("promotes framework Vary selectors into the primary cache identity", async () => {
    const cacheFacingRequests: Request[] = [];
    const binding = vi.fn(() => ({
      fetch(request: Request) {
        cacheFacingRequests.push(request);
        return new Response("cached");
      },
    }));
    stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
      dispatch(request, { kind: "app-page" }, { cache: "shared" }),
    );

    for (const nextUrl of ["/tenant-a", "/tenant-b", "/tenant-a"]) {
      await worker.fetch(
        new Request("https://example.com/page", { headers: { "Next-Url": nextUrl } }),
        {},
        { exports: { VinextCachedResponse: binding } },
      );
    }

    expect(cacheFacingRequests).toHaveLength(3);
    expect(cacheFacingRequests[0]?.url).not.toBe(cacheFacingRequests[1]?.url);
    expect(cacheFacingRequests[2]?.url).toBe(cacheFacingRequests[0]?.url);
  });

  it("does not expose the inner Cloudflare cache policy after gateway personalization", async () => {
    const binding = vi.fn(() => ({
      fetch: vi.fn().mockResolvedValue(
        new Response("shared", {
          headers: {
            "Cache-Control": "public, max-age=0, must-revalidate",
            "Cloudflare-CDN-Cache-Control": "public, max-age=300",
          },
        }),
      ),
    }));
    stages.request.mockImplementation(async (request, _env, _ctx, dispatch) => {
      const response = await dispatch(request, { kind: "app-page" }, { cache: "shared" });
      const headers = new Headers(response.headers);
      headers.set("x-user-variant", request.headers.get("x-user-variant") ?? "missing");
      return new Response(response.body, { headers, status: response.status });
    });

    const response = await worker.fetch(
      new Request("https://example.com/page", {
        headers: { "x-user-variant": "alice" },
      }),
      {},
      { exports: { VinextCachedResponse: binding } },
    );

    expect(response.headers.get("x-user-variant")).toBe("alice");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    await expect(response.text()).resolves.toBe("shared");
  });

  it("does not rewrite an unrelated fallback after a speculative shared dispatch", async () => {
    const binding = vi.fn(() => ({
      fetch: vi.fn().mockResolvedValue(
        new Response("discarded", {
          headers: { "Cloudflare-CDN-Cache-Control": "public, max-age=300" },
        }),
      ),
    }));
    stages.request.mockImplementation(async (request, _env, _ctx, dispatch) => {
      const speculative = await dispatch(request, { kind: "app-page" }, { cache: "shared" });
      await speculative.body?.cancel();
      return new Response("asset fallback", {
        headers: {
          "Cache-Control": "public, max-age=3600",
          "Cache-Tag": "asset-fallback",
          "CDN-Cache-Control": "public, s-maxage=3600",
        },
      });
    });

    const response = await worker.fetch(
      new Request("https://example.com/asset"),
      {},
      {
        exports: { VinextCachedResponse: binding },
      },
    );

    expect(binding).toHaveBeenCalledOnce();
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(response.headers.get("CDN-Cache-Control")).toBe("public, s-maxage=3600");
    expect(response.headers.get("Cache-Tag")).toBe("asset-fallback");
  });

  it("consumes shared-stage provenance from an already private response", async () => {
    const binding = vi.fn(() => ({
      fetch: vi
        .fn()
        .mockResolvedValue(new Response("private", { headers: { "Cache-Control": "no-store" } })),
    }));
    stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
      dispatch(request, { kind: "app-page" }, { cache: "shared" }),
    );

    const response = await worker.fetch(
      new Request("https://example.com/private"),
      {},
      {
        exports: { VinextCachedResponse: binding },
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.has("x-vinext-cloudflare-shared-response-stage")).toBe(false);
  });

  it("keeps Authorization off Workers Cache while restoring and partitioning cold renders", async () => {
    const cacheFacingRequests: Request[] = [];
    const binding = vi.fn(({ props }: { props: unknown }) => ({
      fetch(request: Request) {
        cacheFacingRequests.push(request);
        return createEntrypoint(props).fetch(request);
      },
    }));
    stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
      dispatch(request, { kind: "app-route-handler" }, { cache: "shared" }),
    );
    stages.response.mockImplementation((request) =>
      Response.json({ authorization: request.headers.get("Authorization") }),
    );

    for (const authorization of ["Bearer first", "Bearer second"]) {
      await worker.fetch(
        new Request("https://example.com/authenticated", {
          headers: {
            Authorization: authorization,
            "x-vinext-internal-authorization": "forged",
          },
        }),
        {},
        { exports: { VinextCachedResponse: binding } },
      );
    }

    expect(cacheFacingRequests).toHaveLength(2);
    expect(cacheFacingRequests[0]?.headers.get("Authorization")).toBeNull();
    expect(cacheFacingRequests[1]?.headers.get("Authorization")).toBeNull();
    expect(cacheFacingRequests[0]?.url).not.toBe(cacheFacingRequests[1]?.url);
    expect(
      stages.response.mock.calls.map(([request]) =>
        (request as Request).headers.get("Authorization"),
      ),
    ).toEqual(["Bearer first", "Bearer second"]);
    for (const [request] of stages.response.mock.calls) {
      expect((request as Request).headers.has("x-vinext-internal-authorization")).toBe(false);
    }
  });

  it("keys cached dispatches by route metadata and restores the user-facing URL", async () => {
    const cachedEntrypoint = createEntrypoint(
      responseStageInvocation(
        { kind: "app-page", resolvedUrl: "/rewritten" },
        "https://tenant.example/original?view=one",
      ),
    );
    stages.response.mockResolvedValue(new Response("rendered"));

    await cachedEntrypoint.fetch(
      new Request("https://tenant.example/original?view=one&__vinext_cache_key=transport-digest"),
    );

    const renderedRequest = stages.response.mock.calls[0]![0] as Request;
    expect(renderedRequest.url).toBe("https://tenant.example/original?view=one");
  });

  it("preserves request.cf on misses without fragmenting or replacing the cache key", async () => {
    const cacheFacingRequests: Request[] = [];
    const binding = vi.fn(({ props }: { props: unknown }) => ({
      async fetch(request: Request) {
        cacheFacingRequests.push(request);
        return createEntrypoint(props).fetch(request);
      },
    }));
    stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
      dispatch(request, { kind: "app-route-handler" }, { cache: "shared" }),
    );
    stages.response.mockResolvedValue(new Response("rendered"));
    const requestCfValues = [
      { cacheKey: "attacker-controlled", clientTcpRtt: 12, colo: "LHR", country: "GB" },
      { cacheKey: "other-attacker-key", clientTcpRtt: 87, colo: "SJC", country: "US" },
    ];
    for (const requestCf of requestCfValues) {
      const source = new Request("https://example.com/geo", {
        headers: { "x-vinext-internal-request-cf": "forged" },
      });
      Object.defineProperty(source, "cf", { enumerable: true, value: requestCf });
      await worker.fetch(source, {}, { exports: { VinextCachedResponse: binding } });
    }

    expect(cacheFacingRequests[0]?.url).toMatch(
      /^https:\/\/example\.com\/geo\?__vinext_cache_key=[0-9a-f]{64}$/,
    );
    expect(cacheFacingRequests[1]?.url).toBe(cacheFacingRequests[0]?.url);
    expect(cacheFacingRequests[0]?.headers.get("x-vinext-internal-request-cf")).not.toBe("forged");
    expect(cacheFacingRequests[1]?.headers.get("x-vinext-internal-request-cf")).not.toBe("forged");
    for (const [index, requestCf] of requestCfValues.entries()) {
      const renderedRequest = stages.response.mock.calls[index]![0] as Request;
      expect(renderedRequest.url).toBe("https://example.com/geo");
      expect(Reflect.get(renderedRequest, "cf")).toEqual(requestCf);
      expect(renderedRequest.headers.has("x-vinext-internal-request-cf")).toBe(false);
    }
  });

  it("forces a shared response private when application code reads request.cf", async () => {
    const binding = vi.fn(({ props }: { props: unknown }) => ({
      fetch(request: Request) {
        return createEntrypoint(props).fetch(request);
      },
    }));
    stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
      dispatch(request, { kind: "app-route-handler" }, { cache: "shared" }),
    );
    stages.response.mockImplementation((request) => {
      // Match the framework reconstruction used by Pages Edge APIs and App
      // Route Handlers before user code reads the platform extension.
      const rebuilt = cloneRequestWithUrl(request, `${request.url}?resolved=1`);
      const nextRequest = new NextRequest(rebuilt);
      const country = Reflect.get(nextRequest, "cf")?.country;
      return Response.json(
        { country },
        {
          headers: {
            "Cache-Control": "max-age=0, must-revalidate",
            "CDN-Cache-Control": "public, s-maxage=300",
            "Cloudflare-CDN-Cache-Control": "public, s-maxage=300",
            "Cache-Tag": "geo-response",
          },
        },
      );
    });
    const source = new Request("https://example.com/geo");
    Object.defineProperty(source, "cf", {
      configurable: true,
      enumerable: true,
      value: { country: "GB" },
    });

    const response = await worker.fetch(source, {}, { exports: { VinextCachedResponse: binding } });

    await expect(response.json()).resolves.toEqual({ country: "GB" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
  });

  it("keeps the gateway private when transported request.cf remains unread", async () => {
    const binding = vi.fn(({ props }: { props: unknown }) => ({
      fetch(request: Request) {
        return createEntrypoint(props).fetch(request);
      },
    }));
    stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
      dispatch(request, { kind: "app-route-handler" }, { cache: "shared" }),
    );
    stages.response.mockResolvedValue(
      new Response("public", { headers: { "CDN-Cache-Control": "public, s-maxage=300" } }),
    );
    const source = new Request("https://example.com/public");
    Object.defineProperty(source, "cf", {
      configurable: true,
      enumerable: true,
      value: { country: "GB" },
    });

    const response = await worker.fetch(source, {}, { exports: { VinextCachedResponse: binding } });

    expect(response.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    await expect(response.text()).resolves.toBe("public");
  });

  it("keeps tagged responses with custom Vary fields private", async () => {
    stages.response.mockResolvedValue(
      new Response("variant", {
        headers: {
          "Cache-Control": "public, max-age=0, must-revalidate",
          "CDN-Cache-Control": "public, max-age=300",
          "Cache-Tag": "variant-specific-tag",
          Vary: "RSC, Accept-Language",
        },
      }),
    );

    const response = await createEntrypoint(responseStageInvocation({ kind: "app-page" })).fetch(
      new Request("https://example.com/page", {
        headers: { "Accept-Language": "en" },
      }),
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
    expect(response.headers.get("Vary")).toBe("RSC, Accept-Language");
    await expect(response.text()).resolves.toBe("variant");
  });

  it("retains tagged responses with framework-owned RSC variance", async () => {
    stages.response.mockResolvedValue(
      new Response("flight", {
        headers: {
          "CDN-Cache-Control": "public, max-age=300",
          "Cache-Tag": "page-tag",
          Vary: VINEXT_RSC_VARY_HEADER,
        },
      }),
    );

    const response = await createEntrypoint(responseStageInvocation({ kind: "app-page" })).fetch(
      new Request("https://example.com/page", { headers: { RSC: "1" } }),
    );

    expect(response.headers.get("CDN-Cache-Control")).toBe("public, max-age=300");
    expect(response.headers.get("Cache-Tag")).toBe("page-tag");
  });

  it("retains untagged responses with application-defined variance", async () => {
    stages.response.mockResolvedValue(
      new Response("localized", {
        headers: {
          "CDN-Cache-Control": "public, max-age=300",
          Vary: "Accept-Language",
        },
      }),
    );

    const response = await createEntrypoint(responseStageInvocation({ kind: "app-route" })).fetch(
      new Request("https://example.com/localized", {
        headers: { "Accept-Language": "en" },
      }),
    );

    expect(response.headers.get("CDN-Cache-Control")).toBe("public, max-age=300");
    expect(response.headers.get("Vary")).toBe("Accept-Language");
  });

  it("strips forged request.cf transport metadata when no platform metadata exists", async () => {
    const binding = vi.fn(({ props }: { props: unknown }) => ({
      fetch(request: Request) {
        return createEntrypoint(props).fetch(request);
      },
    }));
    stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
      dispatch(request, { kind: "app-route-handler" }, { cache: "shared" }),
    );
    stages.response.mockResolvedValue(new Response("rendered"));

    await worker.fetch(
      new Request("https://example.com/geo", {
        headers: { "x-vinext-internal-request-cf": encodeURIComponent('{"country":"forged"}') },
      }),
      {},
      { exports: { VinextCachedResponse: binding } },
    );

    const renderedRequest = stages.response.mock.calls[0]![0] as Request;
    expect(Reflect.get(renderedRequest, "cf")).toBeUndefined();
    expect(renderedRequest.headers.has("x-vinext-internal-request-cf")).toBe(false);
  });

  it("uses distinct cache-facing URLs for Pages HTML, data, and rewrite identities", async () => {
    const seen: string[] = [];
    const binding = vi.fn(() => ({
      fetch(request: Request) {
        seen.push(request.url);
        return new Response("cached");
      },
    }));
    stages.request.mockImplementation(async (_request, _env, _ctx, dispatch) => {
      await dispatch(
        new Request("https://example.com/page"),
        pagesPageProps("/page", { isDataReq: false }),
        { cache: "shared" },
      );
      await dispatch(
        new Request("https://example.com/page"),
        pagesPageProps("/page", { isDataReq: true }),
        { cache: "shared" },
      );
      await dispatch(
        new Request("https://example.com/page"),
        pagesPageProps("/rewritten-a", { isDataReq: false }),
        { cache: "shared" },
      );
      return dispatch(
        new Request("https://example.com/page"),
        pagesPageProps("/rewritten-b", { isDataReq: false }),
        { cache: "shared" },
      );
    });

    await worker.fetch(
      new Request("https://example.com/page"),
      {},
      {
        exports: { VinextCachedResponse: binding },
      },
    );

    expect(seen).toHaveLength(4);
    expect(new Set(seen)).toHaveProperty("size", 4);
  });

  it("partitions and restores HEAD when Workers Cache invokes the entrypoint as GET", async () => {
    const cacheFacingUrls: string[] = [];
    const binding = vi.fn(({ props }: { props: unknown }) => ({
      fetch(request: Request) {
        cacheFacingUrls.push(request.url);
        // Workers Cache shares GET/HEAD entries and a cold HEAD reaches the
        // Worker as GET. Configurable-entrypoint props retain the caller's
        // logical method across that platform conversion.
        return createEntrypoint(props).fetch(new Request(request, { method: "GET" }));
      },
    }));
    stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
      dispatch(request, { kind: "app-route-handler" }, { cache: "shared" }),
    );
    stages.response.mockImplementation((request) => new Response(request.method));

    const context = { exports: { VinextCachedResponse: binding } };
    await worker.fetch(new Request("https://example.com/route"), {}, context);
    await worker.fetch(new Request("https://example.com/route", { method: "HEAD" }), {}, context);

    expect(cacheFacingUrls).toHaveLength(2);
    expect(cacheFacingUrls[0]).not.toBe(cacheFacingUrls[1]);
    expect(stages.response.mock.calls.map(([request]) => request.method)).toEqual(["GET", "HEAD"]);
  });

  it("renders bypass work through the uncached entrypoint", async () => {
    const rendered = new Response("private");
    const cachedBinding = vi.fn();
    const uncachedBinding = vi.fn(({ props }: { props: unknown }) => ({
      fetch(request: Request) {
        return createUncachedEntrypoint(props).fetch(request);
      },
    }));
    stages.response.mockResolvedValue(rendered);
    stages.request.mockImplementation((_request, _env, _ctx, dispatch) =>
      dispatch(
        new Request("https://example.com/render"),
        { route: "/private" },
        { cache: "bypass" },
      ),
    );

    const result = await worker.fetch(
      new Request("https://example.com/private"),
      {},
      {
        exports: {
          VinextCachedResponse: cachedBinding,
          VinextUncachedResponse: uncachedBinding,
        },
      },
    );

    expect(result).toBe(rendered);
    expect(cachedBinding).not.toHaveBeenCalled();
    expect(uncachedBinding).toHaveBeenCalledOnce();
    expect(stages.response).toHaveBeenCalledOnce();
  });

  it("requires the named response entrypoint for readiness bypasses", async () => {
    // No Next.js test port applies: ctx.exports propagation is a Cloudflare
    // deployment boundary.
    vi.stubEnv("__VINEXT_RSC_BUILD_IDENTITY", "current-stage");
    const binding = vi.fn(({ props }: { props: unknown }) => ({
      fetch(request: Request) {
        return createUncachedEntrypoint(props).fetch(request);
      },
    }));
    stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
      dispatch(request, { kind: "pages-prerender-discovery" }, { cache: "bypass" }),
    );
    stages.response.mockResolvedValue(
      new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store", "X-Vinext-Prerender-Readiness": "1" },
      }),
    );
    const request = new Request(
      "https://example.com/__vinext/prerender/readiness?attempt=entrypoint",
    );

    const response = await worker.fetch(
      request,
      {},
      { exports: { VinextUncachedResponse: binding } },
    );

    expect(response.status).toBe(204);
    expect(binding).toHaveBeenCalledWith({
      props: {
        expectedResponseStageBuildIdentity: "current-stage",
        options: { cache: "vinext-cloudflare-v1:bypass" },
        props: { kind: "pages-prerender-discovery" },
        requestMethod: "GET",
        requestUrl: request.url,
      },
    });
    expect(stages.response).toHaveBeenCalledOnce();
    expect((stages.response.mock.calls[0]![0] as Request).url).toBe(request.url);
    expect(stages.response.mock.calls[0]![5]).toEqual({ cache: "bypass" });
  });

  it("fails readiness closed when the named response entrypoint is unavailable", async () => {
    stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
      dispatch(request, { kind: "pages-prerender-discovery" }, { cache: "bypass" }),
    );

    const response = await worker.fetch(
      new Request("https://example.com/__vinext/prerender/readiness?attempt=missing"),
      {},
      {},
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(stages.response).not.toHaveBeenCalled();
  });

  it("strips forged transport metadata from bypass and fallback renders", async () => {
    for (const cache of ["bypass", "shared"] as const) {
      const binding = vi.fn(({ props }: { props: unknown }) => ({
        fetch(request: Request) {
          return cache === "shared"
            ? createEntrypoint(props).fetch(request)
            : createUncachedEntrypoint(props).fetch(request);
        },
      }));
      stages.request.mockImplementation((request, _env, _ctx, dispatch) =>
        dispatch(request, { route: "/private" }, { cache }),
      );
      stages.response.mockImplementation((request) =>
        Response.json({
          authorizationTransport: request.headers.get("x-vinext-internal-authorization"),
          requestCfTransport: request.headers.get("x-vinext-internal-request-cf"),
        }),
      );

      const response = await worker.fetch(
        new Request("https://example.com/private", {
          headers: {
            "x-vinext-internal-authorization": "forged-authorization",
            "x-vinext-internal-request-cf": "forged-request-cf",
          },
        }),
        {},
        {
          exports:
            cache === "shared"
              ? { VinextCachedResponse: binding }
              : { VinextUncachedResponse: binding },
        },
      );

      await expect(response.json()).resolves.toEqual({
        authorizationTransport: null,
        requestCfTransport: null,
      });
      stages.request.mockReset();
      stages.response.mockReset();
    }
  });

  it("fails closed when the required response entrypoint is unavailable", async () => {
    stages.response.mockResolvedValue(
      new Response("rendered", {
        headers: {
          "Cache-Control": "public, max-age=300",
          "CDN-Cache-Control": "public, s-maxage=300",
          "Cloudflare-CDN-Cache-Control": "public, s-maxage=300",
          "Cache-Tag": "private-fallback",
          "CF-Cache-Status": "HIT",
        },
      }),
    );
    stages.request.mockImplementation((_request, _env, _ctx, dispatch) =>
      dispatch(new Request("https://example.com/render"), {}, { cache: "shared" }),
    );

    const response = await worker.fetch(new Request("https://example.com/page"), {}, {});
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
    expect(response.headers.get("X-Vinext-Cache")).toBeNull();
    expect(response.headers.get("X-Nextjs-Cache")).toBeNull();
    expect(stages.response).not.toHaveBeenCalled();
  });

  it("routes gateway purges through the cache-bearing entrypoint", async () => {
    const purge = vi.fn().mockResolvedValue({ success: true });
    const defaultPurge = vi.fn();
    const binding = vi.fn(() => ({ fetch: vi.fn(), purge }));
    stages.request.mockImplementation((_request, _env, context) =>
      context.cache.purge({ tags: ["encoded-tag"] }).then(() => new Response("purged")),
    );

    const response = await worker.fetch(
      new Request("https://example.com/revalidate"),
      {},
      {
        cache: { purge: defaultPurge },
        exports: { VinextCachedResponse: binding },
      },
    );

    expect(await response.text()).toBe("purged");
    expect(binding).toHaveBeenCalledWith({ props: {} });
    expect(purge).toHaveBeenCalledWith({ tags: ["encoded-tag"] });
    expect(defaultPurge).not.toHaveBeenCalled();
  });
});

describe("Workers Cache deployment configuration", () => {
  it("disables caching on the gateway and enables only the response entrypoint", () => {
    expect(configureWorkersCacheEntrypoints({ name: "app" })).toMatchObject({
      compatibility_flags: ["enable_ctx_exports"],
      name: "app",
      exports: {
        default: { type: "worker", cache: { enabled: false } },
        VinextCachedResponse: { type: "worker", cache: { enabled: true } },
        VinextUncachedResponse: { type: "worker", cache: { enabled: false } },
      },
    });
  });

  it("preserves unrelated exports and rejects reserved non-Worker exports", () => {
    expect(
      configureWorkersCacheEntrypoints({ exports: { Counter: { type: "durable_object" } } }),
    ).toMatchObject({ exports: { Counter: { type: "durable_object" } } });
    for (const name of ["VinextCachedResponse", "VinextUncachedResponse"]) {
      expect(() =>
        configureWorkersCacheEntrypoints({
          exports: { [name]: { type: "durable_object" } },
        }),
      ).toThrow(/reserved Worker export/);
    }
  });

  it("preserves compatibility flags and rejects an explicit ctx.exports opt-out", () => {
    expect(
      configureWorkersCacheEntrypoints({
        compatibility_date: "2025-11-16",
        compatibility_flags: ["nodejs_compat", "enable_ctx_exports"],
      }).compatibility_flags,
    ).toEqual(["nodejs_compat", "enable_ctx_exports"]);
    expect(
      configureWorkersCacheEntrypoints({
        compatibility_date: "2025-11-17",
        compatibility_flags: ["nodejs_compat", "enable_ctx_exports"],
      }).compatibility_flags,
    ).toEqual(["nodejs_compat"]);
    expect(() =>
      configureWorkersCacheEntrypoints({ compatibility_flags: ["disable_ctx_exports"] }),
    ).toThrow(/requires ctx\.exports/);
  });
});
