import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeStagedWorkerCacheability } from "../packages/cloudflare/src/cacheability-probe.js";
import { VINEXT_CDN_BUILD_ID_HEADER } from "../packages/cloudflare/src/cache/cdn-build-id.js";
import {
  cacheabilityManifestRouteState,
  cacheabilityManifestRouteKey,
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
    route: optimizableRoute(pathname),
    sourcePathname: pathname,
  });

  const optimizableRoute = (pattern: string) => ({
    cacheabilityProbe: { canPrunePattern: true },
    kind: "app-page" as const,
    pattern,
  });

  const createStaticProbeFetch = () =>
    vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      return Response.json({
        kind: "app-page",
        pattern: pathname,
        rendererStatic: true,
        state: "static-candidate",
        status: 200,
        version: 1,
      });
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
      staticPaths: { html: ["/cached/intro"] },
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

  it("aborts when cacheability probing makes no progress", async () => {
    const root = createProbeRoot();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("staged version unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("staged version unavailable", { status: 503 }))
      // The no-progress watchdog remains authoritative even if fetch ignores abort.
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
    ).rejects.toThrow("cacheability probing made no progress for 25ms");
    expect(fetchImpl).toHaveBeenCalled();
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(3);
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
        staticPaths: { html: ["/posts/one"] },
      }),
    ]);
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
        staticRepresentation: "html",
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

  it("uses pattern-wide dynamic proof to skip sibling HTML and RSC renders", async () => {
    const root = createProbeRoot();
    const route = optimizableRoute("/posts/:slug");
    const htmlOne = { ...target("/posts/one"), route };
    const htmlTwo = { ...target("/posts/two"), route };
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
        scope: "pattern",
        state: "dynamic",
        status: 204,
        version: 1,
      }),
    );

    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [rsc("one"), rsc("two"), htmlOne, htmlTwo],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ classified: 1, dynamic: 1, probed: 1, skipped: 1 });
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
      fetchImpl,
      retries: 0,
      root,
      targetUrl: "https://example.com",
      targets: [loadingOne, loadingTwo, html("one"), html("two")],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ classified: 1, dynamic: 1, probed: 1, skipped: 1 });
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
        staticPaths: { html: ["/posts/static"] },
      }),
    ]);
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
        staticPaths: { html: ["/posts/a-special"] },
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
        staticRepresentation: "html",
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
        },
      }),
    ]);
    // One exact path string per cacheable render is the irreducible safety
    // information. It is still far smaller than per-HTML/RSC route records.
    expect(Buffer.byteLength(JSON.stringify(result.manifest))).toBeLessThan(20 * 1024);
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
        staticRepresentation: "html",
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
      staticRepresentation: "html",
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
