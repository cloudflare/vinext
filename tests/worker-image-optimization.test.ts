import { describe, expect, it, vi } from "vite-plus/test";
import { handleImageOptimization } from "../packages/vinext/src/server/image-optimization.js";
import { createStaticFileSignal } from "../packages/vinext/src/server/static-file-signal.js";
import {
  fetchSignalledPublicFile,
  fetchWorkerImageSource,
  type WorkerImageSourceOptions,
} from "../packages/vinext/src/server/worker-image-optimization.js";

// Next.js' image optimizer fetches a local source through the router as a GET
// without the caller's headers (fetchInternalImage in
// packages/next/src/server/image-optimizer.ts).
// E2E coverage: tests/e2e/cloudflare-workers/image-middleware.spec.ts and
// tests/e2e/cloudflare-pages-router/image-middleware.spec.ts.

const callerRequest = () =>
  new Request("https://example.com/_next/image?url=%2Fa.png&w=64&q=75", {
    headers: { cookie: "session=1", authorization: "Bearer token" },
  });

function sourceOptions(overrides: Partial<WorkerImageSourceOptions> = {}) {
  const assets = { fetch: vi.fn(async (_request: Request) => new Response("asset")) };
  const fetchPublicFile = vi.fn(
    async (_request: Request): Promise<Response | null> => new Response("public"),
  );
  const options: WorkerImageSourceOptions = {
    assets,
    basePath: "",
    assetPathPrefix: "",
    clientBuildFiles: new Set(),
    fetchPublicFile,
    ...overrides,
  };
  return { options, assets, fetchPublicFile };
}

