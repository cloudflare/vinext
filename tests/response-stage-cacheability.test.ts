import { describe, expect, it } from "vite-plus/test";
import {
  readWorkerCacheabilityProbeMode,
  type WorkerCacheabilityProbeMode,
} from "../packages/vinext/src/server/cacheability-request.js";
import { cacheabilityManifestRouteKey } from "../packages/vinext/src/server/cacheability-manifest.js";
import { withResponseStageCacheability } from "../packages/vinext/src/server/response-stage-cacheability.js";
import {
  CACHEABILITY_REQUEST_STATE,
  type RouteCacheabilityState,
} from "../packages/vinext/src/shims/cacheability-classification.js";
import {
  setCdnCacheAdapter,
  type CdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";

function admissionAdapter(): CdnCacheAdapter {
  return {
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
      state: "static-candidate",
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
        policyHeaders: [["CDN-Cache-Control", "public, s-maxage=90"]],
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
        return new Response("dynamic");
      },
    );

    expect(response.headers.get("CDN-Cache-Control")).toBe("public, s-maxage=90");
    await expect(response.text()).resolves.toBe("dynamic");
  });
});
