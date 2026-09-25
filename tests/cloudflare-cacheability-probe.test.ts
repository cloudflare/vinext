import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeStagedWorkerCacheability } from "../packages/cloudflare/src/cacheability-probe.js";
import { VINEXT_CDN_BUILD_ID_HEADER } from "../packages/cloudflare/src/cache/cdn-build-id.js";
import type { CdnWarmTarget } from "../packages/cloudflare/src/cdn-warm.js";
import {
  cacheabilityManifestRouteState,
  cacheabilityManifestRouteKey,
  parseCacheabilityManifest,
  type CacheabilityManifestRoute,
} from "../packages/vinext/src/server/cacheability-manifest.js";
import {
  VINEXT_CACHEABILITY_PROBE_HEADER,
  VINEXT_CACHEABILITY_PROBE_QUERY_PARAM,
  VINEXT_CACHEABILITY_PROBE_ROUTE_HEADER,
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
    route: optimizableRoute(pathname),
    sourcePathname: pathname,
  });

  const optimizableRoute = (pattern: string) => ({
    cacheabilityProbe: { canPrunePattern: true },
    kind: "app-page" as const,
    pattern,
  });

  const pairedRouteTargets = () => {
    const route = {
      cacheabilityProbe: { canPrunePattern: true, routeMayResolve: true },
      kind: "app-page" as const,
      pattern: "/source",
    };
    return {
      html: { ...target("/source"), route },
      route,
      rsc: {
        headers: { Accept: "text/x-component", RSC: "1" },
        kind: "rsc-full" as const,
        label: "/source (RSC full)",
        pathname: "/source?_rsc",
        route,
        sourcePathname: "/source",
      },
    };
  };

  const staticProbeResponse = (pattern: string) =>
    Response.json({
      kind: "app-page",
      pattern,
      rendererStatic: true,
      state: "static-candidate",
      status: 200,
      version: 1,
    });

  const createStaticProbeFetch = () =>
    vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      return staticProbeResponse(pathname);
    });

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
  });

  it("retries stale Worker builds until routing reaches the staged version", async () => {
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
      expect(
        JSON.parse(decodeURIComponent(headers.get(VINEXT_CACHEABILITY_PROBE_ROUTE_HEADER)!)),
      ).toEqual(["app-page", "/cached/:slug"]);
      expect(headers.get(VINEXT_PRERENDER_SECRET_HEADER)).toBe("probe-secret");
      expect(headers.get("Cache-Control")).toBeNull();

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
          rendererStatic: true,
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
      route: optimizableRoute("/cached/:slug"),
      sourcePathname: "/cached/intro",
    };
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      expectedResponseBuildId: "response-build",
      fetchImpl,
      // A stale build is version-routing propagation, not an application
      // failure, so it must not consume the ordinary request retry budget.
      retries: 0,
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
    expect(route).toEqual({
      allowUnknown: true,
      kind: "app-page",
      unknownState: "static-candidate",
      pattern: "/cached/:slug",
      state: "runtime-check",
      staticPaths: { html: ["/cached/intro"], "rsc-full": ["/cached/intro"] },
    });
    expect(result.cacheableTargets).toEqual([target]);
  });

  it("still applies the ordinary retry limit after reaching the staged build", async () => {
    const root = createProbeRoot();
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("unavailable", {
          headers: { [VINEXT_CDN_BUILD_ID_HEADER]: "response-build" },
          status: 503,
        }),
    );

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      expectedResponseBuildId: "response-build",
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [target("/unavailable")],
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.failures).toEqual(["/unavailable: probe returned HTTP 503"]);
  });

  it.each([408, 429, 502, 503, 504, 520])(
    "retries transient probe HTTP status %i",
    async (status) => {
      const root = createProbeRoot();
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("unavailable", { status }))
        .mockResolvedValueOnce(staticProbeResponse("/recovered"));

      const result = await probeStagedWorkerCacheability({
        buildId: "application-build",
        fetchImpl,
        retries: 1,
        retryDelayMs: 0,
        root,
        targetUrl: "https://example.com",
        targets: [target("/recovered")],
      });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(result.failures).toEqual([]);
    },
  );

  it("does not retry an HTTP 500 probe response", async () => {
    const root = createProbeRoot();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("broken", { status: 500 }));

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl,
      retries: 2,
      retryDelayMs: 0,
      root,
      targetUrl: "https://example.com",
      targets: [target("/broken")],
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.failures).toEqual(["/broken: probe returned HTTP 500"]);
  });

  it("drops an unlisted path whose render fails, but fails the deploy for a listed one", async () => {
    const root = createProbeRoot();
    const route = optimizableRoute("/posts/:slug");
    const pickedRoute = {
      ...route,
      cacheabilityProbe: { ...route.cacheabilityProbe, unlisted: true },
    };
    const probe = (brokenPathname: string) =>
      probeStagedWorkerCacheability({
        buildId: "application-build",
        fetchImpl: async (input) => {
          const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
          return pathname === brokenPathname
            ? Response.json({
                kind: "app-page",
                pattern: route.pattern,
                reason: "route returned HTTP 500",
                state: "probe-failed",
                status: 500,
                version: 1,
              })
            : staticProbeResponse(route.pattern);
        },
        retries: 0,
        root,
        targetUrl: "https://example.com",
        targets: [
          { ...target("/posts/listed"), route },
          { ...target("/posts/picked"), route: pickedRoute },
        ],
      });

    const dropped = await probe("/posts/picked");
    expect(dropped).toMatchObject({ failures: [], skipped: 0 });
    expect(dropped.cacheableTargets.map((warm) => warm.pathname)).toEqual(["/posts/listed"]);
    const routeRecord =
      dropped.manifest.routes[cacheabilityManifestRouteKey("app-page", route.pattern)];
    expect(routeRecord?.runtimePaths).toBeUndefined();
    expect(cacheabilityManifestRouteState(routeRecord!, "/posts/picked", "html")).not.toBe(
      "runtime-check",
    );

    const failed = await probe("/posts/listed");
    expect(failed.failures).toEqual(["/posts/listed: route returned HTTP 500"]);
  });

  it("judges an unlisted render failure under the route the request stage resolved", async () => {
    const sourceRoute = {
      cacheabilityProbe: { canPrunePattern: true, routeMayResolve: true, unlisted: true },
      kind: "app-page" as const,
      pattern: "/rewrite-me/:slug",
    };
    const probe = (
      resolved: { kind: string; pattern: string; routePathname: string },
      extraTargets: CdnWarmTarget[] = [],
    ) =>
      probeStagedWorkerCacheability({
        buildId: "application-build",
        fetchImpl: async (input) => {
          const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
          return pathname === "/rewrite-me/a"
            ? Response.json({
                ...resolved,
                reason: "route returned HTTP 500",
                state: "probe-failed",
                status: 500,
                version: 1,
              })
            : staticProbeResponse("/posts/:slug");
        },
        retries: 0,
        root: createProbeRoot(),
        targetUrl: "https://example.com",
        targets: [{ ...target("/rewrite-me/a"), route: sourceRoute }, ...extraTargets],
      });
    const failure = ["/rewrite-me/a: route returned HTTP 500"];

    // Rewritten to a Pages page or Route Handler, the failure fails the deploy.
    for (const kind of ["pages-page", "app-route"]) {
      const result = await probe({ kind, pattern: "/legacy/:slug", routePathname: "/legacy/a" });
      expect(result.failures).toEqual(failure);
    }
    // Rewritten to a path the destination App page route lists, it does too.
    const listed = await probe(
      { kind: "app-page", pattern: "/posts/:slug", routePathname: "/posts/a" },
      [{ ...target("/posts/a"), route: optimizableRoute("/posts/:slug") }],
    );
    expect(listed.failures).toEqual(failure);
    // Rewritten to a path the destination doesn't list, it's dropped.
    const unlisted = await probe(
      { kind: "app-page", pattern: "/posts/:slug", routePathname: "/posts/b" },
      [{ ...target("/posts/a"), route: optimizableRoute("/posts/:slug") }],
    );
    expect(unlisted.failures).toEqual([]);
  });

  it("fails the deploy for an unlisted Pages or Route Handler path whose render fails", async () => {
    for (const kind of ["pages-page", "app-route"] as const) {
      const route = { ...optimizableRoute("/posts/:slug"), kind };
      const result = await probeStagedWorkerCacheability({
        buildId: "application-build",
        fetchImpl: async () =>
          Response.json({
            kind,
            pattern: route.pattern,
            reason: "route returned HTTP 500",
            state: "probe-failed",
            status: 500,
            version: 1,
          }),
        retries: 0,
        root: createProbeRoot(),
        targetUrl: "https://example.com",
        targets: [
          {
            ...target("/posts/picked"),
            route: { ...route, cacheabilityProbe: { ...route.cacheabilityProbe, unlisted: true } },
          },
        ],
      });

      expect(result.failures).toEqual(["/posts/picked: route returned HTTP 500"]);
    }
  });

  it("retries a malformed successful probe envelope", async () => {
    const root = createProbeRoot();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{truncated", { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({
          kind: "app-page",
          pattern: "/recovered",
          rendererStatic: true,
          state: "static-candidate",
          status: 200,
          version: 1,
        }),
      );

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl,
      retries: 1,
      retryDelayMs: 0,
      root,
      targetUrl: "https://example.com",
      targets: [target("/recovered")],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.failures).toEqual([]);
    expect(result).toMatchObject({ classified: 1, probed: 1 });
  });

  it("retries a transient Worker-side render classification failure", async () => {
    const root = createProbeRoot();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          kind: "app-page",
          pattern: "/recovered",
          reason: "response body did not complete before the probe deadline",
          retryable: true,
          state: "probe-failed",
          status: 200,
          version: 1,
        }),
      )
      .mockResolvedValueOnce(staticProbeResponse("/recovered"));

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl,
      retries: 1,
      retryDelayMs: 0,
      root,
      targetUrl: "https://example.com",
      targets: [target("/recovered")],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.failures).toEqual([]);
    expect(result).toMatchObject({ classified: 1, probed: 1 });
  });

  it("requeues transient failures after the initial probe pass", async () => {
    const root = createProbeRoot();
    const attempts = new Map<string, number>();
    const requestOrder: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      requestOrder.push(pathname);
      const attempt = attempts.get(pathname) ?? 0;
      attempts.set(pathname, attempt + 1);
      if (pathname === "/slow" && attempt === 0) {
        return Response.json({
          kind: "app-page",
          pattern: pathname,
          reason: "response body did not complete before the probe deadline",
          retryable: true,
          state: "probe-failed",
          status: 200,
          version: 1,
        });
      }
      return staticProbeResponse(pathname);
    });

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 1,
      fetchImpl,
      retries: 1,
      retryDelayMs: 0,
      root,
      targetUrl: "https://example.com",
      targets: [target("/slow"), target("/fast")],
    });

    expect(requestOrder).toEqual(["/slow", "/fast", "/slow"]);
    expect(result.failures).toEqual([]);
  });

  it("requeues route-mover retries without occupying the only probe slot", async () => {
    const root = createProbeRoot();
    const moverRoute = {
      cacheabilityProbe: { canPrunePattern: true, routeMayResolve: true },
      kind: "app-page" as const,
      pattern: "/move",
    };
    const mover = { ...target("/move"), route: moverRoute };
    const ordinary = target("/ordinary");
    const attempts = new Map<string, number>();
    const requestOrder: string[] = [];
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 1,
      fetchImpl: async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
        requestOrder.push(pathname);
        const attempt = attempts.get(pathname) ?? 0;
        attempts.set(pathname, attempt + 1);
        if (pathname === "/move" && attempt === 0) {
          return Response.json({
            kind: "app-page",
            pattern: moverRoute.pattern,
            reason: "response body did not complete before the probe deadline",
            retryable: true,
            state: "probe-failed",
            status: 200,
            version: 1,
          });
        }
        return staticProbeResponse(pathname);
      },
      retries: 1,
      retryDelayMs: 0,
      root,
      targetUrl: "https://example.com",
      targets: [mover, ordinary],
    });

    expect(requestOrder).toEqual(["/move", "/ordinary", "/move"]);
    expect(result).toMatchObject({ failures: [], probed: 2 });
  });

  it("lets sibling pattern proof supersede a prunable representative retry", async () => {
    const root = createProbeRoot();
    const route = optimizableRoute("/posts/:slug");
    const targets = ["one", "two", "three"].map((slug) => ({
      ...target(`/posts/${slug}`),
      route,
    }));
    const requestOrder: string[] = [];
    const progress: Array<{ completed: number; skipped: number; total: number }> = [];
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 1,
      fetchImpl: async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
        requestOrder.push(pathname);
        if (requestOrder.length === 1) {
          return Response.json({
            kind: "app-page",
            pattern: route.pattern,
            reason: "response body did not complete before the probe deadline",
            retryable: true,
            state: "probe-failed",
            status: 200,
            version: 1,
          });
        }
        return Response.json({
          kind: "app-page",
          pattern: route.pattern,
          scope: "pattern",
          state: "dynamic",
          status: 200,
          version: 1,
        });
      },
      onProgress: ({ completed, skipped, total }) => {
        progress.push({ completed, skipped, total });
      },
      retries: 1,
      retryDelayMs: 0,
      root,
      targetUrl: "https://example.com",
      targets,
    });

    expect(requestOrder).toEqual(["/posts/one", "/posts/two"]);
    expect(result).toMatchObject({ failures: [], probed: 1 });
    expect(progress.at(-1)).toEqual({ completed: 3, skipped: 2, total: 3 });
  });

  it("gives every concrete group its own retry budget", async () => {
    const root = createProbeRoot();
    const route = optimizableRoute("/posts/:slug");
    const attempts = new Map<string, number>();
    const requestOrder: string[] = [];
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 1,
      fetchImpl: async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
        requestOrder.push(pathname);
        const attempt = attempts.get(pathname) ?? 0;
        attempts.set(pathname, attempt + 1);
        if ((pathname === "/posts/one" || pathname === "/posts/two") && attempt === 0) {
          return Response.json({
            kind: "app-page",
            pattern: route.pattern,
            reason: "transient probe failure",
            retryable: true,
            state: "probe-failed",
            status: 503,
            version: 1,
          });
        }
        return staticProbeResponse(route.pattern);
      },
      retries: 1,
      retryDelayMs: 0,
      root,
      targetUrl: "https://example.com",
      targets: ["one", "two", "three"].map((slug) => ({
        ...target(`/posts/${slug}`),
        route,
      })),
    });

    expect(requestOrder).toEqual([
      "/posts/one",
      "/posts/two",
      "/posts/three",
      "/posts/one",
      "/posts/two",
    ]);
    expect(result).toMatchObject({ failures: [], probed: 3 });
  });

  it("gives groups deferred by a route mover their own retry budget", async () => {
    const root = createProbeRoot();
    const destinationRoute = optimizableRoute("/posts/:slug");
    const moverRoute = {
      cacheabilityProbe: { canPrunePattern: true, routeMayResolve: true },
      kind: "app-page" as const,
      pattern: "/source",
    };
    const attempts = new Map<string, number>();
    const requestOrder: string[] = [];
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 1,
      fetchImpl: async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
        requestOrder.push(pathname);
        const attempt = attempts.get(pathname) ?? 0;
        attempts.set(pathname, attempt + 1);
        if ((pathname === "/source" || pathname === "/posts/two") && attempt === 0) {
          return Response.json({
            kind: "app-page",
            pattern: pathname === "/source" ? moverRoute.pattern : destinationRoute.pattern,
            reason: "transient probe failure",
            retryable: true,
            state: "probe-failed",
            status: 503,
            version: 1,
          });
        }
        if (pathname === "/source") {
          return Response.json({
            kind: "app-page",
            pattern: destinationRoute.pattern,
            rendererStatic: true,
            routePathname: "/posts/source",
            state: "static-candidate",
            status: 200,
            version: 1,
          });
        }
        if (pathname === "/posts/one") {
          return Response.json({
            kind: "app-page",
            pattern: destinationRoute.pattern,
            scope: "pattern",
            state: "dynamic",
            status: 200,
            version: 1,
          });
        }
        return staticProbeResponse(destinationRoute.pattern);
      },
      retries: 1,
      retryDelayMs: 0,
      root,
      targetUrl: "https://example.com",
      targets: [
        { ...target("/posts/one"), route: destinationRoute },
        { ...target("/posts/two"), route: destinationRoute },
        { ...target("/source"), route: moverRoute },
      ],
    });

    expect(requestOrder).toEqual(["/source", "/posts/one", "/source", "/posts/two", "/posts/two"]);
    expect(result).toMatchObject({ failures: [], probed: 3 });
  });

  it("honors configured probe concurrency above the former worker-pool cap", async () => {
    const root = createProbeRoot();
    const route = {
      cacheabilityProbe: { canPrunePattern: true },
      kind: "app-page" as const,
      pattern: "/items/:slug",
    };
    const targets = Array.from({ length: 64 }, (_, index) => ({
      ...target(`/items/${index}`),
      route,
    }));
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    let reachedConfiguredConcurrency!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const allSlotsActive = new Promise<void>((resolve) => {
      reachedConfiguredConcurrency = resolve;
    });
    const probing = probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 32,
      fetchImpl: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (active === 32) reachedConfiguredConcurrency();
        await gate;
        active -= 1;
        return staticProbeResponse(route.pattern);
      },
      root,
      targetUrl: "https://example.com",
      targets,
    });

    await allSlotsActive;
    expect(active).toBe(32);
    release();
    await expect(probing).resolves.toMatchObject({ failures: [], probed: 64 });
    expect(maximumActive).toBe(32);
  });

  it("does not retry a deterministic Worker-side probe failure", async () => {
    const root = createProbeRoot();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        kind: "app-page",
        pattern: "/broken",
        reason: "route returned HTTP 500",
        state: "probe-failed",
        status: 500,
        version: 1,
      }),
    );

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl,
      retries: 2,
      retryDelayMs: 0,
      root,
      targetUrl: "https://example.com",
      targets: [target("/broken")],
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.failures).toEqual(["/broken: route returned HTTP 500"]);
  });

  it("aborts when cacheability probing makes no progress", async () => {
    const root = createProbeRoot();
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("staged version unavailable", { status: 503 }),
    );

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
        targets: [target("/one")],
      }),
    ).rejects.toThrow("cacheability probing made no progress for 25ms");
  });

  it("aborts a probe whose fetch never settles", async () => {
    const root = createProbeRoot();
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));

    await expect(
      probeStagedWorkerCacheability({
        buildId: "application-build",
        fetchImpl,
        phaseTimeoutMs: 25,
        root,
        targetUrl: "https://example.com",
        targets: [target("/one")],
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("cacheability probing made no progress for 25ms");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("allows a large serial workload to exceed the watchdog while requests keep completing", async () => {
    const root = createProbeRoot();
    const progress: number[] = [];
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 1,
      fetchImpl: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
        return Response.json({
          kind: "app-page",
          pattern: pathname,
          rendererStatic: true,
          state: "static-candidate",
          status: 200,
          version: 1,
        });
      },
      onProgress(update) {
        progress.push(update.completed);
      },
      phaseTimeoutMs: 250,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: Array.from({ length: 7 }, (_, index) => target(`/serial-${index}`)),
    });

    expect(result).toMatchObject({ classified: 7, probed: 7, skipped: 0 });
    expect(progress).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("extends an in-flight probe watchdog when another request makes progress", async () => {
    const root = createProbeRoot();
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 2,
      fetchImpl: async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
        await new Promise((resolve) => setTimeout(resolve, pathname === "/slow" ? 220 : 80));
        return Response.json({
          kind: "app-page",
          pattern: pathname,
          rendererStatic: true,
          state: "static-candidate",
          status: 200,
          version: 1,
        });
      },
      phaseTimeoutMs: 150,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [target("/slow"), target("/fast-one"), target("/fast-two")],
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ classified: 3, probed: 3, skipped: 0 });
  });

  it("authorizes every App representation from one concrete-path probe", async () => {
    const root = createProbeRoot();
    const route = optimizableRoute("/posts/:slug");
    const html = { ...target("/posts/one"), route };
    const rsc = {
      headers: { Accept: "text/x-component", RSC: "1" },
      kind: "rsc-full" as const,
      label: "/posts/one (RSC full)",
      pathname: "/posts/one?_rsc",
      route,
      sourcePathname: "/posts/one",
    };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        kind: "app-page",
        pattern: route.pattern,
        rendererStatic: true,
        state: "static-candidate",
        status: 200,
        version: 1,
      }),
    );

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [rsc, html],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ classified: 1, probed: 1, skipped: 0 });
    expect(result.cacheableTargets).toEqual([html, rsc]);
    expect(result.speculativeTargets).toEqual([rsc]);
    expect(Object.values(result.manifest.routes)).toEqual([
      expect.objectContaining({
        allowUnknown: true,
        kind: "app-page",
        unknownState: "static-candidate",
        pattern: route.pattern,
        state: "runtime-check",
        staticPaths: { html: ["/posts/one"], "rsc-full": ["/posts/one"] },
      }),
    ]);
  });

  it("defers alternate App representations to final admission when routing may terminate", async () => {
    const root = createProbeRoot();
    const route = {
      cacheabilityProbe: { canPrunePattern: true, requestStageMayTerminate: true },
      kind: "app-page" as const,
      pattern: "/conditional",
    };
    const html = { ...target("/conditional"), route };
    const rsc = {
      headers: { Accept: "text/x-component", RSC: "1" },
      kind: "rsc-full" as const,
      label: "/conditional (RSC full)",
      pathname: "/conditional?_rsc",
      route,
      sourcePathname: "/conditional",
    };
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const isRsc = new Headers(init?.headers).get("RSC") === "1";
      return Response.json({
        kind: "app-page",
        pattern: route.pattern,
        ...(isRsc
          ? { rendererStatic: true, state: "static-candidate" }
          : { scope: "identity", state: "dynamic", terminal: true }),
        status: isRsc ? 200 : 307,
        version: 1,
      });
    });

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [rsc, html],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ classified: 1, dynamic: 1, probed: 1, skipped: 0 });
    expect(result.failures).toEqual([]);
    expect(result.cacheableTargets).toEqual([rsc]);
    expect(result.speculativeTargets).toEqual([rsc]);
    const manifestRoute = Object.values(result.manifest.routes)[0];
    expect(cacheabilityManifestRouteState(manifestRoute, "/conditional", "rsc-full")).toBe(
      "runtime-check",
    );
  });

  it("defers Pages data to final admission when routing may terminate", async () => {
    const root = createProbeRoot();
    const route = {
      cacheabilityProbe: { canPrunePattern: true, requestStageMayTerminate: true },
      kind: "pages-page" as const,
      pattern: "/posts/:slug",
    };
    const html = {
      headers: { Accept: "text/html" },
      kind: "html" as const,
      label: "/posts/one",
      pathname: "/posts/one",
      route,
      sourcePathname: "/posts/one",
    };
    const data = {
      headers: { Accept: "application/json" },
      kind: "pages-data" as const,
      label: "/_next/data/build/posts/one.json (Pages data)",
      pathname: "/_next/data/build/posts/one.json",
      route: {
        ...route,
        cacheabilityProbe: { ...route.cacheabilityProbe, concretePathname: "/posts/one" },
      },
      sourcePathname: "/_next/data/build/posts/one.json",
    };
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const isData = new Headers(init?.headers).get("Accept") === "application/json";
      return Response.json({
        kind: "pages-page",
        pattern: route.pattern,
        ...(isData
          ? { rendererStatic: true, state: "static-candidate" }
          : { scope: "identity", state: "dynamic", terminal: true }),
        status: isData ? 200 : 307,
        version: 1,
      });
    });

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [data, html],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.cacheableTargets).toEqual([data]);
    expect(result.speculativeTargets).toEqual([data]);
  });

  it("authorizes deferred representations within mixed dynamic patterns", async () => {
    const root = createProbeRoot();
    const route = {
      cacheabilityProbe: { canPrunePattern: true, requestStageMayTerminate: true },
      kind: "app-page" as const,
      pattern: "/posts/:slug",
    };
    const firstHtml = { ...target("/posts/one"), route };
    const firstRsc = {
      headers: { Accept: "text/x-component", RSC: "1" },
      kind: "rsc-full" as const,
      label: "/posts/one (RSC full)",
      pathname: "/posts/one?_rsc",
      route,
      sourcePathname: "/posts/one",
    };
    const secondHtml = { ...target("/posts/two"), route };
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
        return Response.json({
          kind: "app-page",
          pattern: route.pattern,
          ...(pathname.endsWith("/one")
            ? { scope: "identity", state: "dynamic", terminal: true }
            : { rendererStatic: true, state: "static-candidate" }),
          status: pathname.endsWith("/one") ? 307 : 200,
          version: 1,
        });
      },
      root,
      targetUrl: "https://example.com",
      targets: [firstHtml, firstRsc, secondHtml],
    });

    expect(result).toMatchObject({ probed: 2, speculativeTargets: [firstRsc] });
    const manifestRoute = Object.values(result.manifest.routes)[0];
    expect(cacheabilityManifestRouteState(manifestRoute, "/posts/one", "rsc-full")).toBe(
      "runtime-check",
    );
  });

  it("unlocks prunable siblings without waiting for every pattern representative", async () => {
    const root = createProbeRoot();
    const slow = target("/slow");
    const fastRoute = optimizableRoute("/fast/:slug");
    const fastFirst = { ...target("/fast/one"), route: fastRoute };
    const fastSecond = { ...target("/fast/two"), route: fastRoute };
    let slowCompleted = false;
    let siblingStartedBeforeSlowCompleted = false;
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 2,
      fetchImpl: async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (pathname === "/slow") {
          await new Promise((resolve) => setTimeout(resolve, 20));
          slowCompleted = true;
        } else if (pathname === "/fast/two") {
          siblingStartedBeforeSlowCompleted = !slowCompleted;
        }
        return Response.json({
          kind: "app-page",
          pattern: pathname === "/slow" ? "/slow" : fastRoute.pattern,
          rendererStatic: true,
          state: "static-candidate",
          status: 200,
          version: 1,
        });
      },
      root,
      targetUrl: "https://example.com",
      targets: [slow, fastFirst, fastSecond],
    });

    expect(result).toMatchObject({ failures: [], probed: 3 });
    expect(siblingStartedBeforeSlowCompleted).toBe(true);
  });

  it("fills idle slots immediately for patterns with pattern-wide pruning", async () => {
    const root = createProbeRoot();
    const route = optimizableRoute("/items/:slug");
    const slow = { ...target("/items/slow"), route };
    const sibling = { ...target("/items/sibling"), route };
    let slowCompleted = false;
    let siblingStartedBeforeSlowCompleted = false;
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 2,
      fetchImpl: async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (pathname === "/items/slow") {
          await new Promise((resolve) => setTimeout(resolve, 20));
          slowCompleted = true;
        } else {
          siblingStartedBeforeSlowCompleted = !slowCompleted;
        }
        return staticProbeResponse(route.pattern);
      },
      root,
      targetUrl: "https://example.com",
      targets: [slow, sibling],
    });

    expect(result).toMatchObject({ failures: [], probed: 2 });
    expect(siblingStartedBeforeSlowCompleted).toBe(true);
  });

  it("does not prune destination siblings before route-moving probes settle", async () => {
    const root = createProbeRoot();
    const destinationRoute = optimizableRoute("/posts/:slug");
    const destinationFirst = { ...target("/posts/one"), route: destinationRoute };
    const destinationSecond = { ...target("/posts/two"), route: destinationRoute };
    const sourceRoute = {
      cacheabilityProbe: { canPrunePattern: true, routeMayResolve: true },
      kind: "app-page" as const,
      pattern: "/source",
    };
    const source = { ...target("/source"), route: sourceRoute };
    const probedPathnames: string[] = [];
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 2,
      fetchImpl: async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
        probedPathnames.push(pathname);
        if (pathname === "/source") {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return Response.json({
            kind: "app-page",
            pattern: destinationRoute.pattern,
            rendererStatic: true,
            routePathname: "/posts/source",
            state: "static-candidate",
            status: 200,
            version: 1,
          });
        }
        return Response.json({
          kind: "app-page",
          pattern: destinationRoute.pattern,
          ...(pathname.endsWith("/one")
            ? { scope: "pattern", state: "dynamic" }
            : { rendererStatic: true, state: "static-candidate" }),
          status: 200,
          version: 1,
        });
      },
      root,
      targetUrl: "https://example.com",
      targets: [destinationFirst, destinationSecond, source],
    });

    expect(result.failures).toEqual([]);
    expect(probedPathnames).toEqual(
      expect.arrayContaining(["/posts/one", "/source", "/posts/two"]),
    );
    expect(result.probed).toBe(3);
  });

  it("does not prune a terminal-capable pattern from one representation", async () => {
    const root = createProbeRoot();
    const route = {
      cacheabilityProbe: { canPrunePattern: true, requestStageMayTerminate: true },
      kind: "app-page" as const,
      pattern: "/posts/:slug",
    };
    const first = { ...target("/posts/one"), route };
    const second = { ...target("/posts/two"), route };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      return Response.json({
        kind: "app-page",
        pattern: route.pattern,
        rendererStatic: pathname.endsWith("/two"),
        scope: pathname.endsWith("/one") ? "pattern" : undefined,
        state: pathname.endsWith("/one") ? "dynamic" : "static-candidate",
        status: 200,
        version: 1,
      });
    });

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 1,
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [first, second],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ dynamic: 1, probed: 2, skipped: 0 });
    expect(result.cacheableTargets).toEqual([second]);
  });

  it.each([
    ["false", { scope: "identity", state: "dynamic", terminal: false }],
    ["non-dynamic", { rendererStatic: true, state: "static-candidate", terminal: true }],
  ])("rejects an invalid %s terminal probe signal", async (_label, probeResult) => {
    const root = createProbeRoot();
    const route = {
      cacheabilityProbe: { canPrunePattern: true, requestStageMayTerminate: true },
      kind: "app-page" as const,
      pattern: "/conditional",
    };
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async () =>
        Response.json({
          kind: "app-page",
          pattern: route.pattern,
          ...probeResult,
          status: 200,
          version: 1,
        }),
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [{ ...target("/conditional"), route }],
    });

    expect(result.failures).toEqual(["/conditional: probe returned an invalid envelope"]);
    expect(result.cacheableTargets).toEqual([]);
  });

  it("leaves representation-specific statuses to the final completed render", async () => {
    const root = createProbeRoot();
    const route = { kind: "app-page" as const, pattern: "/missing" };
    const html = { ...target("/missing"), route };
    const rsc = {
      headers: { Accept: "text/x-component", RSC: "1" },
      kind: "rsc-full" as const,
      label: "/missing (RSC full)",
      pathname: "/missing?_rsc",
      route,
      sourcePathname: "/missing",
    };
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const isRsc = new Headers(init?.headers).get("RSC") === "1";
      return Response.json({
        kind: "app-page",
        pattern: route.pattern,
        rendererStatic: true,
        state: "static-candidate",
        status: isRsc ? 200 : 404,
        version: 1,
      });
    });

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [rsc, html],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ classified: 1, probed: 1, skipped: 0 });
    expect(Object.values(result.manifest.routes)).toEqual([
      expect.objectContaining({
        pattern: route.pattern,
        state: "runtime-check",
        staticPaths: { html: ["/missing"], "rsc-full": ["/missing"] },
      }),
    ]);
  });

  it("requires matching discovered route ownership before sharing an HTML classification", async () => {
    const root = createProbeRoot();
    const html = { ...target("/posts/one"), route: optimizableRoute("/posts/:slug") };
    const rsc = {
      headers: { Accept: "text/x-component", RSC: "1" },
      kind: "rsc-full" as const,
      label: "/posts/one (RSC full)",
      pathname: "/posts/one?_rsc",
      sourcePathname: "/posts/one",
    };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        kind: "app-page",
        pattern: "/posts/:slug",
        rendererStatic: true,
        state: "static-candidate",
        status: 200,
        version: 1,
      }),
    );

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [rsc, html],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.failures).toEqual(["1 warm target is missing route-pattern metadata"]);
  });

  it("uses the first completed pattern-wide dynamic proof to stop queued siblings", async () => {
    const root = createProbeRoot();
    const route = optimizableRoute("/posts/:slug");
    const htmlOne = { ...target("/posts/one"), route };
    const htmlTwo = { ...target("/posts/two"), route };
    const htmlThree = { ...target("/posts/three"), route };
    const rsc = (slug: string) => ({
      headers: { Accept: "text/x-component", RSC: "1" },
      kind: "rsc-full" as const,
      label: `/posts/${slug} (RSC full)`,
      pathname: `/posts/${slug}?_rsc`,
      route,
      sourcePathname: `/posts/${slug}`,
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (pathname === "/posts/one") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return Response.json({
        kind: "app-page",
        pattern: route.pattern,
        scope: "pattern",
        state: "dynamic",
        status: 204,
        version: 1,
      });
    });

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 2,
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [rsc("one"), rsc("two"), rsc("three"), htmlOne, htmlTwo, htmlThree],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ classified: 1, dynamic: 1, probed: 2, skipped: 1 });
    expect(result.cacheableTargets).toEqual([]);
    expect(result.manifest.routes).toEqual({});
  });

  it("retains loading-shell candidates after pattern-wide dynamic proof", async () => {
    const root = createProbeRoot();
    const route = optimizableRoute("/posts/:slug");
    const html = (slug: string) => ({ ...target(`/posts/${slug}`), route });
    const loading = (slug: string) => ({
      headers: { Accept: "text/x-component", RSC: "1" },
      kind: "rsc-loading-shell" as const,
      label: `/posts/${slug} (RSC loading shell)`,
      pathname: `/posts/${slug}?_rsc=loading`,
      route,
      sourcePathname: `/posts/${slug}`,
    });
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        kind: "app-page",
        pattern: route.pattern,
        scope: "pattern",
        state: "dynamic",
        status: 200,
        version: 1,
      }),
    );

    const loadingOne = loading("one");
    const loadingTwo = loading("two");
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 2,
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [loadingOne, loadingTwo, html("one"), html("two")],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ classified: 1, dynamic: 1, probed: 2, skipped: 1 });
    expect(result.cacheableTargets).toEqual([loadingOne, loadingTwo]);
    expect(result.speculativeTargets).toEqual([loadingOne, loadingTwo]);
    expect(Object.values(result.manifest.routes)).toEqual([
      expect.objectContaining({
        pattern: route.pattern,
        runtimeRepresentation: "rsc-loading-shell",
        state: "runtime-check",
      }),
    ]);
  });

  it("classifies each concrete path while storing only exact static paths", async () => {
    // Next.js renders each concrete generateStaticParams candidate during its
    // prerender pass. One representative request cannot provide equivalent
    // evidence for siblings whose dynamic API usage may depend on params.
    const root = createProbeRoot();
    const route = optimizableRoute("/posts/:slug");
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
        return Response.json({
          kind: "app-page",
          pattern: route.pattern,
          rendererStatic: !pathname.endsWith("/conditionally-dynamic"),
          scope: pathname.endsWith("/conditionally-dynamic") ? "identity" : undefined,
          state: pathname.endsWith("/conditionally-dynamic") ? "dynamic" : "static-candidate",
          status: 200,
          version: 1,
        });
      },
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [
        { ...target("/posts/static"), route },
        { ...target("/posts/conditionally-dynamic"), route },
      ],
    });

    expect(result).toMatchObject({ classified: 1, dynamic: 1, probed: 2, skipped: 0 });
    expect(result.cacheableTargets).toHaveLength(1);
    expect(Object.values(result.manifest.routes)).toEqual([
      expect.objectContaining({
        pattern: route.pattern,
        runtimePaths: ["/posts/conditionally-dynamic"],
        state: "runtime-check",
        staticPaths: { html: ["/posts/static"], "rsc-full": ["/posts/static"] },
      }),
    ]);
  });

  describe("App page classification per route", () => {
    const listedRoute = optimizableRoute("/posts/:slug");
    const pickedRoute = {
      ...listedRoute,
      cacheabilityProbe: { ...listedRoute.cacheabilityProbe, unlisted: true },
    };
    const dynamicApi = {
      dynamicUsage: true,
      rendererStatic: false,
      scope: "identity",
      state: "dynamic",
    };
    const veto = { rendererStatic: false, scope: "identity", state: "dynamic" };
    const configOnly = {
      dynamicUsage: true,
      explicitConfigCachePolicy: true,
      rendererStatic: false,
    };

    const pageTargets = (pathname: string, route: typeof listedRoute) => [
      { ...target(pathname), route },
      {
        headers: { Accept: "text/x-component", RSC: "1" },
        kind: "rsc-full" as const,
        label: `${pathname} (RSC full)`,
        pathname: `${pathname}?_rsc`,
        route,
        sourcePathname: pathname,
      },
    ];

    const probe = (
      targets: readonly CdnWarmTarget[],
      fieldsByPathname: Record<string, Record<string, unknown>>,
      options: Partial<Parameters<typeof probeStagedWorkerCacheability>[0]> = {},
    ) =>
      probeStagedWorkerCacheability({
        buildId: "application-build",
        fetchImpl: async (input) => {
          const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
          const route = targets.find(
            (candidate) => candidate.pathname.split("?")[0] === pathname,
          )!.route!;
          return Response.json({
            kind: route.kind,
            pattern: route.pattern,
            rendererStatic: true,
            state: "static-candidate",
            status: 200,
            version: 1,
            ...fieldsByPathname[pathname],
          });
        },
        retries: 0,
        root: createProbeRoot(),
        targetUrl: "https://example.com",
        targets,
        ...options,
      });

    const warmed = (result: Awaited<ReturnType<typeof probe>>) =>
      result.cacheableTargets.map((warm) => `${warm.kind} ${warm.sourcePathname}`).sort();

    it("gives unknown paths on-demand ISR when no listed path used a dynamic API", async () => {
      const result = await probe(
        [
          ...pageTargets("/posts/a", listedRoute),
          ...pageTargets("/posts/vetoed", listedRoute),
          ...pageTargets("/posts/picked-static", pickedRoute),
          ...pageTargets("/posts/picked-dynamic", pickedRoute),
          ...pageTargets("/posts/picked-vetoed", pickedRoute),
        ],
        {
          "/posts/picked-dynamic": dynamicApi,
          "/posts/picked-vetoed": veto,
          "/posts/vetoed": veto,
        },
      );

      expect(result.failures).toEqual([]);
      const route =
        result.manifest.routes[cacheabilityManifestRouteKey("app-page", "/posts/:slug")]!;
      const state = (pathname: string) => cacheabilityManifestRouteState(route, pathname, "html");
      expect(state("/posts/a")).toBe("static-candidate");
      expect(state("/posts/picked-static")).toBe("static-candidate");
      // Left out of both lists, so it gets the static-to-dynamic 500, as in Next.js.
      expect(state("/posts/picked-dynamic")).toBe("static-candidate");
      expect(route.runtimePaths?.map((token) => `${route.pathPrefix ?? ""}${token}`)).toEqual([
        "/posts/picked-vetoed",
        "/posts/vetoed",
      ]);
      expect(state("/posts/unprobed")).toBe("static-candidate");
      expect(warmed(result)).toEqual([
        "html /posts/a",
        "html /posts/picked-static",
        "rsc-full /posts/a",
        "rsc-full /posts/picked-static",
        "rsc-full /posts/picked-vetoed",
        "rsc-full /posts/vetoed",
      ]);
    });

    it("never admits dynamic listed paths or the unlisted paths of their route", async () => {
      const result = await probe(
        [
          ...pageTargets("/posts/a", listedRoute),
          ...pageTargets("/posts/dynamic", listedRoute),
          ...pageTargets("/posts/vetoed", listedRoute),
          ...pageTargets("/posts/picked-static", pickedRoute),
          ...pageTargets("/posts/picked-vetoed", pickedRoute),
          ...pageTargets("/posts/picked-config", pickedRoute),
        ],
        {
          "/posts/dynamic": dynamicApi,
          "/posts/picked-config": configOnly,
          "/posts/picked-vetoed": veto,
          "/posts/vetoed": veto,
        },
      );

      expect(result.failures).toEqual([]);
      const route =
        result.manifest.routes[cacheabilityManifestRouteKey("app-page", "/posts/:slug")]!;
      const state = (pathname: string) => cacheabilityManifestRouteState(route, pathname, "html");
      expect(state("/posts/a")).toBe("static-candidate");
      expect(state("/posts/dynamic")).toBeNull();
      expect(cacheabilityManifestRouteState(route, "/posts/dynamic", "rsc-full")).toBeNull();
      expect(state("/posts/vetoed")).toBe("runtime-check");
      expect(state("/posts/picked-static")).toBeNull();
      expect(state("/posts/picked-vetoed")).toBeNull();
      // Cacheable only through a next.config policy: runtime-checked from any source.
      expect(state("/posts/picked-config")).toBe("runtime-check");
      expect(state("/posts/unprobed")).toBeNull();
      expect(warmed(result)).toEqual([
        "html /posts/a",
        "html /posts/picked-config",
        "rsc-full /posts/a",
        "rsc-full /posts/picked-config",
        "rsc-full /posts/vetoed",
      ]);
    });

    it("counts a config-policy listed path toward on-demand ISR by its dynamic usage", async () => {
      for (const [config, onDemand] of [
        [configOnly, false],
        [{ ...configOnly, dynamicUsage: undefined }, true],
      ] as const) {
        const result = await probe(
          [
            ...pageTargets("/posts/a", listedRoute),
            ...pageTargets("/posts/config", listedRoute),
            ...pageTargets("/posts/picked", pickedRoute),
          ],
          { "/posts/config": config },
        );

        const route =
          result.manifest.routes[cacheabilityManifestRouteKey("app-page", "/posts/:slug")]!;
        const state = (pathname: string) => cacheabilityManifestRouteState(route, pathname, "html");
        expect(state("/posts/config")).toBe("runtime-check");
        expect(state("/posts/picked")).toBe(onDemand ? "static-candidate" : null);
        expect(state("/posts/unprobed")).toBe(onDemand ? "static-candidate" : null);
      }
    });

    it("gives no entry to routes whose paths all used a dynamic API", async () => {
      const aboutRoute = optimizableRoute("/about");
      const fallbackRoute = {
        ...optimizableRoute("/fallback/:id"),
        cacheabilityProbe: {
          canPrunePattern: true,
          unlisted: true,
        },
      };
      const result = await probe(
        [
          ...pageTargets("/posts/dynamic", listedRoute),
          ...pageTargets("/about", aboutRoute),
          ...pageTargets("/fallback/broken", fallbackRoute),
        ],
        {
          "/about": dynamicApi,
          "/fallback/broken": {
            reason: "route returned HTTP 500",
            rendererStatic: undefined,
            state: "probe-failed",
            status: 500,
          },
          "/posts/dynamic": dynamicApi,
        },
        { fallbackRoutePatterns: [{ kind: "app-page", pattern: "/fallback/:id" }] },
      );

      expect(result.failures).toEqual([]);
      expect(result.cacheableTargets).toEqual([]);
      // The fallback route keeps its fallback-only entry once its probed path drops out.
      expect(result.manifest.routes).toEqual({
        [cacheabilityManifestRouteKey("app-page", "/fallback/:id")]: {
          kind: "app-page",
          pattern: "/fallback/:id",
          state: "static-candidate",
        },
      });
    });

    it("OR-merges dynamic usage across probes of one path", async () => {
      const source = {
        ...target("/rewrite-me"),
        route: {
          cacheabilityProbe: { canPrunePattern: true, routeMayResolve: true },
          kind: "app-page" as const,
          pattern: "/rewrite-me",
        },
      };
      for (const delayedPathname of ["/rewrite-me", "/posts/a"]) {
        const result = await probeStagedWorkerCacheability({
          buildId: "application-build",
          concurrency: 2,
          fetchImpl: async (input) => {
            const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
            if (pathname === delayedPathname) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            return Response.json({
              kind: "app-page",
              pattern: "/posts/:slug",
              routePathname: "/posts/a",
              status: 200,
              version: 1,
              ...(pathname === "/rewrite-me" ? dynamicApi : veto),
            });
          },
          retries: 0,
          root: createProbeRoot(),
          targetUrl: "https://example.com",
          targets: [source, { ...target("/posts/a"), route: listedRoute }],
        });

        expect(result.failures).toEqual([]);
        expect(result.cacheableTargets).toEqual([]);
        expect(
          result.manifest.routes[cacheabilityManifestRouteKey("app-page", "/posts/:slug")],
        ).toBeUndefined();
      }
    });

    it("gives no entry to a route whose only generateStaticParams is above its last dynamic segment, even when discovery lists its paths", async () => {
      // app/[category]/page.tsx lists `news` for app/[category]/details too.
      const detailsRoute = optimizableRoute("/:category/details");
      const unlistedDetailsRoute = {
        ...detailsRoute,
        cacheabilityProbe: { ...detailsRoute.cacheabilityProbe, unlisted: true },
      };
      const notStaticallyGenerated = {
        reason: "route is not statically generated",
        rendererStatic: false,
        state: "dynamic",
      };
      const cases: [typeof unlistedDetailsRoute | typeof detailsRoute, Record<string, unknown>][] =
        [
          // The runtime reports the whole pattern dynamic.
          [detailsRoute, { ...notStaticallyGenerated, dynamicUsage: true, scope: "pattern" }],
          // Discovery marks the path unlisted.
          [unlistedDetailsRoute, { ...notStaticallyGenerated, scope: "identity" }],
        ];
      for (const [route, fields] of cases) {
        const result = await probe([...pageTargets("/news/details", route)], {
          "/news/details": fields,
        });

        expect(result.failures).toEqual([]);
        expect(result.manifest.routes).toEqual({});
        expect(result.cacheableTargets).toEqual([]);
      }
    });

    it("gives no entry to a route without generateStaticParams whose only paths are traffic-picked", async () => {
      const itemsRoute = optimizableRoute("/items/:id");
      const pickedItemsRoute = {
        ...itemsRoute,
        cacheabilityProbe: { ...itemsRoute.cacheabilityProbe, unlisted: true },
      };
      const result = await probe(
        [
          ...pageTargets("/items/a", pickedItemsRoute),
          ...pageTargets("/items/b", pickedItemsRoute),
        ],
        {},
      );

      expect(result.failures).toEqual([]);
      expect(result.manifest.routes).toEqual({});
      expect(result.cacheableTargets).toEqual([]);
    });

    it("doesn't treat a static-candidate result without rendererStatic as a config-policy path", async () => {
      // The listed path used a dynamic API, so the route has no on-demand ISR.
      const targets = [
        ...pageTargets("/posts/dynamic", listedRoute),
        ...pageTargets("/posts/picked", pickedRoute),
      ];
      const state = async (fields: Record<string, unknown>) => {
        const result = await probe(targets, {
          "/posts/dynamic": dynamicApi,
          "/posts/picked": fields,
        });
        const route =
          result.manifest.routes[cacheabilityManifestRouteKey("app-page", "/posts/:slug")];
        return route ? cacheabilityManifestRouteState(route, "/posts/picked", "html") : null;
      };

      expect(await state({ rendererStatic: false, state: "static-candidate" })).toBeNull();
      expect(await state(configOnly)).toBe("runtime-check");
    });

    it("counts a listed path that middleware moves toward the destination's listed set only", async () => {
      const movedRoute = {
        ...listedRoute,
        cacheabilityProbe: { ...listedRoute.cacheabilityProbe, routeMayResolve: true },
      };
      const otherRoute = optimizableRoute("/other/:id");
      const moved = { pattern: "/other/:id", routePathname: "/other/x" };
      for (const destinationListsPath of [false, true]) {
        const result = await probe(
          [
            ...pageTargets("/posts/moved", movedRoute),
            ...pageTargets("/posts/picked", pickedRoute),
            ...(destinationListsPath ? pageTargets("/other/x", otherRoute) : []),
          ],
          { "/posts/moved": moved },
        );

        expect(result.failures).toEqual([]);
        // The moved path never gives its origin route on-demand ISR.
        const origin =
          result.manifest.routes[cacheabilityManifestRouteKey("app-page", "/posts/:slug")];
        expect(origin?.allowUnknown).toBeUndefined();
        for (const pathname of ["/posts/picked", "/posts/unprobed"]) {
          expect(
            origin ? cacheabilityManifestRouteState(origin, pathname, "html") : null,
          ).toBeNull();
        }
        const other =
          result.manifest.routes[cacheabilityManifestRouteKey("app-page", "/other/:id")];
        if (destinationListsPath) {
          expect(cacheabilityManifestRouteState(other!, "/other/x", "html")).toBe(
            "static-candidate",
          );
          expect(cacheabilityManifestRouteState(other!, "/other/unprobed", "html")).toBe(
            "static-candidate",
          );
        } else {
          expect(other).toBeUndefined();
        }
      }
    });

    it("certifies the RSC representations of a static HTML render", async () => {
      const aboutRoute = optimizableRoute("/about");
      const rscOnly = pageTargets("/posts/rsc-only", listedRoute)[1]!;
      const result = await probe(
        [...pageTargets("/posts/a", listedRoute), rscOnly, ...pageTargets("/about", aboutRoute)],
        {},
        { loadingBoundaryRoutePatterns: ["/posts/:slug"] },
      );

      expect(result.failures).toEqual([]);
      const posts =
        result.manifest.routes[cacheabilityManifestRouteKey("app-page", "/posts/:slug")]!;
      for (const representation of ["html", "rsc-full", "rsc-loading-shell"] as const) {
        expect(cacheabilityManifestRouteState(posts, "/posts/a", representation)).toBe(
          "static-candidate",
        );
      }
      // Probed only through RSC, so only its RSC render is certified.
      expect(cacheabilityManifestRouteState(posts, "/posts/rsc-only", "rsc-full")).toBe(
        "static-candidate",
      );
      expect(posts.staticPaths?.html).toEqual(["a"]);
      expect(posts.staticPaths?.["rsc-loading-shell"]).toEqual(["a"]);

      const about = result.manifest.routes[cacheabilityManifestRouteKey("app-page", "/about")]!;
      expect(about.staticRepresentation).toBeUndefined();
      expect(cacheabilityManifestRouteState(about, "/about", "html")).toBe("static-candidate");
      expect(cacheabilityManifestRouteState(about, "/about", "rsc-full")).toBe("static-candidate");
      // No loading boundary, so no loading-shell render to certify.
      expect(cacheabilityManifestRouteState(about, "/about", "rsc-loading-shell")).not.toBe(
        "static-candidate",
      );
    });

    it("keeps Pages Router classification unchanged", async () => {
      const pagesRoute = { ...listedRoute, kind: "pages-page" as const };
      const result = await probe(
        [
          { ...target("/posts/a"), route: pagesRoute },
          { ...target("/posts/dynamic"), route: pagesRoute },
        ],
        { "/posts/dynamic": dynamicApi },
      );

      const route =
        result.manifest.routes[cacheabilityManifestRouteKey("pages-page", "/posts/:slug")]!;
      expect(cacheabilityManifestRouteState(route, "/posts/dynamic", "html")).toBe("runtime-check");
      expect(cacheabilityManifestRouteState(route, "/posts/a", "html")).toBe("static-candidate");
    });
  });

  it("records a rewrite source under the concrete route resolved by the request stage", async () => {
    const root = createProbeRoot();
    const source = {
      ...target("/rewrite-me"),
      route: {
        cacheabilityProbe: { canPrunePattern: true, routeMayResolve: true },
        kind: "app-page" as const,
        pattern: "/rewrite-me",
      },
    };
    const direct = {
      ...target("/safe"),
      route: optimizableRoute("/safe"),
    };
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async () =>
        Response.json({
          kind: "app-page",
          pattern: "/safe",
          rendererStatic: true,
          routePathname: "/safe",
          state: "static-candidate",
          status: 200,
          version: 1,
        }),
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [source, direct],
    });

    expect(result.failures).toEqual([]);
    expect(result).toMatchObject({ classified: 1, probed: 2 });
    expect(result.cacheableTargets).toEqual([source, direct]);
    // A route without dynamic segments has no unknown paths to admit.
    expect(result.manifest.routes[cacheabilityManifestRouteKey("app-page", "/safe")]).toEqual({
      kind: "app-page",
      pattern: "/safe",
      state: "runtime-check",
      staticPaths: { html: ["/safe"], "rsc-full": ["/safe"] },
    });
  });

  it("retains deferred representation ownership when the primary resolves elsewhere", async () => {
    const root = createProbeRoot();
    const { html, rsc } = pairedRouteTargets();
    const resolveRequest = (headers: HeadersInit) => {
      const isRsc = new Headers(headers).get("RSC") === "1";
      return {
        kind: "app-page",
        pattern: isRsc ? "/source" : "/html-target",
        rendererStatic: true,
        routePathname: isRsc ? "/source" : "/html-target",
        state: "static-candidate",
        status: 200,
        version: 1,
      };
    };
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) =>
      Response.json(resolveRequest(init?.headers ?? {})),
    );

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [rsc, html],
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers).get("RSC")).toBeNull();
    expect(resolveRequest(rsc.headers)).toMatchObject({
      pattern: "/source",
      routePathname: "/source",
    });
    expect(result.failures).toEqual([]);
    expect(result.cacheableTargets).toEqual([html, rsc]);
    expect(result.speculativeTargets).toEqual([rsc]);
    expect(Object.keys(result.manifest.routes)).toHaveLength(2);
    const sourceManifestRoute =
      result.manifest.routes[cacheabilityManifestRouteKey("app-page", "/source")];
    const targetManifestRoute =
      result.manifest.routes[cacheabilityManifestRouteKey("app-page", "/html-target")];
    expect(sourceManifestRoute).toEqual({
      kind: "app-page",
      pattern: "/source",
      state: "runtime-check",
    });
    expect(targetManifestRoute).toEqual({
      kind: "app-page",
      pattern: "/html-target",
      state: "runtime-check",
      staticPaths: { html: ["/html-target"], "rsc-full": ["/html-target"] },
    });
    expect(cacheabilityManifestRouteState(sourceManifestRoute, "/source", "rsc-full")).toBe(
      "runtime-check",
    );
    expect(cacheabilityManifestRouteState(targetManifestRoute, "/html-target", "html")).toBe(
      "static-candidate",
    );
  });

  it.each([
    {
      change: "route pathname",
      expectedPattern: "/source",
      expectedResolvedState: "static-candidate",
      expectedRoutePathname: "/resolved",
      pattern: "/source",
      routePathname: "/resolved",
    },
    {
      // The destination route lists no paths, so the moved path is unlisted
      // there and, without on-demand ISR, gets no state and no warm request.
      change: "route pattern",
      expectedPattern: "/destination/:slug",
      expectedResolvedState: null,
      expectedRoutePathname: "/source",
      pattern: "/destination/:slug",
      routePathname: "/source",
    },
  ])(
    "retains deferred representation ownership when only the $change changes",
    async ({
      expectedPattern,
      expectedResolvedState,
      expectedRoutePathname,
      pattern,
      routePathname,
    }) => {
      const root = createProbeRoot();
      const { html, route, rsc } = pairedRouteTargets();
      const result = await probeStagedWorkerCacheability({
        buildId: "application-build",
        fetchImpl: async () =>
          Response.json({
            kind: route.kind,
            pattern,
            rendererStatic: true,
            routePathname,
            state: "static-candidate",
            status: 200,
            version: 1,
          }),
        retries: 0,
        root,
        targetUrl: "https://example.com",
        targets: [rsc, html],
      });

      expect(result).toMatchObject({
        cacheableTargets: expectedResolvedState ? [html, rsc] : [rsc],
        failures: [],
        probed: 1,
        speculativeTargets: [rsc],
      });
      const manifestRoute =
        result.manifest.routes[cacheabilityManifestRouteKey(route.kind, route.pattern)];
      expect(cacheabilityManifestRouteState(manifestRoute, "/source", "rsc-full")).toBe(
        "runtime-check",
      );
      const resolvedManifestRoute =
        result.manifest.routes[cacheabilityManifestRouteKey(route.kind, expectedPattern)];
      expect(
        resolvedManifestRoute
          ? cacheabilityManifestRouteState(resolvedManifestRoute, expectedRoutePathname, "html")
          : null,
      ).toBe(expectedResolvedState);
    },
  );

  it("enforces the manifest byte boundary when one probe resolves into two routes", async () => {
    const { html, route, rsc } = pairedRouteTargets();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        kind: route.kind,
        pattern: "/destination/:slug",
        rendererStatic: true,
        routePathname: "/destination/value",
        state: "static-candidate",
        status: 200,
        version: 1,
      }),
    );
    const runProbe = (root: string, maxBytes?: number) =>
      probeStagedWorkerCacheability({
        buildId: "application-build",
        fetchImpl,
        ...(maxBytes === undefined ? {} : { manifestLimits: { maxBytes } }),
        retries: 0,
        root,
        targetUrl: "https://example.com",
        targets: [rsc, html],
      });

    const baseline = await runProbe(createProbeRoot());
    const exactBytes = Buffer.byteLength(JSON.stringify(baseline.manifest));
    await expect(runProbe(createProbeRoot(), exactBytes)).resolves.toMatchObject({ probed: 1 });
    await expect(runProbe(createProbeRoot(), exactBytes - 1)).rejects.toThrow(
      `the limit is ${exactBytes - 1} bytes`,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("records a rewritten App runtime path without a direct destination target", async () => {
    const root = createProbeRoot();
    const source = {
      ...target("/latest"),
      route: {
        cacheabilityProbe: { canPrunePattern: true, routeMayResolve: true },
        kind: "app-page" as const,
        pattern: "/latest",
      },
    };
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async () =>
        Response.json({
          explicitConfigCachePolicy: true,
          kind: "app-page",
          pattern: "/posts/:slug",
          rendererStatic: false,
          routePathname: "/posts/one",
          state: "static-candidate",
          status: 200,
          version: 1,
        }),
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [source],
    });

    expect(result.failures).toEqual([]);
    expect(result.cacheableTargets).toEqual([source]);
    expect(
      result.manifest.routes[cacheabilityManifestRouteKey("app-page", "/posts/:slug")],
    ).toEqual({
      kind: "app-page",
      pattern: "/posts/:slug",
      runtimePaths: ["/posts/one"],
      state: "runtime-check",
    });
  });

  it("records rewritten Pages HTML and data under the resolved GSSP path", async () => {
    const root = createProbeRoot();
    const route = {
      cacheabilityProbe: { canPrunePattern: true, routeMayResolve: true },
      kind: "pages-page" as const,
      pattern: "/latest",
    };
    const html = { ...target("/latest"), route };
    const data = {
      headers: { Accept: "application/json" },
      kind: "pages-data" as const,
      label: "/_next/data/build/latest.json (Pages data)",
      pathname: "/_next/data/build/latest.json",
      route: {
        ...route,
        cacheabilityProbe: { ...route.cacheabilityProbe, concretePathname: "/latest" },
      },
      sourcePathname: "/_next/data/build/latest.json",
    };
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async () =>
        Response.json({
          kind: "pages-page",
          pattern: "/posts/:slug",
          rendererStatic: false,
          routePathname: "/posts/one",
          state: "static-candidate",
          status: 200,
          version: 1,
        }),
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [data, html],
    });

    expect(result.failures).toEqual([]);
    expect(result.cacheableTargets).toEqual([html, data]);
    expect(result.speculativeTargets).toEqual([data]);
    expect(
      result.manifest.routes[cacheabilityManifestRouteKey("pages-page", "/posts/:slug")],
    ).toEqual({
      kind: "pages-page",
      pattern: "/posts/:slug",
      runtimePaths: ["/posts/one"],
      state: "runtime-check",
    });
  });

  it("encodes Unicode route patterns into ByteString probe headers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-probe-unicode-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "dist", "server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist", "server", "vinext-server.json"),
      JSON.stringify({ prerenderSecret: "probe-secret" }),
    );

    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const encodedRoute = new Headers(init?.headers).get(VINEXT_CACHEABILITY_PROBE_ROUTE_HEADER);
      expect(encodedRoute).toContain("%E4%BD%A0%E5%A5%BD");
      expect(JSON.parse(decodeURIComponent(encodedRoute!))).toEqual(["app-page", "/你好"]);
      return Response.json({
        kind: "app-page",
        pattern: "/你好",
        scope: "identity",
        state: "dynamic",
        status: 200,
        version: 1,
      });
    });
    const route = optimizableRoute("/你好");
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [
        {
          headers: { Accept: "text/html" },
          kind: "html",
          label: "/你好",
          pathname: "/你好",
          route,
          sourcePathname: "/你好",
        },
      ],
    });

    expect(result.failures).toEqual([]);
    expect(result.dynamic).toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects an unexpected resolved route without rewrite metadata", async () => {
    const root = createProbeRoot();
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async () =>
        Response.json({
          kind: "app-page",
          pattern: "/unexpected",
          rendererStatic: true,
          state: "static-candidate",
          status: 200,
          version: 1,
        }),
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [target("/expected")],
    });

    expect(result.failures).toEqual(["/expected: probe resolved to unexpected route /unexpected"]);
    expect(result.cacheableTargets).toEqual([]);
  });

  it("regroups resolved routes independently of probe completion order", async () => {
    const source = {
      ...target("/rewrite-me"),
      route: {
        cacheabilityProbe: { canPrunePattern: true, routeMayResolve: true },
        kind: "app-page" as const,
        pattern: "/rewrite-me",
      },
    };
    const direct = { ...target("/safe"), route: optimizableRoute("/safe") };

    for (const delayedPathname of ["/rewrite-me", "/safe"]) {
      const result = await probeStagedWorkerCacheability({
        buildId: "application-build",
        concurrency: 2,
        fetchImpl: async (input) => {
          const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
          if (pathname === delayedPathname) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return Response.json({
            kind: "app-page",
            pattern: "/safe",
            rendererStatic: pathname === "/rewrite-me",
            routePathname: "/safe",
            ...(pathname === "/safe" ? { scope: "pattern" } : {}),
            state: pathname === "/safe" ? "dynamic" : "static-candidate",
            status: 200,
            version: 1,
          });
        },
        retries: 0,
        root: createProbeRoot(),
        targetUrl: "https://example.com",
        targets: [source, direct],
      });

      expect(result.failures).toEqual([]);
      expect(result.cacheableTargets).toEqual([source]);
      expect(result.manifest.routes[cacheabilityManifestRouteKey("app-page", "/safe")]).toEqual({
        kind: "app-page",
        pattern: "/safe",
        runtimePaths: ["/safe"],
        state: "runtime-check",
      });
    }
  });

  it("does not prune siblings when a config cache policy varies within the route pattern", async () => {
    const root = createProbeRoot();
    const route = {
      cacheabilityProbe: { canPrunePattern: false },
      kind: "app-page" as const,
      pattern: "/posts/:slug",
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      const isOrdinary = pathname === "/posts/z-ordinary";
      return Response.json({
        kind: "app-page",
        pattern: route.pattern,
        rendererStatic: !isOrdinary,
        scope: isOrdinary ? "pattern" : undefined,
        state: isOrdinary ? "dynamic" : "static-candidate",
        status: 200,
        version: 1,
      });
    });

    const special = { ...target("/posts/a-special"), route };
    const ordinary = { ...target("/posts/z-ordinary"), route };
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 1,
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [ordinary, special],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ classified: 1, dynamic: 1, probed: 2, skipped: 0 });
    expect(result.cacheableTargets).toEqual([special]);
    expect(Object.values(result.manifest.routes)).toEqual([
      expect.objectContaining({
        pattern: route.pattern,
        runtimePaths: ["/posts/z-ordinary"],
        state: "runtime-check",
        staticPaths: { html: ["/posts/a-special"], "rsc-full": ["/posts/a-special"] },
      }),
    ]);
  });

  it("does not duplicate a concrete-path probe for conditional RSC policy", async () => {
    const root = createProbeRoot();
    const route = {
      cacheabilityProbe: { canPrunePattern: false },
      kind: "app-page" as const,
      pattern: "/conditional",
    };
    const html = { ...target("/conditional"), route };
    const rsc = {
      headers: { Accept: "text/x-component", RSC: "1" },
      kind: "rsc-full" as const,
      label: "/conditional (RSC full)",
      pathname: "/conditional?_rsc",
      route,
      sourcePathname: "/conditional",
    };
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const isRsc = new Headers(init?.headers).get("RSC") === "1";
      return Response.json({
        kind: "app-page",
        pattern: route.pattern,
        rendererStatic: !isRsc,
        scope: isRsc ? "pattern" : undefined,
        state: isRsc ? "dynamic" : "static-candidate",
        status: 200,
        version: 1,
      });
    });

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 1,
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [rsc, html],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ classified: 1, dynamic: 0, probed: 1, skipped: 0 });
    expect(result.cacheableTargets).toEqual([html, rsc]);
    expect(result.speculativeTargets).toEqual([rsc]);
    expect(Object.values(result.manifest.routes)).toEqual([
      expect.objectContaining({
        pattern: route.pattern,
        state: "runtime-check",
        staticPaths: { html: ["/conditional"], "rsc-full": ["/conditional"] },
      }),
    ]);
  });

  it("does not prune siblings from an identity-scoped dynamic observation", async () => {
    const root = createProbeRoot();
    const route = { kind: "app-page" as const, pattern: "/posts/:slug" };
    const html = (slug: string) => ({ ...target(`/posts/${slug}`), route });
    const rsc = (slug: string) => ({
      headers: { Accept: "text/x-component", RSC: "1" },
      kind: "rsc-full" as const,
      label: `/posts/${slug} (RSC full)`,
      pathname: `/posts/${slug}?_rsc`,
      route,
      sourcePathname: `/posts/${slug}`,
    });
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        kind: "app-page",
        pattern: route.pattern,
        scope: "identity",
        state: "dynamic",
        status: 200,
        version: 1,
      }),
    );

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      concurrency: 1,
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [rsc("one"), rsc("two"), html("one"), html("two")],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ classified: 1, dynamic: 1, probed: 2, skipped: 0 });
    expect(result.cacheableTargets).toEqual([rsc("one"), rsc("two")]);
    expect(result.speculativeTargets).toEqual([rsc("one"), rsc("two")]);
    expect(Object.values(result.manifest.routes)).toEqual([
      expect.objectContaining({
        pattern: route.pattern,
        runtimePaths: ["/posts/one", "/posts/two"],
        state: "runtime-check",
      }),
    ]);
  });

  it("keeps a loading-shell warm candidate when the full page is dynamic", async () => {
    const root = createProbeRoot();
    const route = optimizableRoute("/posts/:slug");
    const html = { ...target("/posts/one"), route };
    const fullRsc = {
      headers: { Accept: "text/x-component", RSC: "1" },
      kind: "rsc-full" as const,
      label: "/posts/one (RSC full)",
      pathname: "/posts/one?_rsc",
      route,
      sourcePathname: "/posts/one",
    };
    const loadingShell = {
      headers: { Accept: "text/x-component", RSC: "1" },
      kind: "rsc-loading-shell" as const,
      label: "/posts/one (RSC loading shell)",
      pathname: "/posts/one?_rsc=loading",
      route,
      sourcePathname: "/posts/one",
    };

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async () =>
        Response.json({
          kind: "app-page",
          pattern: route.pattern,
          scope: "identity",
          state: "dynamic",
          status: 200,
          version: 1,
        }),
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [loadingShell, fullRsc, html],
    });

    expect(result.probed).toBe(1);
    expect(result.cacheableTargets).toEqual([fullRsc, loadingShell]);
    expect(result.speculativeTargets).toEqual([fullRsc, loadingShell]);
    expect(Object.values(result.manifest.routes)).toEqual([
      expect.objectContaining({
        pattern: route.pattern,
        runtimePaths: ["/posts/one"],
        state: "runtime-check",
      }),
    ]);
  });

  it("keeps the loading shell of a path whose full page used a dynamic API", async () => {
    const root = createProbeRoot();
    const representations = (route: ReturnType<typeof optimizableRoute>, pathname: string) => ({
      html: { ...target(pathname), route },
      fullRsc: {
        headers: { Accept: "text/x-component", RSC: "1" },
        kind: "rsc-full" as const,
        label: `${pathname} (RSC full)`,
        pathname: `${pathname}?_rsc`,
        route,
        sourcePathname: pathname,
      },
      loadingShell: {
        headers: { Accept: "text/x-component", RSC: "1" },
        kind: "rsc-loading-shell" as const,
        label: `${pathname} (RSC loading shell)`,
        pathname: `${pathname}?_rsc=loading`,
        route,
        sourcePathname: pathname,
      },
    });
    const postsRoute = optimizableRoute("/posts/:slug");
    const dashboardRoute = optimizableRoute("/dashboard");
    const post = representations(postsRoute, "/posts/one");
    const dashboard = representations(dashboardRoute, "/dashboard");

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
        // headers() below loading.tsx makes the full page dynamic.
        return Response.json({
          dynamicUsage: true,
          kind: "app-page",
          pattern: pathname === "/dashboard" ? "/dashboard" : "/posts/:slug",
          scope: "identity",
          state: "dynamic",
          status: 200,
          version: 1,
        });
      },
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [
        post.loadingShell,
        post.fullRsc,
        post.html,
        dashboard.loadingShell,
        dashboard.fullRsc,
        dashboard.html,
      ],
    });

    expect(result.probed).toBe(2);
    expect(result.cacheableTargets).toEqual([dashboard.loadingShell, post.loadingShell]);
    expect(result.speculativeTargets).toEqual([dashboard.loadingShell, post.loadingShell]);
    const postsEntry =
      result.manifest.routes[cacheabilityManifestRouteKey("app-page", "/posts/:slug")];
    const dashboardEntry =
      result.manifest.routes[cacheabilityManifestRouteKey("app-page", "/dashboard")];
    expect(postsEntry).toBeDefined();
    expect(dashboardEntry).toBeDefined();
    expect(parseCacheabilityManifest(JSON.stringify(result.manifest), "application-build")).toEqual(
      result.manifest,
    );
    for (const [entry, pathname] of [
      [postsEntry!, "/posts/one"],
      [dashboardEntry!, "/dashboard"],
    ] as const) {
      expect(cacheabilityManifestRouteState(entry, pathname, "rsc-loading-shell")).toBe(
        "runtime-check",
      );
      expect(cacheabilityManifestRouteState(entry, pathname, "html")).toBeNull();
      expect(cacheabilityManifestRouteState(entry, pathname, "rsc-full")).toBeNull();
    }
    // Only the listed path's loading shell is authorized.
    expect(
      cacheabilityManifestRouteState(postsEntry!, "/posts/two", "rsc-loading-shell"),
    ).toBeNull();
  });

  it("classifies every nodejs.org path while storing one compact exact-path record", async () => {
    const root = createProbeRoot();
    const pathCount = 2_272;
    const htmlTargets = Array.from({ length: pathCount }, (_, index) => {
      const pathname = `/docs/${index}`;
      return {
        ...target(pathname),
        route: optimizableRoute("/docs/:slug"),
      };
    });
    const rscTargets = htmlTargets.map((htmlTarget) => ({
      headers: { Accept: "text/x-component", RSC: "1" },
      kind: "rsc-full" as const,
      label: `${htmlTarget.sourcePathname} (RSC full)`,
      pathname: `${htmlTarget.sourcePathname}?_rsc`,
      route: htmlTarget.route,
      sourcePathname: htmlTarget.sourcePathname,
    }));
    const progress: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      const isDynamic = pathname === `/docs/${pathCount - 1}`;
      return Response.json({
        kind: "app-page",
        pattern: "/docs/:slug",
        rendererStatic: !isDynamic,
        scope: isDynamic ? "identity" : undefined,
        state: isDynamic ? "dynamic" : "static-candidate",
        status: 200,
        version: 1,
      });
    });

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl,
      onProgress(update) {
        progress.push(update.completed);
      },
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [...rscTargets, ...htmlTargets],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(pathCount);
    expect(result).toMatchObject({
      classified: 1,
      dynamic: 1,
      probed: pathCount,
      skipped: 0,
    });
    expect(result.cacheableTargets).toHaveLength((pathCount - 1) * 2 + 1);
    expect(Object.keys(result.manifest.routes)).toHaveLength(1);
    expect(Object.values(result.manifest.routes)).toEqual([
      expect.objectContaining({
        pattern: "/docs/:slug",
        pathPrefix: "/docs/",
        runtimePaths: [`${pathCount - 1}`],
        state: "runtime-check",
        staticPaths: {
          html: Array.from({ length: pathCount - 1 }, (_, index) => `${index}`).sort(),
          "rsc-full": Array.from({ length: pathCount - 1 }, (_, index) => `${index}`).sort(),
        },
      }),
    ]);
    // One exact path string per certified representation is the irreducible
    // safety information. It is still far smaller than per-path route records.
    expect(Buffer.byteLength(JSON.stringify(result.manifest))).toBeLessThan(40 * 1024);
    expect(progress.at(-1)).toBe(pathCount);
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

  it("keeps identity-dynamic patterns eligible for authoritative final-render checks", async () => {
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
        route: optimizableRoute("/static"),
        sourcePathname: "/static",
      },
      {
        headers: { Accept: "text/html" },
        kind: "html" as const,
        label: "/dynamic",
        pathname: "/dynamic",
        route: optimizableRoute("/dynamic"),
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
          rendererStatic: pathname === "/static",
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
      expect.objectContaining({
        pattern: "/dynamic",
        state: "runtime-check",
      }),
      expect.objectContaining({
        pattern: "/static",
        state: "runtime-check",
        staticPaths: { html: ["/static"], "rsc-full": ["/static"] },
      }),
    ]);
  });

  it("uses the exact serialized-byte boundary and stops before later probes", async () => {
    const root = createProbeRoot();
    const firstTarget = target("/one");
    const route: CacheabilityManifestRoute = {
      kind: "app-page",
      pattern: firstTarget.pathname,
      state: "runtime-check",
      staticPaths: { html: [firstTarget.pathname], "rsc-full": [firstTarget.pathname] },
    };
    const key = cacheabilityManifestRouteKey(route.kind, route.pattern);
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
    expect(overflowFetch).toHaveBeenCalledTimes(3);
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
      route: {
        cacheabilityProbe: { canPrunePattern: true },
        kind: "pages-page" as const,
        pattern: "/posts/:slug",
      },
      sourcePathname: "/posts/one",
    };
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async () =>
        Response.json({
          kind: "pages-page",
          pattern: "/posts/:slug",
          rendererStatic: true,
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
        allowUnknown: true,
        kind: "pages-page",
        unknownState: "static-candidate",
        pattern: "/posts/:slug",
        state: "runtime-check",
        staticPaths: { html: ["/posts/one"] },
      }),
    ]);
  });

  it("embeds zero-path static fallback patterns without render probes", async () => {
    const root = createProbeRoot();
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fallbackRoutePatterns: [
        { kind: "app-page", pattern: "/posts/:slug" },
        { kind: "app-route", pattern: "/api/posts/:slug" },
        { kind: "pages-page", pattern: "/legacy/:slug" },
      ],
      root,
      targetUrl: "https://example.com",
      targets: [],
    });

    expect(result).toMatchObject({ classified: 3, probed: 0 });
    expect(Object.values(result.manifest.routes)).toEqual([
      {
        kind: "app-page",
        pattern: "/posts/:slug",
        state: "static-candidate",
      },
      {
        kind: "app-route",
        pattern: "/api/posts/:slug",
        state: "static-candidate",
      },
      {
        kind: "pages-page",
        pattern: "/legacy/:slug",
        state: "static-candidate",
      },
    ]);
  });

  it("merges Pages fallback eligibility with exact private results", async () => {
    const root = createProbeRoot();
    const route = {
      cacheabilityProbe: { canPrunePattern: true },
      kind: "pages-page" as const,
      pattern: "/legacy/:slug",
    };
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fallbackRoutePatterns: [{ kind: "pages-page", pattern: route.pattern }],
      fetchImpl: async () =>
        Response.json({
          kind: "pages-page",
          pattern: route.pattern,
          state: "dynamic",
          status: 200,
          version: 1,
        }),
      root,
      targetUrl: "https://example.com",
      targets: [{ ...target("/legacy/known"), route }],
    });

    expect(result).toMatchObject({ classified: 1, dynamic: 1, probed: 1 });
    const manifestRoute =
      result.manifest.routes[cacheabilityManifestRouteKey("pages-page", route.pattern)];
    expect(manifestRoute).toEqual({
      allowUnknown: true,
      kind: "pages-page",
      pattern: route.pattern,
      runtimePaths: ["/legacy/known"],
      state: "runtime-check",
      unknownState: "static-candidate",
    });
    expect(cacheabilityManifestRouteState(manifestRoute, "/legacy/known", "html")).toBe(
      "runtime-check",
    );
    expect(cacheabilityManifestRouteState(manifestRoute, "/legacy/unlisted", "html")).toBe(
      "static-candidate",
    );
  });

  it("keeps response-policy-only cacheability as an exact runtime check", async () => {
    const root = createProbeRoot();
    const route = optimizableRoute("/posts/:slug");
    const html = { ...target("/posts/config-public"), route };
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async () =>
        Response.json({
          kind: "app-page",
          pattern: route.pattern,
          rendererStatic: false,
          state: "static-candidate",
          status: 200,
          version: 1,
        }),
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [html],
    });

    expect(result.cacheableTargets).toEqual([html]);
    expect(Object.values(result.manifest.routes)).toEqual([
      expect.objectContaining({
        pattern: route.pattern,
        runtimePaths: ["/posts/config-public"],
        state: "runtime-check",
      }),
    ]);
  });

  it("keeps a literal response-policy-only route as a runtime check", async () => {
    const root = createProbeRoot();
    const route = optimizableRoute("/config-public");
    const html = { ...target("/config-public"), route };
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async () =>
        Response.json({
          kind: "app-page",
          pattern: route.pattern,
          rendererStatic: false,
          state: "static-candidate",
          status: 200,
          version: 1,
        }),
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [html],
    });

    expect(Object.values(result.manifest.routes)).toEqual([
      {
        kind: "app-page",
        pattern: route.pattern,
        state: "runtime-check",
      },
    ]);
  });

  it("probes basePath default-locale Pages HTML and data as one concrete path", async () => {
    const root = createProbeRoot();
    const htmlRoute = {
      cacheabilityProbe: { canPrunePattern: true },
      kind: "pages-page" as const,
      pattern: "/posts/:slug",
    };
    const html = {
      headers: { Accept: "text/html" },
      kind: "html" as const,
      label: "/docs/posts/one/",
      pathname: "/docs/posts/one/",
      route: htmlRoute,
      sourcePathname: "/docs/posts/one/",
    };
    const data = {
      headers: { Accept: "application/json" },
      kind: "pages-data" as const,
      label: "/docs/_next/data/build-a/en/posts/one.json (Pages data)",
      pathname: "/docs/_next/data/build-a/en/posts/one.json",
      route: {
        ...htmlRoute,
        cacheabilityProbe: {
          canPrunePattern: true,
          concretePathname: "/docs/posts/one",
        },
      },
      sourcePathname: "/docs/_next/data/build-a/en/posts/one.json",
    };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        kind: "pages-page",
        pattern: htmlRoute.pattern,
        rendererStatic: true,
        state: "static-candidate",
        status: 200,
        version: 1,
      }),
    );

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [data, html],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.cacheableTargets).toEqual([html, data]);
    expect(result.speculativeTargets).toEqual([data]);
  });

  it("records a statically eligible App Route Handler identity", async () => {
    const root = createProbeRoot();
    const appRouteTarget = {
      headers: { Accept: "*/*" },
      kind: "app-route" as const,
      label: "/api/data (Route Handler)",
      pathname: "/api/data",
      route: {
        cacheabilityProbe: { canPrunePattern: true },
        kind: "app-route" as const,
        pattern: "/api/data",
      },
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
        state: "static-candidate",
      }),
    ]);
  });
});
