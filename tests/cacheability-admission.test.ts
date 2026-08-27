import { describe, expect, it } from "vite-plus/test";
import {
  captureCacheabilityAdmissionBody,
  createCacheabilityAdmissionCaptureBudget,
  createWorkerCacheabilityAdmissionContext,
  createWorkerCacheabilityContext,
  finalizeWorkerCacheabilityResponse,
} from "../packages/vinext/src/server/cacheability-request.js";
import {
  CACHEABILITY_REQUEST_STATE,
  type RouteCacheabilityState,
} from "../packages/vinext/src/shims/cacheability-classification.js";
import {
  cacheabilityManifestRouteKey,
  type CacheabilityManifestRoute,
} from "../packages/vinext/src/server/cacheability-manifest.js";
import {
  DefaultCdnCacheAdapter,
  setCdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";
import { CloudflareCdnCacheAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.runtime.js";

const encoder = new TextEncoder();

describe("cacheability admission capture", () => {
  it("preserves all bytes when the bounded capture limit is exceeded", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("first"));
        controller.enqueue(encoder.encode("second"));
        controller.close();
      },
    });

    const captured = await captureCacheabilityAdmissionBody(body, Date.now() + 1_000, 5);
    expect(captured.kind).toBe("fallback");
    await expect(new Response(captured.body).text()).resolves.toBe("firstsecond");
  });

  it("falls back to the private stream without cancelling a slow response", async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.enqueue(encoder.encode("slow"));
        controller.close();
      },
    });

    const captured = await captureCacheabilityAdmissionBody(body, Date.now() + 5);
    expect(captured.kind).toBe("fallback");
    await expect(new Response(captured.body).text()).resolves.toBe("slow");
  });

  it("bounds completed captures across concurrent isolate requests", async () => {
    const budget = createCacheabilityAdmissionCaptureBudget(5);
    const first = await captureCacheabilityAdmissionBody(
      new Response("first").body,
      Date.now() + 1_000,
      10,
      budget,
    );
    expect(first.kind).toBe("captured");
    expect(budget.reservedBytes).toBe(5);

    const second = await captureCacheabilityAdmissionBody(
      new Response("second").body,
      Date.now() + 1_000,
      10,
      budget,
    );
    expect(second.kind).toBe("fallback");
    await expect(new Response(second.body).text()).resolves.toBe("second");
    expect(budget.reservedBytes).toBe(5);

    await expect(new Response(first.body).text()).resolves.toBe("first");
    expect(budget.reservedBytes).toBe(0);
  });

  it("releases the isolate reservation when a captured response is cancelled", async () => {
    const budget = createCacheabilityAdmissionCaptureBudget(5);
    const captured = await captureCacheabilityAdmissionBody(
      new Response("first").body,
      Date.now() + 1_000,
      10,
      budget,
    );
    expect(captured.kind).toBe("captured");
    expect(budget.reservedBytes).toBe(5);

    await captured.body?.cancel();
    expect(budget.reservedBytes).toBe(0);
  });
});

function cacheabilityState(context: object): RouteCacheabilityState {
  return Reflect.get(context, CACHEABILITY_REQUEST_STATE) as RouteCacheabilityState;
}

function staticManifestRoute(): { raw: string; route: CacheabilityManifestRoute } {
  const route: CacheabilityManifestRoute = {
    kind: "app-page",
    pattern: "/page",
    representation: "html",
    requestKey: "/page",
    state: "static-candidate",
    status: 200,
  };
  const key = cacheabilityManifestRouteKey(
    route.kind,
    route.pattern,
    route.representation,
    route.requestKey,
  );
  return {
    raw: JSON.stringify({ buildId: "build-a", routes: { [key]: route }, version: 1 }),
    route,
  };
}

function staticPagesManifestRoute(): { raw: string; route: CacheabilityManifestRoute } {
  const route: CacheabilityManifestRoute = {
    kind: "pages-page",
    pattern: "/pages-route",
    representation: "html",
    requestKey: "/pages-route",
    state: "static-candidate",
    status: 200,
  };
  const key = cacheabilityManifestRouteKey(
    route.kind,
    route.pattern,
    route.representation,
    route.requestKey,
  );
  return {
    raw: JSON.stringify({ buildId: "build-a", routes: { [key]: route }, version: 1 }),
    route,
  };
}

function staticAppRouteManifest(): { raw: string; route: CacheabilityManifestRoute } {
  const route: CacheabilityManifestRoute = {
    kind: "app-route",
    pattern: "/api/data",
    representation: "app-route",
    requestKey: "/api/data",
    state: "static-candidate",
    status: 200,
  };
  const key = cacheabilityManifestRouteKey(
    route.kind,
    route.pattern,
    route.representation,
    route.requestKey,
  );
  return {
    raw: JSON.stringify({ buildId: "build-a", routes: { [key]: route }, version: 1 }),
    route,
  };
}

