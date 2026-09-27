import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  finalizeRequestStageCacheabilityProbe,
  readWorkerCacheabilityProbeRoute,
  readWorkerCacheabilityProbeMode,
  serializeWorkerCacheabilityProbeRoute,
  type WorkerCacheabilityProbeMode,
} from "../packages/vinext/src/server/cacheability-request.js";
import { VINEXT_CACHEABILITY_PROBE_ROUTE_HEADER } from "../packages/vinext/src/server/headers.js";
import { cacheabilityManifestRouteKey } from "../packages/vinext/src/server/cacheability-manifest.js";
import { withResponseStageCacheability } from "../packages/vinext/src/server/response-stage-cacheability.js";
import {
  CACHEABILITY_REQUEST_STATE,
  type RouteCacheabilityState,
} from "../packages/vinext/src/shims/cacheability-classification.js";
import {
  DefaultCdnCacheAdapter,
  setCdnCacheAdapter,
  type CdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";
import { handleMetadataRouteRequest } from "../packages/vinext/src/server/metadata-route-response.js";
import type { MetadataFileRoute } from "../packages/vinext/src/server/metadata-routes.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";
import { CloudflareCdnCacheAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.runtime.js";

afterEach(() => setCdnCacheAdapter(new DefaultCdnCacheAdapter()));

function admissionAdapter(): CdnCacheAdapter {
  return {
    buildResponseHeaders: ({ cacheControl }) => ({ "Cache-Control": cacheControl }),
    ownsBackgroundRevalidation: false,
    requiresCompletedResponseAdmission: true,
    responsePolicy: {
      isHeader: (name) => name.toLowerCase() === "cdn-cache-control",
      readCacheControl: (headers) =>
        headers.get("CDN-Cache-Control") ?? headers.get("Cache-Control"),
      hasExplicitNonCacheablePolicy: (headers) =>
        headers.get("CDN-Cache-Control")?.includes("no-store") === true,
    },
    responseVary: "verbatim",
    async get() {
      return null;
    },
    async revalidateTag() {},
    async set() {},
  };
}

function contextState(context: ExecutionContext): RouteCacheabilityState | undefined {
  return Reflect.get(context, CACHEABILITY_REQUEST_STATE) as RouteCacheabilityState | undefined;
}

type ExecutionContext = { waitUntil(promise: Promise<unknown>): void };

function baseContext(): ExecutionContext {
  return { waitUntil() {} };
}

function registerAdapter(): void {
  setCdnCacheAdapter(admissionAdapter());
}

describe("response-stage cacheability", () => {
  it("authenticates probe mode before request headers are filtered", () => {
    const request = new Request("https://example.com/page", {
      headers: {
        "X-Vinext-Cacheability-Probe": "identity",
        "X-Vinext-Prerender-Secret": "secret",
      },
    });

    expect(readWorkerCacheabilityProbeMode(request, "secret")).toBe("identity");
    expect(readWorkerCacheabilityProbeMode(request, "different-secret")).toBeNull();
  });

  it("returns a terminal request-stage result without waiting for body cancellation", async () => {
    let cancelCalled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalled = true;
        return new Promise<void>(() => {});
      },
    });
    const route = { kind: "app-page" as const, pattern: "/你好" };
    const serializedRoute = serializeWorkerCacheabilityProbeRoute(route);
    expect(serializedRoute).toContain("%E4%BD%A0%E5%A5%BD");
    const request = new Request("https://example.com/%E4%BD%A0%E5%A5%BD", {
      headers: {
        [VINEXT_CACHEABILITY_PROBE_ROUTE_HEADER]: serializedRoute,
      },
    });

    const response = finalizeRequestStageCacheabilityProbe(new Response(body, { status: 307 }), {
      mode: "probe",
      responseStageDispatched: false,
      route: readWorkerCacheabilityProbeRoute(request),
    });

    expect(cancelCalled).toBe(true);
    await expect(response.json()).resolves.toMatchObject({
      kind: "app-page",
      pattern: "/你好",
      scope: "identity",
      state: "dynamic",
      status: 307,
      terminal: true,
    });
  });

  it("skips ordinary admission for bypassed renders", async () => {
    const context = baseContext();
    const response = new Response("private");
    const rendered = await withResponseStageCacheability(
      {
        buildId: "build-a",
        cache: "bypass",
        context,
        rawManifest: null,
        registerCacheAdapters: registerAdapter,
        request: new Request("https://example.com/page", {
          headers: { Accept: "text/html" },
        }),
      },
      async (renderContext) => {
        expect(renderContext).toBe(context);
        expect(contextState(renderContext)).toBeUndefined();
        return response;
      },
    );

    expect(rendered).toBe(response);
    await expect(rendered.text()).resolves.toBe("private");
  });

  it("lets an adapter stream a miss while completed-response admission continues", async () => {
    let closeBody!: () => void;
    let admittedResponse!: Promise<Response>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("shell"));
        closeBody = () => controller.close();
      },
    });
    const adapter = admissionAdapter();
    setCdnCacheAdapter({
      ...adapter,
      deferCompletedPageResponseAdmission(response, complete) {
        const [foreground, candidate] = response.body!.tee();
        admittedResponse = complete(new Response(candidate, response));
        return new Response(foreground, response);
      },
    });

    const response = await withResponseStageCacheability(
      {
        buildId: "build-a",
        cache: "shared",
        context: baseContext(),
        rawManifest: null,
        registerCacheAdapters() {},
        request: new Request("https://example.com/page", {
          headers: { Accept: "text/html" },
        }),
      },
      async (context) => {
        const state = contextState(context)!;
        state.route = { kind: "app-page", pattern: "/page" };
        state.outcome = { cacheable: true, cacheControl: "s-maxage=60" };
        state.frameworkResponseCachePolicy = new Headers({ "Cache-Control": "no-store" });
        return new Response(body, { headers: { "Cache-Control": "no-store" } });
      },
    );

    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    let admissionSettled = false;
    void admittedResponse.finally(() => {
      admissionSettled = true;
    });
    await Promise.resolve();
    expect(admissionSettled).toBe(false);

    closeBody();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    const admitted = await admittedResponse;
    expect(admitted.headers.get("Cache-Control")).toBe("s-maxage=60");
    await expect(admitted.text()).resolves.toBe("shell");
  });

  it("completes manifest-certified pages before returning static-to-dynamic failures", async () => {
    const route = { kind: "app-page" as const, pattern: "/page", state: "static-candidate" };
    const rawManifest = JSON.stringify({
      buildId: "build-a",
      routes: { [cacheabilityManifestRouteKey(route.kind, route.pattern)]: route },
      version: 1,
    });
    const adapter = admissionAdapter();
    let deferred = false;
    setCdnCacheAdapter({
      ...adapter,
      deferCompletedPageResponseAdmission() {
        deferred = true;
        return null;
      },
    });

    // Ported from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-static/app-static.test.ts
    const response = await withResponseStageCacheability(
      {
        buildId: "build-a",
        cache: "shared",
        context: baseContext(),
        rawManifest,
        registerCacheAdapters() {},
        request: new Request("https://example.com/page", {
          headers: { Accept: "text/html" },
        }),
      },
      async (context) => {
        const state = contextState(context)!;
        state.route = { kind: "app-page", pattern: "/page" };
        state.outcome = { cacheable: false, dynamicUsage: true };
        return new Response("dynamic");
      },
    );

    expect(deferred).toBe(false);
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain("changed from static to dynamic");
  });

  it("runs authenticated probes even when the response transport bypasses caching", async () => {
    let closeBody!: () => void;
    let markRenderStarted!: () => void;
    const renderStarted = new Promise<void>((resolve) => {
      markRenderStarted = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("rendered"));
        closeBody = () => controller.close();
      },
    });
    let settled = false;
    const responsePromise = withResponseStageCacheability(
      {
        buildId: "build-a",
        cache: "bypass",
        context: baseContext(),
        probeMode: "probe" satisfies WorkerCacheabilityProbeMode,
        rawManifest: null,
        registerCacheAdapters: registerAdapter,
        request: new Request("https://example.com/page"),
        resolvedRoutePathname: "/resolved/page",
      },
      async (context) => {
        markRenderStarted();
        const state = contextState(context)!;
        state.route = { kind: "app-page", pattern: "/page" };
        state.outcome = { cacheable: true, cacheControl: "s-maxage=60" };
        return new Response(body);
      },
    ).finally(() => {
      settled = true;
    });

    await renderStarted;
    await Promise.resolve();
    expect(settled).toBe(false);
    closeBody();
    const response = await responsePromise;
    await expect(response.json()).resolves.toMatchObject({
      kind: "app-page",
      routePathname: "/resolved/page",
      state: "static-candidate",
    });
  });

  it("preserves a statically known force-dynamic segment during probing", async () => {
    const response = await withResponseStageCacheability(
      {
        buildId: "build-a",
        cache: "bypass",
        context: baseContext(),
        forceDynamic: true,
        probeMode: "probe",
        rawManifest: null,
        registerCacheAdapters: registerAdapter,
        request: new Request("https://example.com/client-page"),
        resolvedRoutePathname: "/client-page",
      },
      async (context) => {
        const state = contextState(context)!;
        state.route = { kind: "app-page", pattern: "/client-page" };
        state.outcome = { cacheable: true, cacheControl: "s-maxage=60" };
        return new Response("rendered");
      },
    );

    await expect(response.json()).resolves.toMatchObject({
      kind: "app-page",
      pattern: "/client-page",
      reason: 'dynamic = "force-dynamic"',
      scope: "pattern",
      state: "dynamic",
    });
  });

  it("uses the rewritten route pathname without changing public request identity", async () => {
    const route = {
      kind: "app-page" as const,
      pattern: "/target",
      paths: { "/target": "static-candidate" as const },
      state: "runtime-check" as const,
    };
    const routeKey = cacheabilityManifestRouteKey(route.kind, route.pattern);
    const rawManifest = JSON.stringify({
      buildId: "build-a",
      routes: { [routeKey]: route },
      version: 1,
    });

    const response = await withResponseStageCacheability(
      {
        buildId: "build-a",
        cache: "shared",
        context: baseContext(),
        rawManifest,
        registerCacheAdapters: registerAdapter,
        request: new Request("https://example.com/public?ref=1", {
          headers: { Accept: "text/html" },
        }),
        resolvedRoutePathname: "/target",
      },
      async (context) => {
        const state = contextState(context)!;
        expect(state.admission).toMatchObject({
          requestKey: "/public?ref=1",
          routePathname: "/target",
        });
        state.route = { kind: "app-page", pattern: "/target" };
        state.outcome = { cacheable: true, cacheControl: "s-maxage=60" };
        return new Response("static");
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("s-maxage=60");
    await expect(response.text()).resolves.toBe("static");
  });

  it("applies safe config policy before final admission without overriding late vetoes", async () => {
    const response = await withResponseStageCacheability(
      {
        buildId: "build-a",
        cache: "shared",
        context: baseContext(),
        policyHeaders: [["Cache-Control", "public, s-maxage=60"]],
        rawManifest: null,
        registerCacheAdapters: registerAdapter,
        request: new Request("https://example.com/dynamic", {
          headers: { Accept: "text/html" },
        }),
        resolvedRoutePathname: "/dynamic",
      },
      async (context) => {
        const state = contextState(context)!;
        state.route = { kind: "app-page", pattern: "/dynamic" };
        state.outcome = { cacheable: false };
        return new Response("draft", {
          headers: { "Set-Cookie": "__prerender_bypass=secret; Path=/" },
        });
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("Set-Cookie")).toContain("__prerender_bypass");
  });

  it("allows safe config policy to publish an otherwise dynamic response", async () => {
    const response = await withResponseStageCacheability(
      {
        buildId: "build-a",
        cache: "shared",
        context: baseContext(),
        policyHeaders: [
          ["CDN-Cache-Control", "public, s-maxage=90"],
          ["Vary", "x-visitor"],
        ],
        rawManifest: null,
        registerCacheAdapters: registerAdapter,
        request: new Request("https://example.com/dynamic", {
          headers: { Accept: "text/html" },
        }),
        resolvedRoutePathname: "/dynamic",
      },
      async (context) => {
        const state = contextState(context)!;
        state.route = { kind: "app-page", pattern: "/dynamic" };
        state.outcome = { cacheable: false };
        return new Response("dynamic", { headers: { Vary: "RSC" } });
      },
    );

    expect(response.headers.get("CDN-Cache-Control")).toBe("public, s-maxage=90");
    expect(response.headers.get("Vary")).toBe("RSC, x-visitor");
    await expect(response.text()).resolves.toBe("dynamic");
  });

  it("admits policy declared by a provider-neutral CDN adapter", async () => {
    const adapter = admissionAdapter();
    setCdnCacheAdapter({
      ...adapter,
      buildResponseHeaders: ({ cacheControl }) => ({
        "Cache-Control": "max-age=0, must-revalidate",
        "X-Example-Edge-Policy": cacheControl,
      }),
      responsePolicy: {
        isHeader: (name) => name.toLowerCase() === "x-example-edge-policy",
        readCacheControl: (headers) =>
          headers.get("X-Example-Edge-Policy") ?? headers.get("Cache-Control"),
        hasExplicitNonCacheablePolicy: () => false,
      },
    });

    const response = await withResponseStageCacheability(
      {
        buildId: "build-a",
        cache: "shared",
        context: baseContext(),
        policyHeaders: [["X-Example-Edge-Policy", "public, s-maxage=90"]],
        rawManifest: null,
        registerCacheAdapters() {},
        request: new Request("https://example.com/dynamic", {
          headers: { Accept: "text/html" },
        }),
        resolvedRoutePathname: "/dynamic",
      },
      async (context) => {
        const state = contextState(context)!;
        state.route = { kind: "app-page", pattern: "/dynamic" };
        state.outcome = { cacheable: false };
        return new Response("dynamic");
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("max-age=0, must-revalidate");
    expect(response.headers.get("X-Example-Edge-Policy")).toBe("public, s-maxage=90");
    await expect(response.text()).resolves.toBe("dynamic");
  });

  it("applies adapter policy headers to a route response whose body already completed", async () => {
    const adapter = admissionAdapter();
    setCdnCacheAdapter({
      ...adapter,
      buildResponseHeaders: ({ cacheControl }) => ({
        "Cache-Control": "max-age=0, must-revalidate",
        "CDN-Cache-Control": cacheControl,
      }),
    });

    const response = await withResponseStageCacheability(
      {
        buildId: "build-a",
        cache: "shared",
        context: baseContext(),
        rawManifest: null,
        registerCacheAdapters() {},
        request: new Request("https://example.com/api/explicit", {
          headers: { Accept: "application/json" },
        }),
        resolvedRoutePathname: "/api/explicit",
      },
      async (context) => {
        const state = contextState(context)!;
        state.route = { kind: "app-route", pattern: "/api/explicit" };
        state.completedResponseBody = true;
        state.explicitResponseCachePolicy = true;
        return new Response("complete", {
          headers: { "Cache-Control": "public, s-maxage=60" },
        });
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("max-age=0, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBe("public, s-maxage=60");
    await expect(response.text()).resolves.toBe("complete");
  });

  it("admits an explicitly public Pages API response after clean body completion", async () => {
    const response = await withResponseStageCacheability(
      {
        buildId: "build-a",
        cache: "shared",
        context: baseContext(),
        rawManifest: null,
        registerCacheAdapters: registerAdapter,
        request: new Request("https://example.com/api/public", {
          headers: { Accept: "application/json" },
        }),
        resolvedRoutePathname: "/api/public",
      },
      async (context) => {
        contextState(context)!.route = { kind: "pages-api", pattern: "/api/public" };
        return new Response('{"public":true}', {
          headers: { "Cache-Control": "public, s-maxage=60" },
        });
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
    await expect(response.json()).resolves.toEqual({ public: true });
  });

  it("keeps a Pages API private without an explicit public policy", async () => {
    const response = await withResponseStageCacheability(
      {
        buildId: "build-a",
        cache: "shared",
        context: baseContext(),
        rawManifest: null,
        registerCacheAdapters: registerAdapter,
        request: new Request("https://example.com/api/private", {
          headers: { Accept: "application/json" },
        }),
        resolvedRoutePathname: "/api/private",
      },
      async (context) => {
        contextState(context)!.route = { kind: "pages-api", pattern: "/api/private" };
        return new Response('{"private":true}');
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    await expect(response.json()).resolves.toEqual({ private: true });
  });
});

describe("response-stage metadata route admission", () => {
  const YEAR = "public, immutable, no-transform, max-age=31536000";
  const PATTERN = "/:locale/event/:city/:eventId/opengraph-image";

  function eventImageRoute(response: () => Response): MetadataFileRoute {
    return {
      type: "opengraph-image",
      isDynamic: true,
      filePath: "/tmp/app/[locale]/event/[city]/[eventId]/opengraph-image.tsx",
      routePrefix: "/[locale]/event/[city]/[eventId]",
      routeSegments: ["[locale]", "event", "[city]", "[eventId]"],
      servedUrl: "/[locale]/event/[city]/[eventId]/opengraph-image",
      patternParts: [":locale", "event", ":city", ":eventId", "opengraph-image"],
      contentType: "image/png",
      module: { default: response },
    };
  }

  async function renderEventImage(options: {
    headers?: HeadersInit;
    method?: string;
    response: () => Response;
  }): Promise<{ response: Response; state: RouteCacheabilityState | undefined }> {
    const pathname = "/en/event/london/42/opengraph-image";
    let state: RouteCacheabilityState | undefined;
    const response = await withResponseStageCacheability(
      {
        buildId: "build-a",
        cache: "shared",
        context: baseContext(),
        rawManifest: JSON.stringify({ buildId: "build-a", routes: {}, version: 1 }),
        registerCacheAdapters: () => setCdnCacheAdapter(new CloudflareCdnCacheAdapter()),
        request: new Request(`https://example.com${pathname}`, {
          headers: options.headers,
          method: options.method,
        }),
        resolvedRoutePathname: pathname,
      },
      async (context) => {
        state = contextState(context);
        const rendered = await runWithRequestContext(
          createRequestContext({ executionContext: context }),
          () =>
            handleMetadataRouteRequest({
              cleanPathname: pathname,
              makeThenableParams: (params) => Object.assign(Promise.resolve(params), params),
              metadataRoutes: [eventImageRoute(options.response)],
            }),
        );
        return rendered!;
      },
    );
    return { response, state };
  }

  function png(headers: HeadersInit, status = 200): () => Response {
    return () =>
      new Response("png-bytes", {
        headers: { "Content-Type": "image/png", ...Object.fromEntries(new Headers(headers)) },
        status,
      });
  }

  it.each(["GET", "HEAD"])(
    "admits a dynamic opengraph-image on its own public Cache-Control for %s",
    async (method) => {
      const { response, state } = await renderEventImage({
        method,
        response: png({ "Cache-Control": YEAR }),
      });

      expect(state?.route).toEqual({ kind: "app-route", pattern: PATTERN });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe(YEAR);
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
      expect(response.headers.get("Content-Type")).toBe("image/png");
      await expect(response.text()).resolves.toBe("png-bytes");
    },
  );

  it.each([
    ["the route opts out with no-store", { response: png({ "Cache-Control": "no-store" }) }],
    [
      "the route sets a cookie",
      { response: png({ "Cache-Control": YEAR, "Set-Cookie": "seen=1; Path=/" }) },
    ],
    [
      "the request carries a cookie",
      { headers: { Cookie: "session=1" }, response: png({ "Cache-Control": YEAR }) },
    ],
    [
      "the request carries authorization",
      { headers: { Authorization: "Bearer token" }, response: png({ "Cache-Control": YEAR }) },
    ],
    ["the route fails with a 5xx", { response: png({ "Cache-Control": YEAR }, 503) }],
    ["the request is not a read", { method: "POST", response: png({ "Cache-Control": YEAR }) }],
    ["the route relies on the framework default", { response: png({}) }],
  ])("keeps a metadata route private when %s", async (_label, options) => {
    const { response } = await renderEventImage(options);

    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("png-bytes");
  });
});
