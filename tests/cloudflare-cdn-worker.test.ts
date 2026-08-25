import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  configureWorkersCacheEntrypoints,
  finalizeWorkersCacheBuildOutput,
} from "../packages/cloudflare/src/cache/cdn-adapter-config.js";
import worker, {
  VinextCachedResponse,
} from "../packages/cloudflare/src/cache/cdn-adapter.worker.js";
import {
  PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
  type PagesPageResponseStageProps,
} from "../packages/vinext/src/server/worker-stages.js";

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

function responseStageInvocation(props: unknown, requestUrl = "https://example.com/page") {
  return { options: { cache: "shared" }, props, requestUrl };
}

function pagesPageProps(
  resolvedUrl: string,
  renderOptions: PagesPageResponseStageProps["renderOptions"],
): PagesPageResponseStageProps {
  return {
    buildId: "test-build",
    kind: "pages-page",
    protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
    requestHost: "example.com",
    renderOptions,
    resolvedUrl,
    stagedHeaders: null,
  };
}

describe("Cloudflare CDN multi-stage Worker facade", () => {
  beforeEach(() => {
    stages.request.mockReset();
    stages.response.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports the cached stage as a named WorkerEntrypoint class", () => {
    expect(typeof VinextCachedResponse).toBe("function");
    expect(typeof VinextCachedResponse.prototype.fetch).toBe("function");
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

  it("rejects malformed configurable entrypoint props", async () => {
    const response = await createEntrypoint({
      options: { cache: "invalid" },
      props: {},
      requestUrl: "https://example.com/page",
    }).fetch(new Request("https://example.com/page"));
    expect(response.status).toBe(400);
    expect(stages.response).not.toHaveBeenCalled();
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

    expect(result).toBe(cachedResponse);
    expect(binding).toHaveBeenCalledWith({
      props: {
        options: { cache: "shared" },
        props: { params: { slug: "page" }, route: "/page" },
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

  it("renders bypass work without consulting the cached entrypoint", async () => {
    const rendered = new Response("private");
    const binding = vi.fn();
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
        exports: { VinextCachedResponse: binding },
      },
    );

    expect(result).toBe(rendered);
    expect(binding).not.toHaveBeenCalled();
    expect(stages.response).toHaveBeenCalledOnce();
  });

  it("falls back to an uncached render when loopback exports are unavailable", async () => {
    stages.response.mockResolvedValue(new Response("rendered"));
    stages.request.mockImplementation((_request, _env, _ctx, dispatch) =>
      dispatch(new Request("https://example.com/render"), {}, { cache: "shared" }),
    );

    const response = await worker.fetch(new Request("https://example.com/page"), {}, {});
    expect(await response.text()).toBe("rendered");
    expect(stages.response).toHaveBeenCalledOnce();
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
      },
    });
  });

  it("preserves unrelated exports and rejects reserved non-Worker exports", () => {
    expect(
      configureWorkersCacheEntrypoints({ exports: { Counter: { type: "durable_object" } } }),
    ).toMatchObject({ exports: { Counter: { type: "durable_object" } } });
    expect(() =>
      configureWorkersCacheEntrypoints({
        exports: { VinextCachedResponse: { type: "durable_object" } },
      }),
    ).toThrow(/reserved Worker export/);
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

  it("updates the generated Wrangler config without changing the source config", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-cdn-output-"));
    try {
      await fs.writeFile(path.join(outDir, "wrangler.json"), JSON.stringify({ name: "app" }));
      await finalizeWorkersCacheBuildOutput({ outDir, root: outDir });
      const config = JSON.parse(await fs.readFile(path.join(outDir, "wrangler.json"), "utf8"));
      expect(config.exports.default.cache.enabled).toBe(false);
      expect(config.exports.VinextCachedResponse.cache.enabled).toBe(true);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});