describe("single-request cacheability admission", () => {
  const request = new Request("https://example.com/page", {
    headers: { Accept: "text/html" },
  });

  it("admits a completed static response without a build manifest", async () => {
    const base = { waitUntil() {} };
    const context = createWorkerCacheabilityAdmissionContext(base, request, null, "build-a", true);
    expect(context).not.toBe(base);
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.outcome = {
      cacheable: true,
      cacheControl: "s-maxage=60, stale-while-revalidate=540",
    };
    state.frameworkResponseCachePolicy = { "cache-control": "no-store" };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("static", { headers: { "Cache-Control": "no-store" } }),
      context,
    );
    expect(response.headers.get("Cache-Control")).toBe("s-maxage=60, stale-while-revalidate=540");
    await expect(response.text()).resolves.toBe("static");
  });

  it("honors a final public App Page cache policy", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/custom-cache-control/custom-cache-control.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/custom-cache-control/custom-cache-control.test.ts
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      null,
      "build-a",
      true,
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.outcome = {
      cacheable: true,
      cacheControl: "s-maxage=120, stale-while-revalidate=31535880",
    };
    state.frameworkResponseCachePolicy = { "cache-control": "no-store" };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("static", { headers: { "Cache-Control": "s-maxage=30" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toBe("s-maxage=30");
    await expect(response.text()).resolves.toBe("static");
  });

  it("keeps a completed dynamic response private without a build manifest", async () => {
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      null,
      "build-a",
      true,
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.outcome = { cacheable: false, dynamicUsage: true };

    const response = await finalizeWorkerCacheabilityResponse(new Response("dynamic"), context);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("dynamic");
  });

  it("honors a final public config policy for a completed dynamic App Page", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/custom-cache-control/custom-cache-control.test.ts
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      null,
      "build-a",
      true,
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.frameworkResponseCachePolicy = { "cache-control": "no-store" };
    state.completion = Promise.resolve({ cacheable: false, dynamicUsage: true });

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("dynamic", { headers: { "Cache-Control": "s-maxage=32" } }),
      context,
    );
    expect(response.headers.get("Cache-Control")).toBe("s-maxage=32");
    await expect(response.text()).resolves.toBe("dynamic");
  });

  it("probes a dynamic App Page with a final public config policy as cacheable", async () => {
    const context = createWorkerCacheabilityContext(
      { waitUntil() {} },
      new Request("https://example.com/page", {
        headers: {
          "X-Vinext-Cacheability-Probe": "1",
          "X-Vinext-Prerender-Secret": "probe-secret",
        },
      }),
      "probe-secret",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.frameworkResponseCachePolicy = { "cache-control": "no-store" };
    state.completion = Promise.resolve({ cacheable: false, dynamicUsage: true });

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("dynamic", { headers: { "Cache-Control": "s-maxage=32" } }),
      context,
    );
    await expect(response.json()).resolves.toMatchObject({
      cacheControl: "s-maxage=32",
      kind: "app-page",
      pattern: "/page",
      state: "static-candidate",
      status: 200,
    });
  });

  it.each([undefined, "*/*", "application/json"])(
    "creates fail-closed request state without an HTML Accept header (%s)",
    (accept) => {
      const base = { waitUntil() {} };
      const headers = new Headers();
      if (accept !== undefined) headers.set("Accept", accept);
      const context = createWorkerCacheabilityAdmissionContext(
        base,
        new Request("https://example.com/page", { headers }),
        null,
        "build-a",
        true,
      );

      expect(context).not.toBe(base);
      expect(cacheabilityState(context).admission).toEqual({
        policy: "runtime",
        representation: "app-route",
        requestKey: "/page",
      });
    },
  );

  it("applies a pre-dispatch veto to an otherwise public Route Handler response", async () => {
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/api/data", { headers: { Accept: "*/*" } }),
      null,
      "build-a",
      true,
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-route", pattern: "/api/data" };
    state.forcedDynamicReason = "middleware is eligible for this pathname";

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("private", { headers: { "Cache-Control": "public, s-maxage=60" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("private");
  });

  it("preserves a safely completed Route Handler public policy", async () => {
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/api/data", { headers: { Accept: "*/*" } }),
      null,
      "build-a",
      true,
    );
    cacheabilityState(context).route = { kind: "app-route", pattern: "/api/data" };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("public", { headers: { "Cache-Control": "public, s-maxage=60" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
    await expect(response.text()).resolves.toBe("public");
  });

  it("rejects a late-failing Route Handler made public by final config headers", async () => {
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/api/config-public", { headers: { Accept: "*/*" } }),
      null,
      "build-a",
      true,
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-route", pattern: "/api/config-public" };
    state.explicitConfigCachePolicy = true;

    const response = await finalizeWorkerCacheabilityResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("partial"));
            controller.error(new Error("late failure"));
          },
        }),
        { headers: { "Cache-Control": "public, s-maxage=60" } },
      ),
      context,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
  });

  it.each(["*/*", "text/html"])(
    "admits only an exact manifest-backed Route Handler identity for Accept: %s",
    async (accept) => {
      const { raw } = staticAppRouteManifest();
      const context = createWorkerCacheabilityAdmissionContext(
        { waitUntil() {} },
        new Request("https://example.com/api/data", { headers: { Accept: accept } }),
        raw,
        "build-a",
      );
      cacheabilityState(context).route = { kind: "app-route", pattern: "/api/data" };

      const response = await finalizeWorkerCacheabilityResponse(
        new Response("public", { headers: { "Cache-Control": "public, s-maxage=60" } }),
        context,
      );

      expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
    },
  );

  it("keeps an unlisted Route Handler query identity private", async () => {
    const { raw } = staticAppRouteManifest();
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/api/data?user=one"),
      raw,
      "build-a",
    );
    cacheabilityState(context).route = { kind: "app-route", pattern: "/api/data" };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("private", { headers: { "Cache-Control": "public, s-maxage=60" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("preserves an independently classified hybrid Pages response", async () => {
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      null,
      "build-a",
      true,
    );
    cacheabilityState(context).preserveResponseCachePolicy = true;

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("pages", { headers: { "Cache-Control": "public, s-maxage=300" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=300");
    await expect(response.text()).resolves.toBe("pages");
  });

  it("keeps responses with unsupported Vary fields private", async () => {
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      null,
      "build-a",
      true,
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.outcome = {
      cacheable: true,
      cacheControl: "s-maxage=60, stale-while-revalidate=540",
    };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("contextual", { headers: { Vary: "RSC, Cookie" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("contextual");
  });

  it("serves an intentionally private certified response without treating it as static-to-dynamic", async () => {
    // Next.js bypasses the Full Route Cache in draft mode. The HTML renderer
    // intentionally returns no-store without opening a cache-write completion,
    // so an absent outcome is not evidence that a dynamic API was used.
    // Ported from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-static/app-static.test.ts
    const { raw } = staticManifestRoute();
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      raw,
      "build-a",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("draft", { headers: { "Cache-Control": "no-store" } }),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("draft");
  });

  it("still rejects an observed static-to-dynamic transition", async () => {
    const { raw } = staticManifestRoute();
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      raw,
      "build-a",
    );
    const state = cacheabilityState(context);
    const captureBudget = createCacheabilityAdmissionCaptureBudget(7);
    state.captureBudget = captureBudget;
    state.route = { kind: "app-page", pattern: "/page" };
    state.outcome = { cacheable: false, dynamicUsage: true };

    const response = await finalizeWorkerCacheabilityResponse(new Response("dynamic"), context);
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(captureBudget.reservedBytes).toBe(0);
    await expect(response.text()).resolves.toContain("changed from static to dynamic");
  });

  const lateFinalPolicyCases: Array<{
    finalHeaders: Record<string, string>;
    initialPolicy: NonNullable<RouteCacheabilityState["frameworkResponseCachePolicy"]>;
    name: string;
  }> = [
    {
      finalHeaders: { "Set-Cookie": "session=private; Path=/; HttpOnly" },
      initialPolicy: {},
      name: "Set-Cookie",
    },
    {
      finalHeaders: { "Cache-Control": "private, no-store" },
      initialPolicy: { "cache-control": "public, s-maxage=60" },
      name: "Cache-Control",
    },
    {
      finalHeaders: { "CDN-Cache-Control": "private, no-store" },
      initialPolicy: { "cdn-cache-control": "public, s-maxage=60" },
      name: "CDN-Cache-Control",
    },
    {
      finalHeaders: { "Cloudflare-CDN-Cache-Control": "private, no-store" },
      initialPolicy: { "cloudflare-cdn-cache-control": "public, s-maxage=60" },
      name: "Cloudflare-CDN-Cache-Control",
    },
  ];

  it.each(lateFinalPolicyCases)(
    "keeps a manifest-backed response private after late $name",
    async (testCase) => {
      const { raw } = staticManifestRoute();
      const context = createWorkerCacheabilityAdmissionContext(
        { waitUntil() {} },
        request,
        raw,
        "build-a",
      );
      const state = cacheabilityState(context);
      state.route = { kind: "app-page", pattern: "/page" };
      state.frameworkResponseCachePolicy = testCase.initialPolicy;
      state.outcome = {
        cacheable: true,
        cacheControl: "s-maxage=60, stale-while-revalidate=540",
      };

      const response = await finalizeWorkerCacheabilityResponse(
        new Response("late private response", { headers: testCase.finalHeaders }),
        context,
      );

      expect(state.finalResponseVetoReason).toBeUndefined();
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      await expect(response.text()).resolves.toBe("late private response");
    },
  );

  it("does not add admission overhead for adapters that persist completed artifacts", () => {
    const base = { waitUntil() {} };
    expect(createWorkerCacheabilityAdmissionContext(base, request, null, "build-a", false)).toBe(
      base,
    );
  });

  it("fails closed for request identities absent from the embedded manifest", async () => {
    const base = { waitUntil() {} };
    const request = new Request("https://example.com/pages-route");
    const context = createWorkerCacheabilityAdmissionContext(
      base,
      request,
      JSON.stringify({ buildId: "build-a", routes: {}, version: 1 }),
      "build-a",
    );

    expect(context).not.toBe(base);
    const response = await finalizeWorkerCacheabilityResponse(
      new Response("pages", {
        headers: { "Cache-Control": "public, max-age=0, must-revalidate" },
      }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("pages");
  });

  it("honors an explicit public Pages SSR policy over the default dynamic classification", async () => {
    // Ported from Next.js:
    // test/e2e/getserversideprops/test/index.test.ts
    const pagesRequest = new Request("https://example.com/pages-route", {
      headers: { Accept: "text/html" },
    });
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      pagesRequest,
      null,
      "build-a",
      true,
    );
    const state = cacheabilityState(context);
    state.route = { kind: "pages-page", pattern: "/pages-route" };
    state.outcome = { cacheable: false, dynamicUsage: true };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("gssp", { headers: { "Cache-Control": "public, s-maxage=36" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=36");
    await expect(response.text()).resolves.toBe("gssp");
  });

  it("keeps manifest-backed Pages responses with a late Set-Cookie private", async () => {
    const { raw } = staticPagesManifestRoute();
    const pagesRequest = new Request("https://example.com/pages-route", {
      headers: { Accept: "text/html" },
    });
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      pagesRequest,
      raw,
      "build-a",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "pages-page", pattern: "/pages-route" };
    state.outcome = {
      cacheable: true,
      cacheControl: "public, s-maxage=60, stale-while-revalidate=540",
    };
    const setCookie = "__prerender_bypass=; Max-Age=0; Path=/";

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("pages", { headers: { "Set-Cookie": setCookie } }),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBe(setCookie);
    await expect(response.text()).resolves.toBe("pages");
  });
});

describe("cacheability probe finalization", () => {
  function contextWith(state: RouteCacheabilityState) {
    return {
      [CACHEABILITY_REQUEST_STATE]: state,
      waitUntil() {},
    };
  }

  it("does not let ordinary dynamic usage hide a route 500", async () => {
    const state: RouteCacheabilityState = {
      captureDeadlineAt: Date.now() + 1_000,
      mode: "probe",
      outcome: { cacheable: false, dynamicUsage: true },
      route: { kind: "app-page", pattern: "/broken" },
    };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("broken", { status: 500 }),
      contextWith(state),
    );

    await expect(response.json()).resolves.toMatchObject({
      reason: "route returned HTTP 500",
      state: "probe-failed",
      status: 500,
    });
  });

  it("recognizes only the dedicated private-cache suspension bailout", async () => {
    const outcome = {
      cacheable: false,
      dynamicUsage: true,
      reason: '"use cache: private" requires request-time execution',
    };
    const state: RouteCacheabilityState = {
      captureDeadlineAt: Date.now() + 1_000,
      mode: "probe",
      outcome,
      probeBailout: { kind: "private-cache", outcome },
      route: { kind: "app-page", pattern: "/private" },
    };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("discarded render", { status: 500 }),
      contextWith(state),
    );

    await expect(response.json()).resolves.toMatchObject({
      reason: outcome.reason,
      state: "dynamic",
      status: 500,
    });
  });

  it("preserves build identity on Route Handler probe envelopes", async () => {
    const previousBuildId = process.env.__VINEXT_BUILD_ID;
    process.env.__VINEXT_BUILD_ID = "build-a";
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    try {
      const state: RouteCacheabilityState = {
        captureDeadlineAt: Date.now() + 1_000,
        mode: "probe",
        route: { kind: "app-route", pattern: "/api/data" },
      };

      const response = await finalizeWorkerCacheabilityResponse(
        new Response("static", { headers: { "Cache-Control": "public, s-maxage=60" } }),
        contextWith(state),
      );

      expect(response.headers.get("X-Vinext-Build-Id")).toBe("build-a");
      await expect(response.json()).resolves.toMatchObject({
        kind: "app-route",
        state: "static-candidate",
      });
    } finally {
      setCdnCacheAdapter(new DefaultCdnCacheAdapter());
      if (previousBuildId === undefined) delete process.env.__VINEXT_BUILD_ID;
      else process.env.__VINEXT_BUILD_ID = previousBuildId;
    }
  });
});