describe("fetchWorkerImageSource", () => {
  it("fetches build output from the asset binding without the caller's headers", async () => {
    const { options, assets, fetchPublicFile } = sourceOptions();

    const response = await fetchWorkerImageSource(
      "/_next/static/media/a.png",
      callerRequest(),
      options,
    );

    expect(await response.text()).toBe("asset");
    expect(fetchPublicFile).not.toHaveBeenCalled();
    const assetRequest = assets.fetch.mock.calls[0][0];
    expect(new URL(assetRequest.url).pathname).toBe("/_next/static/media/a.png");
    expect([...assetRequest.headers]).toEqual([]);
  });

  it("fetches build output under a path assetPrefix at its emitted URL", async () => {
    const { options, assets, fetchPublicFile } = sourceOptions({
      basePath: "/docs",
      assetPathPrefix: "/cdn",
    });

    await fetchWorkerImageSource("/cdn/_next/static/media/a.png", callerRequest(), options);

    expect(fetchPublicFile).not.toHaveBeenCalled();
    expect(new URL(assets.fetch.mock.calls[0][0].url).pathname).toBe(
      "/cdn/_next/static/media/a.png",
    );
  });

  it("fetches build output by the name it checked, encoded once", async () => {
    // The binding decodes each segment once. A segment that decodes to `%2E%2E`
    // must stay a literal name rather than resolve as `..`.
    for (const [source, pathname] of [
      ["/_next/static/%252E%252E/%252E%252E/a.png", "/_next/static/%252E%252E/%252E%252E/a.png"],
      ["/_next/static/%252e%252E/.%252E/a.png", "/_next/static/%252e%252E/.%252E/a.png"],
      ["/_next/static/media/logo%402x%20a.png", "/_next/static/media/logo%402x%20a.png"],
      ["/_next/static/media/logo@2x.png", "/_next/static/media/logo%402x.png"],
      ["/_next/static/media/100%25.png", "/_next/static/media/100%25.png"],
    ]) {
      const { options, assets, fetchPublicFile } = sourceOptions();

      await fetchWorkerImageSource(source, callerRequest(), options);

      expect(fetchPublicFile, source).not.toHaveBeenCalled();
      expect(new URL(assets.fetch.mock.calls[0][0].url).pathname, source).toBe(pathname);
    }
  });

  it("fetches build output a decoded slash names", async () => {
    const { options, assets } = sourceOptions();

    await fetchWorkerImageSource("/_next/static/media%2Fa.png", callerRequest(), options);

    expect(new URL(assets.fetch.mock.calls[0][0].url).pathname).toBe("/_next/static/media/a.png");
  });

  it("does not fetch build output for a decoded dot or empty segment", async () => {
    // Next.js matches the decoded pathname literally, without resolving it.
    for (const source of [
      "/_next/static/a%2F..%2F..%2Fa.png",
      "/_next/static/media%2F..%2Fmedia%2Fa.png",
      "/_next/static/media%2F.%2Fa.png",
      "/_next/static/media%2F%2Fa.png",
      "/_next/static//media/a.png",
    ]) {
      const { options, assets, fetchPublicFile } = sourceOptions();

      await fetchWorkerImageSource(source, callerRequest(), options);

      expect(assets.fetch, source).not.toHaveBeenCalled();
      expect(new URL(fetchPublicFile.mock.calls[0][0].url).pathname, source).toBe(source);
    }
  });

  it("keeps an encoded dot segment under a path assetPrefix a literal name", async () => {
    const { options, assets } = sourceOptions({ basePath: "/docs", assetPathPrefix: "/cdn" });

    await fetchWorkerImageSource("/cdn/_next/static/%252E%252E/a.png", callerRequest(), options);

    expect(new URL(assets.fetch.mock.calls[0][0].url).pathname).toBe(
      "/cdn/_next/static/%252E%252E/a.png",
    );
  });

  it("runs any other source through the pipeline as a GET without the caller's headers", async () => {
    const { options, assets, fetchPublicFile } = sourceOptions({ basePath: "/docs" });

    const response = await fetchWorkerImageSource("/docs/a.png?v=1", callerRequest(), options);

    expect(await response.text()).toBe("public");
    expect(assets.fetch).not.toHaveBeenCalled();
    const sourceRequest = fetchPublicFile.mock.calls[0][0];
    expect(sourceRequest.method).toBe("GET");
    expect(sourceRequest.url).toBe("https://example.com/docs/a.png?v=1");
    expect([...sourceRequest.headers]).toEqual([]);
  });

  it("keeps the connection's Cloudflare metadata on the source request", async () => {
    const { options, fetchPublicFile } = sourceOptions();
    const request = callerRequest();
    const cf = { country: "NZ" };
    Object.defineProperty(request, "cf", { value: cf, enumerable: true });

    await fetchWorkerImageSource("/a.png", request, options);

    expect(Reflect.get(fetchPublicFile.mock.calls[0][0], "cf")).toBe(cf);
  });

  it("answers 400 when the pipeline selects no public file or a non-2xx or no-body outcome", async () => {
    const cancel = vi.fn();
    const denied = new Response(new ReadableStream({ cancel }), { status: 403 });
    for (const result of [null, denied, new Response(null, { status: 204 })]) {
      const { options } = sourceOptions({ fetchPublicFile: async () => result });

      const response = await fetchWorkerImageSource("/a.png", callerRequest(), options);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("The requested resource isn't a valid image.");
    }
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("Worker image source Cache-Control", () => {
  // Next.js serves only its `_next/static` output immutably (`isStatic` in
  // packages/next/src/server/image-optimizer.ts); a public file keeps the
  // larger of minimumCacheTTL and the max-age a direct request receives.
  const icon = (cacheControl?: string) =>
    new Response("icon", {
      headers: {
        "Content-Type": "image/x-icon",
        ...(cacheControl ? { "Cache-Control": cacheControl } : {}),
      },
    });
  const serve = (source: string, options: WorkerImageSourceOptions) =>
    handleImageOptimization(
      new Request(`https://example.com/_next/image?url=${encodeURIComponent(source)}&w=64&q=75`),
      { fetchAsset: (url, request) => fetchWorkerImageSource(url, request, options) },
    );

  it("keeps build output immutable", async () => {
    const { options } = sourceOptions({ assets: { fetch: async () => icon() } });
    const response = await serve("/_next/static/media/a.ico", options);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("revalidates a public file under a _next/static folder", async () => {
    const { options } = sourceOptions({ fetchPublicFile: async () => icon() });
    const response = await serve("/avatars/_next/static/a.ico", options);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
  });

  it("keeps the max-age staged for a signalled public file", async () => {
    const assets = { fetch: async () => icon("public, max-age=0, must-revalidate") };
    const { options } = sourceOptions({
      assets,
      fetchPublicFile: async (sourceRequest) =>
        fetchSignalledPublicFile(
          createStaticFileSignal("/a.ico", {
            headers: new Headers({ "Cache-Control": "public, max-age=86400" }),
            status: null,
          }),
          sourceRequest,
          assets,
        ),
    });
    const response = await serve("/a.ico", options);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400, must-revalidate");
  });
});

describe("fetchSignalledPublicFile", () => {
  it("fetches the decoded public file a 2xx static-file signal selects", async () => {
    const assets = { fetch: vi.fn(async (_request: Request) => new Response("file")) };
    const sourceRequest = new Request("https://example.com/members%20only/a.png");

    const response = await fetchSignalledPublicFile(
      createStaticFileSignal("/members%20only/a.png", { headers: null, status: null }),
      sourceRequest,
      assets,
    );

    expect(await response?.text()).toBe("file");
    expect(new URL(assets.fetch.mock.calls[0][0].url).pathname).toBe("/members%20only/a.png");
  });

  it("fetches the file with middleware's request header overrides", async () => {
    const assets = { fetch: vi.fn(async (_request: Request) => new Response("file")) };
    const sourceRequest = new Request("https://example.com/a.png");

    await fetchSignalledPublicFile(
      createStaticFileSignal(
        "/a.png",
        { headers: null, status: null },
        new Headers({ "x-from-middleware": "1" }),
      ),
      sourceRequest,
      assets,
    );

    const assetRequest = assets.fetch.mock.calls[0][0];
    expect(assetRequest.method).toBe("GET");
    expect([...assetRequest.headers]).toEqual([["x-from-middleware", "1"]]);
  });

  it("returns null for a non-2xx or no-body signal or a response that is not a signal", async () => {
    const assets = { fetch: vi.fn(async (_request: Request) => new Response("file")) };
    const sourceRequest = new Request("https://example.com/a.png");

    for (const response of [
      createStaticFileSignal("/a.png", { headers: null, status: 404 }),
      createStaticFileSignal("/a.png", { headers: null, status: 204 }),
      new Response("rendered by middleware"),
    ]) {
      expect(fetchSignalledPublicFile(response, sourceRequest, assets)).toBeNull();
    }
    expect(assets.fetch).not.toHaveBeenCalled();
  });
});
