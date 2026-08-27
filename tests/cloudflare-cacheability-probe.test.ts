import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeStagedWorkerCacheability } from "../packages/cloudflare/src/cacheability-probe.js";
import { VINEXT_CDN_BUILD_ID_HEADER } from "../packages/cloudflare/src/cache/cdn-build-id.js";
import {
  cacheabilityManifestRouteKey,
  cacheabilityRequestIdentity,
  type CacheabilityManifestRoute,
} from "../packages/vinext/src/server/cacheability-manifest.js";
import {
  VINEXT_CACHEABILITY_PROBE_HEADER,
  VINEXT_CACHEABILITY_PROBE_QUERY_PARAM,
  VINEXT_PRERENDER_SECRET_HEADER,
} from "../packages/vinext/src/server/headers.js";

describe("staged Worker cacheability probes", () => {
  const roots: string[] = [];

  function createProbeRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-probe-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "dist", "server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist", "server", "vinext-server.json"),
      JSON.stringify({ prerenderSecret: "probe-secret" }),
    );
    return root;
  }

  const target = (pathname: string) => ({
    headers: { Accept: "text/html" },
    kind: "html" as const,
    label: pathname,
    pathname,
    sourcePathname: pathname,
  });

  const createStaticProbeFetch = () =>
    vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      return Response.json({
        kind: "app-page",
        pattern: pathname,
        state: "static-candidate",
        status: 200,
        version: 1,
      });
    });

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
  });

  it("cancels stale Worker bodies before retrying with a hidden request key", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-probe-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "dist", "server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist", "server", "vinext-server.json"),
      JSON.stringify({ prerenderSecret: "probe-secret" }),
    );

    const urls: URL[] = [];
    let cancelledBodies = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      urls.push(url);
      const headers = new Headers(init?.headers);
      expect(headers.get(VINEXT_CACHEABILITY_PROBE_HEADER)).toBe("1");
      expect(headers.get(VINEXT_PRERENDER_SECRET_HEADER)).toBe("probe-secret");

      if (urls.length <= 2) {
        return new Response(
          new ReadableStream({
            cancel() {
              cancelledBodies++;
            },
          }),
          { headers: { [VINEXT_CDN_BUILD_ID_HEADER]: "old-response-build" } },
        );
      }
      return Response.json(
        {
          kind: "app-page",
          pattern: "/cached/:slug",
          state: "static-candidate",
          status: 200,
          version: 1,
        },
        { headers: { [VINEXT_CDN_BUILD_ID_HEADER]: "response-build" } },
      );
    });

    const target = {
      headers: { Accept: "text/html" },
      kind: "html" as const,
      label: "/cached/intro",
      pathname: "/cached/intro",
      sourcePathname: "/cached/intro",
    };
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      expectedResponseBuildId: "response-build",
      fetchImpl,
      retries: 2,
      retryDelayMs: 0,
      root,
      targetUrl: "https://example.com",
      targets: [target],
    });

    expect(result.failures).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(cancelledBodies).toBe(2);
    expect(urls.map((url) => url.pathname)).toEqual([
      "/cached/intro",
      "/cached/intro",
      "/cached/intro",
    ]);
    const nonces = urls.map((url) => url.searchParams.get(VINEXT_CACHEABILITY_PROBE_QUERY_PARAM));
    expect(nonces[0]).toBeTruthy();
    expect(nonces[1]).toBeTruthy();
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(nonces[1]).not.toBe(nonces[2]);

    const route = Object.values(result.manifest.routes)[0];
    expect(route.requestKey).toBe(
      cacheabilityRequestIdentity(
        new Request("https://example.com/cached/intro", { headers: target.headers }),
      )?.requestKey,
    );
    expect(result.cacheableTargets).toEqual([target]);
  });

  it("bounds all target retries by one cacheability-probe phase deadline", async () => {
    const root = createProbeRoot();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("staged version unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("staged version unavailable", { status: 503 }))
      // The phase deadline remains authoritative even if fetch ignores abort.
      .mockImplementation(() => new Promise<Response>(() => {}));

    await expect(
      probeStagedWorkerCacheability({
        buildId: "application-build",
        concurrency: 1,
        fetchImpl,
        phaseTimeoutMs: 25,
        retries: 60,
        retryDelayMs: 10,
        root,
        targetUrl: "https://example.com",
        targets: [target("/one"), target("/two")],
      }),
    ).rejects.toThrow("cacheability probing exceeded its 25ms phase deadline");
    expect(fetchImpl).toHaveBeenCalled();
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("rejects oversized probe envelopes without buffering the full response", async () => {
    const root = createProbeRoot();
    let cancelled = false;
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async () => new Response(oversizedBody),
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [target("/oversized")],
    });

    expect(result.failures).toEqual(["/oversized: probe response exceeded 65536 bytes"]);
    expect(result.cacheableTargets).toEqual([]);
    expect(cancelled).toBe(true);
  });

  it("omits dynamic identities from the deployed manifest and final warm targets", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-probe-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "dist", "server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist", "server", "vinext-server.json"),
      JSON.stringify({ prerenderSecret: "probe-secret" }),
    );
    const targets = [
      {
        headers: { Accept: "text/html" },
        kind: "html" as const,
        label: "/static",
        pathname: "/static",
        sourcePathname: "/static",
      },
      {
        headers: { Accept: "text/html" },
        kind: "html" as const,
        label: "/dynamic",
        pathname: "/dynamic",
        sourcePathname: "/dynamic",
      },
    ];
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
        return Response.json({
          kind: "app-page",
          pattern: pathname,
          state: pathname === "/static" ? "static-candidate" : "dynamic",
          status: 200,
          version: 1,
        });
      },
      root,
      targetUrl: "https://example.com",
      targets,
    });

    expect(result.failures).toEqual([]);
    expect(result.cacheableTargets).toEqual([targets[0]]);
    expect(Object.values(result.manifest.routes)).toEqual([
      expect.objectContaining({ pattern: "/static", state: "static-candidate" }),
    ]);
  });

  it("stops launching probes when another cacheable identity exceeds the route bound", async () => {
    const root = createProbeRoot();
    const fetchImpl = createStaticProbeFetch();

    await expect(
      probeStagedWorkerCacheability({
        buildId: "application-build",
        concurrency: 1,
        fetchImpl,
        manifestLimits: { maxRoutes: 1 },
        retries: 0,
        root,
        targetUrl: "https://example.com",
        targets: [target("/one"), target("/two"), target("/three")],
      }),
    ).rejects.toThrow("produced 2 cacheable identities; the limit is 1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses the exact serialized-byte boundary and stops before later probes", async () => {
    const root = createProbeRoot();
    const firstTarget = target("/one");
    const identity = cacheabilityRequestIdentity(
      new Request(new URL(firstTarget.pathname, "https://example.com"), {
        headers: firstTarget.headers,
      }),
    )!;
    const route: CacheabilityManifestRoute = {
      kind: "app-page",
      pattern: firstTarget.pathname,
      representation: identity.representation,
      requestKey: identity.requestKey,
      state: "static-candidate",
      status: 200,
    };
    const key = cacheabilityManifestRouteKey(
      route.kind,
      route.pattern,
      route.representation,
      route.requestKey,
    );
    const exactBytes = Buffer.byteLength(
      JSON.stringify({
        buildId: "application-build",
        routes: { [key]: route },
        version: 1,
      }),
    );

    const boundaryFetch = createStaticProbeFetch();
    await expect(
      probeStagedWorkerCacheability({
        buildId: "application-build",
        concurrency: 1,
        fetchImpl: boundaryFetch,
        manifestLimits: { maxBytes: exactBytes },
        retries: 0,
        root,
        targetUrl: "https://example.com",
        targets: [firstTarget],
      }),
    ).resolves.toMatchObject({ probed: 1 });
    expect(boundaryFetch).toHaveBeenCalledTimes(1);

    const overflowFetch = createStaticProbeFetch();
    await expect(
      probeStagedWorkerCacheability({
        buildId: "application-build",
        concurrency: 1,
        fetchImpl: overflowFetch,
        manifestLimits: { maxBytes: exactBytes },
        retries: 0,
        root,
        targetUrl: "https://example.com",
        targets: [firstTarget, target("/two"), target("/three")],
      }),
    ).rejects.toThrow(`the limit is ${exactBytes} bytes`);
    expect(overflowFetch).toHaveBeenCalledTimes(2);
  });

  it("records Pages Router probe envelopes without changing request identity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-probe-pages-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "dist", "server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist", "server", "vinext-server.json"),
      JSON.stringify({ prerenderSecret: "probe-secret" }),
    );
    const target = {
      headers: { Accept: "text/html" },
      kind: "html" as const,
      label: "/posts/one",
      pathname: "/posts/one",
      sourcePathname: "/posts/one",
    };
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async () =>
        Response.json({
          kind: "pages-page",
          pattern: "/posts/:slug",
          state: "static-candidate",
          status: 200,
          version: 1,
        }),
      root,
      targetUrl: "https://example.com",
      targets: [target],
    });

    expect(result.failures).toEqual([]);
    expect(Object.values(result.manifest.routes)).toEqual([
      expect.objectContaining({
        kind: "pages-page",
        pattern: "/posts/:slug",
        requestKey: "/posts/one",
      }),
    ]);
  });

  it("records a statically eligible App Route Handler identity", async () => {
    const root = createProbeRoot();
    const appRouteTarget = {
      headers: { Accept: "*/*" },
      kind: "app-route" as const,
      label: "/api/data (Route Handler)",
      pathname: "/api/data",
      sourcePathname: "/api/data",
    };
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async () =>
        Response.json({
          kind: "app-route",
          pattern: "/api/data",
          state: "static-candidate",
          status: 200,
          version: 1,
        }),
      root,
      targetUrl: "https://example.com",
      targets: [appRouteTarget],
    });

    expect(result.failures).toEqual([]);
    expect(result.cacheableTargets).toEqual([appRouteTarget]);
    expect(Object.values(result.manifest.routes)).toEqual([
      expect.objectContaining({
        kind: "app-route",
        representation: "app-route",
        requestKey: "/api/data",
      }),
    ]);
  });
});
